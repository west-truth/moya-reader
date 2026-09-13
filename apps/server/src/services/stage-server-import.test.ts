import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { stageServerImport } from './stage-server-import.js';
import type { ServerConfig } from '../config.js';

describe('server download staging', () => {
  it.each([false, true])('writes normal upload chunks transactionally (cancel=%s)', async (cancel) => {
    const root = await mkdtemp(path.join(tmpdir(), 'moya-staged-import-'));
    const abort = new AbortController();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (cancel && sql.startsWith('insert into upload_chunks')) abort.abort();
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const config = { dataDir: root, maxUploadBytes: 100, maxChunkBytes: 3, defaultUserId: 'owner' } as ServerConfig;
    const file = new File(['abcdefghi'], 'work.cbz');
    try {
      const result = stageServerImport(
        pool,
        config,
        file,
        {
          artifactId: 'a',
          collection: { remoteId: 'work', title: 'Work' },
          remoteId: 'release',
          release: { title: 'First' },
          clientBookId: 'book',
          importMode: 'append_image_series',
          baseActiveContentRevisionId: 'base',
        },
        abort.signal,
      );
      if (cancel) {
        await expect(result).rejects.toThrow();
        expect(client.query).toHaveBeenCalledWith('rollback');
        expect(await readdir(path.join(root, 'uploads'))).toEqual([]);
      } else {
        const receipt = await result;
        const dir = path.join(root, 'uploads', receipt.uploadId);
        const chunks = await Promise.all((await readdir(dir)).sort().map((name) => readFile(path.join(dir, name))));
        expect(Buffer.concat(chunks).toString()).toBe('abcdefghi');
        expect(client.query).toHaveBeenCalledWith('commit');
        expect(receipt.sourceContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      }
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
