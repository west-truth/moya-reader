import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import pg from 'pg';
import { ServerConfig } from '../config.js';
import { enqueueImportJob } from '../queue.js';
import { pruneStaleUploadSessions, removeUploadDirectory, uploadDirectory } from '../services/upload-cleanup.js';
import type { ChapterSplitMode, ImportExpectedBase } from '@noveldesk/contracts';
import { parseImportExpectedBase } from '../services/import-expected-base.js';
import {
  nonNegativeInteger,
  positiveInteger,
  summarizeUploadProgress,
  validateChunkIndex,
  validateUploadCompleteness,
  validateUploadChunkPlan,
  validateUploadSize,
} from '../services/upload-validation.js';

interface InitUploadBody {
  fileName?: string;
  sizeBytes?: number;
  contentType?: string;
  encoding?: 'auto' | 'utf-8' | 'euc-kr';
  chapterSplitMode?: ChapterSplitMode;
  clientHashHint?: string;
  sourceContentHash?: string;
  clientBookId?: string;
  importMode?: 'replace_book' | 'append_image_series';
  baseActiveContentRevisionId?: string;
  expectedBase?: ImportExpectedBase;
  totalChunks?: number;
}

interface UploadSessionRow {
  id: string;
  file_name?: string;
  size_bytes: string;
  content_type?: string;
  encoding?: string;
  chapter_split_mode?: ChapterSplitMode;
  import_mode?: 'replace_book' | 'append_image_series';
  base_active_content_revision_id?: string | null;
  expected_base?: ImportExpectedBase | null;
  status: string;
  total_chunks: number | null;
  source_content_hash?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface UploadChunkRow {
  chunk_index: number;
  size_bytes: number;
}

interface ImportJobSummaryRow {
  id: string;
  status: string;
  stage: string;
  message?: string | null;
  cancel_requested_at?: string | null;
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'novel.txt';
}

function validClientBookId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9:_-]{1,160}$/.test(trimmed) ? trimmed : undefined;
}

function validImportMode(value: unknown): 'replace_book' | 'append_image_series' | undefined {
  if (value === undefined) return 'replace_book';
  return value === 'replace_book' || value === 'append_image_series' ? value : undefined;
}

function validChapterSplitMode(value: unknown): ChapterSplitMode | undefined {
  if (value === undefined) return 'auto';
  return value === 'auto' || value === 'mixed' || value === 'single' ? value : undefined;
}

function validSourceContentHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

async function uploadProgress(
  poolOrClient: pg.Pool | pg.PoolClient,
  uploadId: string,
): Promise<{
  session?: UploadSessionRow;
  chunks: UploadChunkRow[];
  importJob?: ImportJobSummaryRow;
}> {
  const sessionResult = await poolOrClient.query<UploadSessionRow>(
    `
      select id, file_name, size_bytes, content_type, encoding, chapter_split_mode, status, total_chunks,
             source_content_hash, import_mode, base_active_content_revision_id, expected_base, created_at, updated_at
      from upload_sessions
      where id = $1
    `,
    [uploadId],
  );
  const session = sessionResult.rows[0];
  if (!session) return { chunks: [] };

  const chunksResult = await poolOrClient.query<UploadChunkRow>(
    'select chunk_index, size_bytes from upload_chunks where upload_id = $1 order by chunk_index asc',
    [uploadId],
  );
  const jobResult = await poolOrClient.query<ImportJobSummaryRow>(
    'select id, status, stage, message, cancel_requested_at from import_jobs where upload_id = $1 order by created_at desc limit 1',
    [uploadId],
  );
  return { session, chunks: chunksResult.rows, importJob: jobResult.rows[0] };
}

