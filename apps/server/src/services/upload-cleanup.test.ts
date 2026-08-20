import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { ServerConfig } from '../config.js';
import { pruneStaleUploadSessions } from './upload-cleanup.js';

const tempDirs: string[] = [];

function testConfig(dataDir: string, staleUploadMaxAgeMs = 1000): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir,
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs,
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('upload cleanup', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('expires stale active and terminal sessions, clears chunks, and removes upload directories', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'noveldesk-upload-cleanup-'));
    tempDirs.push(dataDir);
    await mkdir(path.join(dataDir, 'uploads', 'upload_old'), { recursive: true });
    await mkdir(path.join(dataDir, 'uploads', 'upload_older'), { recursive: true });
    await writeFile(path.join(dataDir, 'uploads', 'upload_old', '00000000.part'), 'chunk');
    await writeFile(path.join(dataDir, 'uploads', 'upload_older', '00000000.part'), 'chunk');

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('update upload_sessions')) {
          expect(params).toEqual([
            'expired',
            ['uploading', 'failed', 'imported', 'cancelled'],
            '2026-07-05T00:00:09.000Z',
            null,
          ]);
          expect(sql).toContain('status = any($2::text[])');
          return { rows: [{ id: 'upload_old' }, { id: 'upload_older' }], rowCount: 2 };
        }
        if (sql.includes('delete from upload_chunks')) {
          expect(params).toEqual([['upload_old', 'upload_older']]);
          return { rows: [], rowCount: 2 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;

    const result = await pruneStaleUploadSessions(pool, testConfig(dataDir), {
      now: new Date('2026-07-05T00:00:10.000Z'),
    });

    expect(result).toEqual({
      prunedCount: 2,
      uploadIds: ['upload_old', 'upload_older'],
      cutoff: '2026-07-05T00:00:09.000Z',
      disabled: false,
    });
    expect(await exists(path.join(dataDir, 'uploads', 'upload_old'))).toBe(false);
    expect(await exists(path.join(dataDir, 'uploads', 'upload_older'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('does not query the database when stale upload pruning is disabled', async () => {
    const pool = {
      connect: vi.fn(),
    } as unknown as pg.Pool;

    const result = await pruneStaleUploadSessions(pool, testConfig('.server-test-data', 0), {
      now: new Date('2026-07-05T00:00:10.000Z'),
    });

    expect(result).toEqual({
      prunedCount: 0,
      uploadIds: [],
      cutoff: '2026-07-05T00:00:10.000Z',
      disabled: true,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
