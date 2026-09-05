import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type pg from 'pg';
import type { ImportExpectedBase } from '@noveldesk/contracts';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { integrityHash } from '@noveldesk/text-core/hash';
import type { ServerConfig } from '../../config.js';
import { migrateDatabase } from '../../db/migrate.js';
import { processImportJob } from '../import-service.js';
import { createStructuredLogger } from '../../observability/logger.js';

// A real loopback HTTP transport for the production S3 SDK, not a MinIO performance model.
export async function withImportPageFixture<T>(pool: pg.Pool, run: (fixture: ImportPageFixture) => Promise<T>) {
  await migrateDatabase(pool);
  await pool.query("insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')");
  const directory = await mkdtemp(path.join(tmpdir(), 'moya-page-import-'));
  const objects = new Map<string, { bytes: Buffer; type: string }>();
  const puts: Array<{ key: string; bytes: number }> = [];
  const heads: string[] = [];
  const gets: Array<{ key: string; bytes: number }> = [];
  const profiles: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger({
    service: 'worker',
    sink: { write: (line) => profiles.push(JSON.parse(line) as Record<string, unknown>) },
  });
  const server = createServer((request, response) => {
    void (async () => {
      const key = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname).replace(/^\/test\/?/, '');
      if (!key) {
        response.writeHead(200).end();
        return;
      }
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        objects.set(key, { bytes, type: String(request.headers['content-type']) });
        puts.push({ key, bytes: bytes.length });
        await fixture.onPut?.(key);
        response.writeHead(200, { ETag: '"fixture"' }).end();
        return;
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'HEAD') heads.push(key);
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Length': object.bytes.length, 'Content-Type': object.type });
      if (request.method === 'HEAD') response.end();
      else {
        gets.push({ key, bytes: object.bytes.length });
        response.end(object.bytes);
      }
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: '',
    redisUrl: '',
    dataDir: directory,
    maxChunkBytes: 1024 * 1024,
    maxUploadBytes: 1024 ** 3,
    staleUploadMaxAgeMs: 86_400_000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: `http://127.0.0.1:${address.port}`,
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'fixture',
      secretAccessKey: 'fixture',
      forcePathStyle: true,
    },
  };
  const fixture: ImportPageFixture = {
    config,
    objects,
    puts,
    heads,
    gets,
    profiles,
    useExecutionLease: false,
    async import(bytes: Buffer, append = false, bookId = 'book_fixture', options = {}) {
      const uploadId = `upload_${randomUUID()}`;
      const jobId = `job_${randomUUID()}`;
      const executionId = fixture.useExecutionLease ? `execution_${randomUUID()}` : undefined;
      const uploadDir = path.join(directory, 'uploads', uploadId);
      await mkdir(uploadDir, { recursive: true });
      const chunkPath = path.join(uploadDir, '0.part');
      await writeFile(chunkPath, bytes);
      const base = append
        ? (await pool.query('select active_content_revision_id from library_books where id = $1', [bookId])).rows[0]
            ?.active_content_revision_id
        : undefined;
      await pool.query(
        `insert into upload_sessions (id, user_id, file_name, content_type, size_bytes, encoding, total_chunks, status, client_book_id, source_content_hash, import_mode, base_active_content_revision_id, expected_base)
        values ($1, 'user_test', $7, $8, $2, 'utf-8', 1, 'queued', $3, $4, $5, $6, $9)`,
        [
          uploadId,
          bytes.length,
          bookId,
          integrityHash(bytes),
          append ? 'append_image_series' : 'replace_book',
          base ?? null,
          options.fileName ?? 'fixture.cbz',
          options.contentType ?? 'application/vnd.comicbook+zip',
          options.expectedBase ? JSON.stringify(options.expectedBase) : null,
        ],
      );
      await pool.query(
        'insert into upload_chunks (upload_id, chunk_index, size_bytes, storage_path) values ($1, 0, $2, $3)',
        [uploadId, bytes.length, chunkPath],
      );
      await pool.query(
        `insert into import_jobs (id, user_id, upload_id, status, stage, total_bytes, active_queue_job_id) values ($1, 'user_test', $2, 'queued', 'queued', $3, $4)`,
        [jobId, uploadId, bytes.length, executionId ?? null],
      );
      const started = performance.now();
      await processImportJob(
        pool,
        config,
        jobId,
        uploadId,
        { attemptNumber: 1, maxAttempts: 1, finalAttempt: true, executionId },
        logger,
      );
      return { jobId, uploadId, durationMs: performance.now() - started };
    },
  };
  try {
    return await run(fixture);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

export interface ImportPageFixture {
  config: ServerConfig;
  objects: Map<string, { bytes: Buffer; type: string }>;
  puts: Array<{ key: string; bytes: number }>;
  heads: string[];
  gets: Array<{ key: string; bytes: number }>;
  profiles: Array<Record<string, unknown>>;
  useExecutionLease: boolean;
  onPut?: (key: string) => Promise<void>;
  import(
    bytes: Buffer,
    append?: boolean,
    bookId?: string,
    options?: { expectedBase?: ImportExpectedBase; fileName?: string; contentType?: string },
  ): Promise<{ jobId: string; uploadId: string; durationMs: number }>;
}

export function fixturePng(seed: number, side = 8): Buffer {
  const raw = Buffer.alloc((side * 4 + 1) * side);
  let value = seed;
  for (let row = 0; row < side; row++) {
    for (let col = 1; col <= side * 4; col++) {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      raw[row * (side * 4 + 1) + col] = value >>> 24;
    }
  }
  const chunk = (type: string, bytes: Buffer) => {
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length);
    result.write(type, 4);
    bytes.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function fixtureSeries(
  chapters: Array<{ number: number; pages: Buffer[]; previousHash?: string }>,
  bookId?: string,
) {
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), { level: 0, useWebWorkers: false });
  const manifestChapters = [];
  for (const chapter of chapters) {
    const entryNames = chapter.pages.map((_, i) => `chapters/${chapter.number}/${String(i + 1).padStart(5, '0')}.png`);
    for (const [i, bytes] of chapter.pages.entries()) await writer.add(entryNames[i]!, new Uint8ArrayReader(bytes));
    manifestChapters.push({
      remoteId: `chapter:${chapter.number}`,
      title: `${chapter.number}화`,
      chapterNumber: chapter.number,
      sourceOrder: chapter.number,
      sourceContentHash: integrityHash(Buffer.concat(chapter.pages)),
      expectedPreviousSourceContentHash: chapter.previousHash,
      pageCount: chapter.pages.length,
      entryNames,
    });
  }
  await writer.add(
    'moya-series.json',
    new TextReader(
      JSON.stringify({
        schemaVersion: 1,
        targetBookId: bookId,
        collection: { remoteId: 'manga:fixture', title: 'Fixture series' },
        chapters: manifestChapters,
      }),
    ),
  );
  return Buffer.from(await (await writer.close()).arrayBuffer());
}