function uploadStatusPayload(session: UploadSessionRow, chunks: UploadChunkRow[], importJob?: ImportJobSummaryRow) {
  const progress = summarizeUploadProgress({
    expectedBytes: Number(session.size_bytes),
    totalChunks: session.total_chunks,
    chunks: chunks.map((chunk) => ({
      chunkIndex: Number(chunk.chunk_index),
      sizeBytes: Number(chunk.size_bytes),
    })),
  });

  return {
    uploadId: session.id,
    fileName: session.file_name,
    sizeBytes: Number(session.size_bytes),
    contentType: session.content_type,
    encoding: session.encoding,
    chapterSplitMode: session.chapter_split_mode ?? 'auto',
    importMode: session.import_mode ?? 'replace_book',
    baseActiveContentRevisionId: session.base_active_content_revision_id ?? undefined,
    expectedBase: session.expected_base ?? undefined,
    status: session.status,
    totalChunks: session.total_chunks,
    sourceContentHash: session.source_content_hash ?? undefined,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    importJobId: importJob?.id,
    importJobStatus: importJob?.status,
    importJobStage: importJob?.stage,
    importJobMessage: importJob?.message ?? undefined,
    cancelRequested: Boolean(importJob?.cancel_requested_at),
    ...progress,
  };
}

