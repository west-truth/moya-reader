import { rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { ServerConfig } from '../config.js';

interface UploadIdRow {
  id: string;
}

export interface UploadPruneResult {
  prunedCount: number;
  uploadIds: string[];
  cutoff: string;
  disabled: boolean;
}

export function uploadDirectory(config: ServerConfig, uploadId: string): string {
  const uploadsRoot = path.resolve(config.dataDir, 'uploads');
  const uploadDir = path.resolve(uploadsRoot, uploadId);
  if (uploadDir !== uploadsRoot && uploadDir.startsWith(`${uploadsRoot}${path.sep}`)) return uploadDir;
  throw new Error('invalid upload id');
}

export async function removeUploadDirectory(config: ServerConfig, uploadId: string): Promise<void> {
  await rm(uploadDirectory(config, uploadId), { recursive: true, force: true }).catch(() => undefined);
}

export async function pruneStaleUploadSessions(
  pool: pg.Pool,
  config: ServerConfig,
  options: { userId?: string; now?: Date } = {},
): Promise<UploadPruneResult> {
  const maxAgeMs = Number.isFinite(config.staleUploadMaxAgeMs) ? config.staleUploadMaxAgeMs : 0;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - Math.max(0, maxAgeMs)).toISOString();
  if (maxAgeMs <= 0) {
    return { prunedCount: 0, uploadIds: [], cutoff, disabled: true };
  }

  const client = await pool.connect();
  let uploadIds: string[];
  try {
    await client.query('begin');
    const expired = await client.query<UploadIdRow>(
      `
        update upload_sessions
        set status = $1,
            updated_at = now()
        where status = $2
          and updated_at < $3::timestamptz
          and ($4::text is null or user_id = $4)
        returning id
      `,
      ['expired', 'uploading', cutoff, options.userId ?? null],
    );
    uploadIds = expired.rows.map((row) => row.id);
    if (uploadIds.length) {
      await client.query('delete from upload_chunks where upload_id = any($1::text[])', [uploadIds]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  await Promise.all(uploadIds.map((uploadId) => removeUploadDirectory(config, uploadId)));
  return { prunedCount: uploadIds.length, uploadIds, cutoff, disabled: false };
}
