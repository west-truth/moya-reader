import Fastify from 'fastify';
import { expect } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { registerAIRoutes } from '../ai.js';
import { characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { textIntegrityHash } from '@noveldesk/text-core/hash';

export function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

interface ProviderAdmissionFixture {
  readonly limit: 'active_attempts' | 'attempts_per_minute' | 'attempts_per_utc_day';
  readonly retryAfterSeconds?: number;
}

export function providerAttemptAwarePool(pool: pg.Pool, rejection?: ProviderAdmissionFixture): pg.Pool {
  const currentAttemptByJob = new Map<string, string>();
  const inputRevisionByJob = new Map<string, Record<string, unknown>>();
  let inTransaction = false;
  const originalQuery = pool.query.bind(pool);
  const query = async (sql: string, params?: unknown[]) => {
    const transactionCommand = sql.trim().toLowerCase();
    if (transactionCommand === 'begin') {
      inTransaction = true;
      return { rowCount: null, rows: [] };
    }
    if (transactionCommand === 'commit' || transactionCommand === 'rollback') {
      inTransaction = false;
      return { rowCount: null, rows: [] };
    }
    if (inTransaction && sql.includes('join book_content_revisions content') && sql.includes('for update of book')) {
      const bookId = String(params?.[0]);
      const graph = { novelId: bookId, characters: [], relations: [] };
      return {
        rows: [
          {
            id: bookId,
            user_id: String(params?.[1]),
            object_id: 'object_1',
            normalized_text_hash: 'book_hash',
            content_revision_number: 1,
            revision_fence: 1,
            active_content_revision_id: 'content_revision_1',
            active_character_graph_revision_id: 'graph_revision_1',
            source_raw_text_hash: 'raw_hash_1',
            graph_revision_number: 1,
            graph_fingerprint: characterGraphIntegrityHash(graph),
            graph_snapshot: graph,
          },
        ],
      };
    }
    if (inTransaction && sql.trim().startsWith('select pg_advisory_xact_lock')) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (
      inTransaction &&
      sql.includes('from book_ai_workflows') &&
      sql.includes("status = 'running'") &&
      sql.includes('content_revision_id = $5')
    ) {
      const result = await originalQuery(`${sql}\nfor update`, params);
      return {
        ...result,
        rows: result.rows.map((row: Record<string, unknown>) => ({
          ...row,
          content_revision_id: 'content_revision_1',
          base_graph_revision_id: 'graph_revision_1',
          revision_fence: 1,
        })),
      };
    }
    if (inTransaction && sql.includes('insert into book_ai_workflows')) {
      const legacyParams = [...(params ?? []).slice(0, 7), params?.[10]];
      const result = await originalQuery(sql, legacyParams);
      return {
        ...result,
        rows: result.rows.map((row: Record<string, unknown>) => ({
          ...row,
          content_revision_id: params?.[7],
          base_graph_revision_id: params?.[8],
          revision_fence: params?.[9],
        })),
      };
    }
    if (
      inTransaction &&
      sql.includes("set analysis_status = 'building_graph'") &&
      sql.includes('active_content_revision_id')
    ) {
      return originalQuery(
        'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
        ['building_graph', params?.[0], params?.[1]],
      );
    }
    if (inTransaction && sql.includes('from user_corrections') && sql.includes('order by created_at desc'))
      return { rows: [] };
    if (inTransaction && sql.includes('from chapters c') && sql.includes('c.id = any($3::text[])')) {
      const chapterIds = Array.isArray(params?.[2]) ? params[2].map(String) : [];
      return {
        rows: chapterIds.map((chapterId) => {
          const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
          return {
            id: chapterId,
            book_id: String(params?.[0]),
            chapter_index: chapterIndex,
            title: `Chapter ${chapterIndex}`,
            text_hash: `chapter_hash_${chapterIndex}`,
            raw_start_offset: 0,
            raw_end_offset: 10000,
            character_count: 10000,
            paragraph_count: 2,
            created_at: '2026-07-10T00:00:00.000Z',
            updated_at: '2026-07-10T00:00:00.000Z',
          };
        }),
      };
    }
    if (
      inTransaction &&
      sql.includes('select id, text_hash, updated_at, paragraph_count, character_count') &&
      sql.includes('from chapters')
    ) {
      const chapterIds = Array.isArray(params?.[1]) ? params[1].map(String) : [];
      return {
        rows: chapterIds.map((chapterId) => {
          const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
          return {
            id: chapterId,
            text_hash: `chapter_hash_${chapterIndex}`,
            updated_at: '2026-07-10T00:00:00.000Z',
            paragraph_count: 2,
            character_count: 10000,
          };
        }),
      };
    }
    if (inTransaction && sql.includes('from paragraph_search') && sql.includes('where chapter_id = $1')) {
      const chapterId = String(params?.[0]);
      const requestedIds = Array.isArray(params?.[1]) ? params[1].map(String) : ['p1', 'p2'];
      return {
        rows: requestedIds.map((paragraphId, index) => {
          const paragraphText = `Paragraph ${paragraphId}`;
          return {
            paragraph_id: paragraphId,
            book_id: 'book_1',
            chapter_id: chapterId,
            paragraph_index: index,
            text: paragraphText,
            paragraph: {
              id: paragraphId,
              novelId: 'book_1',
              chapterId,
              index,
              text: paragraphText,
              startOffsetInChapter: 0,
              endOffsetInChapter: paragraphText.length,
              textHash: textIntegrityHash(paragraphText),
            },
          };
        }),
      };
    }
    if (inTransaction && sql.includes('insert into provider_capability_snapshots')) {
      return { rowCount: 1, rows: [] };
    }
    if (inTransaction && sql.includes('insert into analysis_input_revisions')) {
      const row = {
        id: params?.[0],
        provider_job_id: params?.[1],
        workflow_id: params?.[2],
        user_id: params?.[3],
        book_id: params?.[4],
        chapter_id: params?.[5],
        job_type: params?.[6],
        content_revision_id: params?.[7],
        content_revision_number: params?.[8],
        revision_fence: params?.[9],
        source_object_id: params?.[10],
        source_raw_text_hash: params?.[11],
        normalized_text_hash: params?.[12],
        character_graph_revision_id: params?.[13],
        character_graph_fingerprint: params?.[14],
        correction_fingerprint: params?.[15],
        request_profile_id: params?.[16],
        prompt_version: params?.[17],
        schema_version: params?.[18],
        provider_id: params?.[19],
        model_id: params?.[20],
        provider_options_fingerprint: params?.[21],
        provider_options: JSON.parse(String(params?.[22])),
        window_spec: JSON.parse(String(params?.[23])),
        source_snapshot: JSON.parse(String(params?.[24])),
        graph_snapshot: JSON.parse(String(params?.[25])),
        corrections_snapshot: JSON.parse(String(params?.[26])),
        episode_context_snapshot: params?.[27] ? JSON.parse(String(params[27])) : null,
        render_spec: params?.[28] ? JSON.parse(String(params[28])) : null,
        render_spec_hash: params?.[29],
        voice_profile_snapshot: params?.[30] ? JSON.parse(String(params[30])) : null,
        capability_snapshot_id: params?.[31],
        capability_snapshot: params?.[32] ? JSON.parse(String(params[32])) : null,
        task_profile_snapshot: params?.[33] ? JSON.parse(String(params[33])) : null,
        admission_snapshot: params?.[34] ? JSON.parse(String(params[34])) : null,
        input_hash: params?.[35],
        created_at: '2026-07-10T00:00:00.000Z',
      };
      inputRevisionByJob.set(String(params?.[1]), row);
      return { rowCount: 1, rows: [row] };
    }
    if (inTransaction && sql.includes('from analysis_input_revisions where provider_job_id = $1')) {
      return { rows: [inputRevisionByJob.get(String(params?.[0]))].filter(Boolean) };
    }
    if (inTransaction && sql.includes('set analysis_input_revision_id = $2')) return { rowCount: 1, rows: [] };
    if (inTransaction && sql.includes('select id as provider_job_id') && sql.includes('input_hash = $6')) {
      return originalQuery(sql.replace('input_hash = $6', 'input_hash = $5'), [
        params?.[0],
        params?.[1],
        params?.[2],
        params?.[3],
        params?.[4],
        params?.[6],
      ]);
    }
    if (
      inTransaction &&
      sql.includes('insert into provider_jobs') &&
      sql.includes('on conflict do nothing') &&
      sql.includes('values ($1, $2, $3, $4, $5, $6')
    ) {
      return originalQuery(sql, [
        params?.[0],
        params?.[1],
        params?.[2],
        params?.[5],
        params?.[6],
        params?.[7],
        params?.[8],
      ]);
    }
    if (inTransaction && sql.includes('insert into book_ai_workflow_jobs')) {
      return originalQuery(sql, [params?.[0], params?.[1], params?.[2], params?.[4], params?.[5]]);
    }
    if (inTransaction && sql.includes('update book_ai_workflows') && sql.includes('coalesce($3, status)')) {
      return originalQuery(sql, [params?.[0], params?.[1], params?.[4]]);
    }
    if (sql.includes('with target as materialized')) {
      if (rejection) {
        return {
          rowCount: 1,
          rows: [
            {
              outcome: 'rejected',
              attempt_id: null,
              bullmq_job_id: null,
              reused: false,
              limit_kind: rejection.limit,
              retry_after_seconds: rejection.retryAfterSeconds ?? null,
            },
          ],
        };
      }
      const jobId = String(params?.[0]);
      const attemptId = String(params?.[1]);
      const bullmqJobId = String(params?.[2]);
      currentAttemptByJob.set(jobId, attemptId);
      return { rowCount: 1, rows: [{ attempt_id: attemptId, bullmq_job_id: bullmqJobId }] };
    }
    if (sql.trim().startsWith('insert into provider_job_outbox') || sql.includes('update provider_job_outbox')) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('select attempt.bullmq_job_id') && sql.includes('from provider_job_attempts attempt')) {
      const attemptId = String(params?.[2]);
      return { rowCount: 1, rows: [{ bullmq_job_id: attemptId }] };
    }

    const result = await originalQuery(sql, params);
    if (
      sql.includes("set status = 'queued'") &&
      sql.includes('current_attempt_id is not distinct from') &&
      (sql.includes('returning id, status') || /returning id\s*$/.test(sql.trim())) &&
      result.rows.length === 0 &&
      result.rowCount !== 0
    ) {
      return { ...result, rowCount: 1, rows: [{ id: String(params?.[0]), status: 'queued' }] };
    }
    if (!sql.includes('provider_jobs') || !Array.isArray(result.rows)) return result;
    const rows = result.rows.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const row = value as Record<string, unknown>;
      const jobId = typeof row.id === 'string' ? row.id : undefined;
      if (!jobId || typeof row.status !== 'string') return value;
      const attemptId =
        currentAttemptByJob.get(jobId) ??
        (typeof row.current_attempt_id === 'string' ? row.current_attempt_id : `provider_attempt_fixture_${jobId}`);
      currentAttemptByJob.set(jobId, attemptId);
      return { ...row, current_attempt_id: attemptId };
    });
    return { ...result, rows };
  };
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') return query;
      if (property === 'connect') {
        return async () => ({ query, release: () => undefined });
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function expectProviderAttemptEnqueued(queue: Queue, logicalJobId: string, expectedCall = 1): void {
  expect(queue.add).toHaveBeenNthCalledWith(
    expectedCall,
    'provider-job',
    expect.objectContaining({
      jobId: logicalJobId,
      attemptId: expect.stringMatching(/^provider_attempt_[a-f0-9]{32}$/),
    }),
    { jobId: expect.stringMatching(/^provider_attempt_[a-f0-9]{32}$/) },
  );
  const calls = (queue.add as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const data = calls[expectedCall - 1]?.[1] as { attemptId?: string } | undefined;
  const options = calls[expectedCall - 1]?.[2] as { jobId?: string } | undefined;
  expect(data?.attemptId).toBe(options?.jobId);
}

export async function appWithAIRoutes(
  pool: pg.Pool,
  providerQueue?: Queue,
  admissionRejection?: ProviderAdmissionFixture,
) {
  const app = Fastify({ logger: false });
  await registerAIRoutes(
    app,
    providerQueue ? providerAttemptAwarePool(pool, admissionRejection) : pool,
    testConfig(),
    providerQueue,
  );
  return app;
}
