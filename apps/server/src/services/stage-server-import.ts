import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { uploadDirectory, removeUploadDirectory } from './upload-cleanup.js';
import type { HostedImageAssembly, PreparedServerImport } from '../../../../src/services/import/hosted-image-import.js';
import type { ImportFileInput } from '../../../../src/services/import/import-service.js';

export type ServerImportInput = Pick<
  ImportFileInput,
  'clientBookId' | 'importMode' | 'baseActiveContentRevisionId' | 'expectedBase' | 'encoding' | 'chapterSplitMode'
>;

/** Stages trusted server bytes in the same durable upload/worker path used by local files. */
export async function stageServerImport(
  pool: pg.Pool,
  config: ServerConfig,
  file: File,
  input: ServerImportInput | HostedImageAssembly,
  signal: AbortSignal,
): Promise<PreparedServerImport> {
  if (!file.size || file.size > config.maxUploadBytes) throw new Error('source_body_limit');
  const uploadId = `upload_${randomUUID()}`;
  const dir = uploadDirectory(config, uploadId);
  const chunkBytes = Math.min(config.maxChunkBytes, 2 * 1024 * 1024);
  const count = Math.ceil(file.size / chunkBytes);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await mkdir(dir, { recursive: true });
    await client.query(
      `insert into upload_sessions (id, user_id, file_name, size_bytes, content_type, encoding, chapter_split_mode,
      client_book_id, total_chunks, import_mode, base_active_content_revision_id, expected_base)
      values ($1,$2,$3,$4,$5,$10,$11,$6,$7,$8,$9,$12::jsonb)`,
      [
        uploadId,
        config.defaultUserId,
        file.name,
        file.size,
        file.type,
        input.clientBookId,
        count,
        input.importMode ?? 'replace_book',
        input.baseActiveContentRevisionId ?? null,
        'encoding' in input ? input.encoding : 'auto',
        'chapterSplitMode' in input ? (input.chapterSplitMode ?? 'auto') : 'auto',
        'expectedBase' in input ? JSON.stringify(input.expectedBase) : null,
      ],
    );
    const hash = createHash('sha256');
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      const bytes = Buffer.from(await file.slice(i * chunkBytes, (i + 1) * chunkBytes).arrayBuffer());
      hash.update(bytes);
      const chunkPath = path.join(dir, `${String(i).padStart(8, '0')}.part`);
      await writeFile(chunkPath, bytes);
      await client.query(
        'insert into upload_chunks (upload_id, chunk_index, size_bytes, storage_path) values ($1,$2,$3,$4)',
        [uploadId, i, bytes.length, chunkPath],
      );
    }
    signal.throwIfAborted();
    const sourceContentHash = `sha256:${hash.digest('hex')}`;
    await client.query('update upload_sessions set source_content_hash = $1 where id = $2', [
      sourceContentHash,
      uploadId,
    ]);
    await client.query('commit');
    return { uploadId, sourceContentHash, byteLength: file.size };
  } catch (error) {
    await client.query('rollback');
    await removeUploadDirectory(config, uploadId);
    throw error;
  } finally {
    client.release();
  }
}