export async function registerUploadRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  importQueue: Queue,
): Promise<void> {
  app.post<{ Body: InitUploadBody }>('/api/uploads/init', async (request, reply) => {
    const body = request.body ?? {};
    const sizeBytes = positiveInteger(body.sizeBytes);
    if (!body.fileName || !sizeBytes) {
      return reply.code(400).send({ error: 'fileName and positive sizeBytes are required' });
    }
    const uploadSizeError = validateUploadSize(sizeBytes, config.maxUploadBytes);
    if (uploadSizeError) {
      return reply.code(413).send({ error: uploadSizeError, maxUploadBytes: config.maxUploadBytes });
    }
    const totalChunks = body.totalChunks === undefined ? undefined : positiveInteger(body.totalChunks);
    if (body.totalChunks !== undefined && !totalChunks) {
      return reply.code(400).send({ error: 'totalChunks must be a positive integer when provided' });
    }
    const chunkPlanError = validateUploadChunkPlan({ sizeBytes, totalChunks, maxChunkBytes: config.maxChunkBytes });
    if (chunkPlanError) return reply.code(400).send({ error: chunkPlanError });
    const clientBookId = validClientBookId(body.clientBookId);
    if (body.clientBookId !== undefined && !clientBookId) {
      return reply.code(400).send({ error: 'clientBookId must be a safe identifier when provided' });
    }
    const chapterSplitMode = validChapterSplitMode(body.chapterSplitMode);
    if (!chapterSplitMode) {
      return reply.code(400).send({ error: 'chapterSplitMode must be auto, mixed, or single when provided' });
    }
    const sourceContentHash = validSourceContentHash(body.sourceContentHash);
    if (body.sourceContentHash !== undefined && !sourceContentHash) {
      return reply.code(400).send({ error: 'sourceContentHash must be a canonical sha256 hash when provided' });
    }
    const importMode = validImportMode(body.importMode);
    if (!importMode) return reply.code(400).send({ error: 'importMode is not supported' });
    let expectedBase: ImportExpectedBase | undefined;
    try {
      expectedBase = parseImportExpectedBase(body.expectedBase);
    } catch {
      return reply.code(400).send({ error: 'invalid_import_expected_base' });
    }
    if (expectedBase && (!clientBookId || importMode !== 'replace_book')) {
      return reply.code(400).send({ error: 'expectedBase requires clientBookId and replace_book' });
    }
    const baseActiveContentRevisionId = validClientBookId(body.baseActiveContentRevisionId);
    if (body.baseActiveContentRevisionId !== undefined && !baseActiveContentRevisionId) {
      return reply.code(400).send({ error: 'baseActiveContentRevisionId must be a safe identifier when provided' });
    }
    if (importMode === 'append_image_series') {
      if (!clientBookId || !sourceContentHash || !baseActiveContentRevisionId) {
        return reply.code(400).send({
          error: 'append_image_series requires clientBookId and sourceContentHash and baseActiveContentRevisionId',
        });
      }
      if (!/\.(?:zip|cbz)$/iu.test(body.fileName)) {
        return reply.code(400).send({ error: 'append_image_series requires a ZIP or CBZ delta archive' });
      }
    }

    const uploadId = `upload_${randomUUID()}`;
    const fileName = sanitizeFileName(body.fileName);
    await mkdir(uploadDirectory(config, uploadId), { recursive: true });
    await pool.query(
      `
        insert into upload_sessions (
          id, user_id, file_name, size_bytes, content_type, encoding, chapter_split_mode, client_hash_hint,
          client_book_id, total_chunks, source_content_hash, import_mode, base_active_content_revision_id, expected_base
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        uploadId,
        config.defaultUserId,
        fileName,
        sizeBytes,
        body.contentType ?? 'text/plain',
        body.encoding ?? 'auto',
        chapterSplitMode,
        body.clientHashHint,
        clientBookId,
        totalChunks,
        sourceContentHash,
        importMode,
        baseActiveContentRevisionId,
        expectedBase ? JSON.stringify(expectedBase) : null,
      ],
    );

    return {
      uploadId,
      chunkUrlTemplate: `/api/uploads/${uploadId}/chunks/{chunkIndex}`,
    };
  });

  app.get<{ Params: { uploadId: string } }>('/api/uploads/:uploadId', async (request, reply) => {
    const { session, chunks, importJob } = await uploadProgress(pool, request.params.uploadId);
    if (!session) return reply.code(404).send({ error: 'upload session not found' });
    return uploadStatusPayload(session, chunks, importJob);
  });

  app.post('/api/uploads/prune', async () => pruneStaleUploadSessions(pool, config, { userId: config.defaultUserId }));

  app.put<{ Params: { uploadId: string; chunkIndex: string }; Body: Buffer }>(
    '/api/uploads/:uploadId/chunks/:chunkIndex',
    async (request, reply) => {
      const chunkIndex = nonNegativeInteger(request.params.chunkIndex);
      if (chunkIndex === undefined) {
        return reply.code(400).send({ error: 'chunkIndex must be a non-negative integer' });
      }
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: 'application/octet-stream body is required' });
      }
      if (request.body.length <= 0) {
        return reply.code(400).send({ error: 'chunk body must not be empty' });
      }

      const client = await pool.connect();
      try {
        await client.query('begin');
        const sessionResult = await client.query<UploadSessionRow>(
          `
            select id, file_name, size_bytes, content_type, encoding, chapter_split_mode, status, total_chunks,
                   source_content_hash, import_mode, base_active_content_revision_id, expected_base, created_at, updated_at
            from upload_sessions
            where id = $1
            for update
          `,
          [request.params.uploadId],
        );
        const session = sessionResult.rows[0];
        if (!session) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'upload session not found' });
        }
        if (session.status !== 'uploading') {
          await client.query('rollback');
          return reply.code(409).send({ error: `upload session is ${session.status}` });
        }
        const chunkIndexError = validateChunkIndex(chunkIndex, session.total_chunks);
        if (chunkIndexError) {
          await client.query('rollback');
          return reply.code(400).send({ error: chunkIndexError });
        }
        const acceptedResult = await client.query<{ accepted_bytes: string }>(
          `select coalesce(sum(size_bytes) filter (where chunk_index <> $2), 0)::text as accepted_bytes
             from upload_chunks where upload_id = $1`,
          [request.params.uploadId, chunkIndex],
        );
        const nextAcceptedBytes = Number(acceptedResult.rows[0]?.accepted_bytes ?? 0) + request.body.length;
        const declaredBytes = Number(session.size_bytes);
        if (nextAcceptedBytes > declaredBytes || nextAcceptedBytes > config.maxUploadBytes) {
          await client.query('rollback');
          return reply.code(413).send({
            error: 'accepted upload bytes would exceed the declared or configured upload size',
            acceptedBytes: nextAcceptedBytes,
            sizeBytes: declaredBytes,
            maxUploadBytes: config.maxUploadBytes,
          });
        }

        const uploadDir = uploadDirectory(config, request.params.uploadId);
        await mkdir(uploadDir, { recursive: true });
        const chunkPath = path.join(uploadDir, `${chunkIndex.toString().padStart(8, '0')}.part`);
        await writeFile(chunkPath, request.body);
        await client.query(
          `
            insert into upload_chunks (upload_id, chunk_index, size_bytes, storage_path)
            values ($1, $2, $3, $4)
            on conflict (upload_id, chunk_index) do update
              set size_bytes = excluded.size_bytes,
                  storage_path = excluded.storage_path,
                  created_at = now()
          `,
          [request.params.uploadId, chunkIndex, request.body.length, chunkPath],
        );
        await client.query('update upload_sessions set updated_at = now() where id = $1', [request.params.uploadId]);
        const progress = await uploadProgress(client, request.params.uploadId);
        await client.query('commit');
        if (!progress.session) return reply.code(404).send({ error: 'upload session not found' });
        return {
          ok: true,
          chunkIndex,
          sizeBytes: request.body.length,
          upload: uploadStatusPayload(progress.session, progress.chunks, progress.importJob),
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { uploadId: string } }>('/api/uploads/:uploadId', async (request, reply) => {
    const client = await pool.connect();
    let cancelled = false;
    try {
      await client.query('begin');
      const sessionResult = await client.query<UploadSessionRow>(
        `select id, file_name, size_bytes, content_type, encoding, chapter_split_mode, status, total_chunks,
                source_content_hash, import_mode, base_active_content_revision_id, expected_base, created_at, updated_at
           from upload_sessions where id = $1 for update`,
        [request.params.uploadId],
      );
      const session = sessionResult.rows[0];
      if (!session) {
        await client.query('rollback');
        return reply.code(404).send({ error: 'upload session not found' });
      }
      if (session.status === 'imported') {
        await client.query('rollback');
        return reply.code(409).send({ error: 'upload session is already imported' });
      }
      if (session.status === 'cancelled') {
        const progress = await uploadProgress(client, request.params.uploadId);
        await client.query('commit');
        cancelled = true;
        if (!progress.session) return reply.code(404).send({ error: 'upload session not found' });
        return {
          ok: true,
          cancellationState: 'cancelled',
          upload: uploadStatusPayload(progress.session, progress.chunks, progress.importJob),
        };
      }

      const processing =
        session.status === 'queued' &&
        (
          await client.query<{ status: string }>(
            'select status from import_jobs where upload_id = $1 order by created_at desc limit 1 for update',
            [request.params.uploadId],
          )
        ).rows[0]?.status === 'processing';
      await client.query(
        `update import_jobs
            set status = 'cancelled', stage = 'cancelled', cancel_requested_at = now(),
                active_queue_job_id = null, message = '서버 가져오기가 취소되었습니다.', updated_at = now()
          where upload_id = $1 and status in ('queued', 'processing')`,
        [request.params.uploadId],
      );
      await client.query('update upload_sessions set status = $1, updated_at = now() where id = $2', [
        'cancelled',
        request.params.uploadId,
      ]);
      if (!processing) await client.query('delete from upload_chunks where upload_id = $1', [request.params.uploadId]);
      const progress = await uploadProgress(client, request.params.uploadId);
      await client.query('commit');
      cancelled = true;
      if (!processing) await removeUploadDirectory(config, request.params.uploadId);
      if (!progress.session) return reply.code(404).send({ error: 'upload session not found' });
      return {
        ok: true,
        cancellationState: processing ? 'requested' : 'cancelled',
        upload: uploadStatusPayload(progress.session, progress.chunks, progress.importJob),
      };
    } catch (error) {
      if (!cancelled) await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { uploadId: string } }>('/api/uploads/:uploadId/complete', async (request, reply) => {
    const client = await pool.connect();
    const jobId = `job_${randomUUID()}`;
    try {
      await client.query('begin');
      const sessionResult = await client.query<UploadSessionRow>(
        `select id, size_bytes, status, total_chunks, source_content_hash
           from upload_sessions where id = $1 for update`,
        [request.params.uploadId],
      );
      const session = sessionResult.rows[0];
      if (!session) {
        await client.query('rollback');
        return reply.code(404).send({ error: 'upload session not found' });
      }
      if (session.status !== 'uploading') {
        const existingJob = await client.query<{ id: string; status: string }>(
          'select id, status from import_jobs where upload_id = $1 order by created_at desc limit 1',
          [request.params.uploadId],
        );
        if (existingJob.rows[0] && ['queued', 'processing', 'done'].includes(existingJob.rows[0].status)) {
          const completedJobId = existingJob.rows[0].id;
          await client.query('commit');
          if (existingJob.rows[0].status === 'queued') {
            await enqueueImportJob(pool, importQueue, completedJobId, request.params.uploadId);
          }
          return reply.code(existingJob.rows[0].status === 'done' ? 200 : 202).send({
            jobId: completedJobId,
            statusUrl: `/api/import-jobs/${completedJobId}`,
            idempotent: true,
          });
        }
        await client.query('rollback');
        return reply.code(409).send({ error: `upload session is ${session.status}` });
      }

      const chunks = await client.query<UploadChunkRow>(
        'select chunk_index, size_bytes from upload_chunks where upload_id = $1 order by chunk_index asc',
        [request.params.uploadId],
      );
      const validation = validateUploadCompleteness({
        expectedBytes: Number(session.size_bytes),
        totalChunks: session.total_chunks,
        chunks: chunks.rows.map((chunk) => ({
          chunkIndex: Number(chunk.chunk_index),
          sizeBytes: Number(chunk.size_bytes),
        })),
      });
      if (!validation.ok) {
        await client.query('rollback');
        return reply.code(400).send({
          error: validation.error,
          expectedChunks: validation.expectedChunks,
          uploadedBytes: validation.uploadedBytes,
          missingChunkIndexes: validation.missingChunkIndexes,
          missingChunkIndexesTruncated: validation.missingChunkIndexesTruncated,
        });
      }

      if (session.source_content_hash) {
        const hash = createHash('sha256');
        const storedChunks = await client.query<UploadChunkRow & { storage_path: string }>(
          'select chunk_index, size_bytes, storage_path from upload_chunks where upload_id = $1 order by chunk_index asc',
          [request.params.uploadId],
        );
        for (const chunk of storedChunks.rows) {
          const bytes = await readFile(chunk.storage_path);
          if (bytes.length !== Number(chunk.size_bytes)) {
            await client.query('rollback');
            return reply
              .code(409)
              .send({ code: 'upload_chunk_size_mismatch', error: 'stored upload chunk size changed' });
          }
          hash.update(bytes);
        }
        const actualSourceContentHash = `sha256:${hash.digest('hex')}`;
        if (actualSourceContentHash !== session.source_content_hash) {
          await client.query('rollback');
          return reply.code(409).send({
            code: 'source_content_hash_mismatch',
            error: 'uploaded bytes do not match sourceContentHash',
            expectedSourceContentHash: session.source_content_hash,
            actualSourceContentHash,
          });
        }
      }

      await client.query('update upload_sessions set status = $1, updated_at = now() where id = $2', [
        'queued',
        request.params.uploadId,
      ]);
      await client.query(
        `
          insert into import_jobs (
            id, user_id, upload_id, status, stage, bytes_read, total_bytes,
            chapters_detected, paragraphs_written, message
          )
          values ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8)
        `,
        [
          jobId,
          config.defaultUserId,
          request.params.uploadId,
          'queued',
          'queued',
          validation.uploadedBytes,
          Number(session.size_bytes),
          '서버 가져오기를 대기 중입니다.',
        ],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await enqueueImportJob(pool, importQueue, jobId, request.params.uploadId);

    return reply.code(202).send({
      jobId,
      statusUrl: `/api/import-jobs/${jobId}`,
    });
  });

  app.get<{ Params: { jobId: string } }>('/api/import-jobs/:jobId', async (request, reply) => {
    const result = await pool.query(
      `
        select
          id, upload_id, status, stage, bytes_read, total_bytes, chapters_detected,
          paragraphs_written, message, book_id, error_message, cancel_requested_at,
          queue_generation, active_queue_job_id, created_at, updated_at
        from import_jobs
        where id = $1
      `,
      [request.params.jobId],
    );
    const job = result.rows[0];
    if (!job) return reply.code(404).send({ error: 'import job not found' });
    if (job.status === 'queued' && job.upload_id) {
      try {
        await enqueueImportJob(pool, importQueue, job.id, job.upload_id);
      } catch (error) {
        request.log.warn(
          { err: error, jobId: job.id, uploadId: job.upload_id },
          'Failed to requeue pending import job during status poll',
        );
      }
    }
    return job;
  });
}
