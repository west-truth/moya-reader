import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import {
  createHostedBackupStream,
  type HostedBackupSnapshot,
  type HostedBookObjectRow,
} from './hosted-backup-archive.js';

const objectStorage = vi.hoisted(() => ({
  createS3Client: vi.fn(() => ({ client: true })),
  putRawBookObject: vi.fn(
    async (_s3: unknown, _config: unknown, _key: string, _bytes: Uint8Array, _contentType: string) => undefined,
  ),
  deleteObject: vi.fn(async (_s3: unknown, _config: unknown, _key: string) => undefined),
}));

vi.mock('./object-storage.js', () => ({
  ...objectStorage,
  getObjectBuffer: vi.fn(),
}));

import { restoreHostedBackup } from './hosted-backup-service.js';

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    length += result.value.byteLength;
  }
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

async function coverArchive(): Promise<Uint8Array> {
  const cover = Buffer.from('restored cover');
  const object: HostedBookObjectRow = {
    id: 'cover_1',
    raw_text_hash: hash(cover),
    storage_key: 'archived/cover.webp',
    file_name: 'cover.webp',
    content_type: 'image/webp',
    size_bytes: cover.byteLength,
    created_at: '2026-07-13T00:00:00.000Z',
    asset_kind: 'cover',
  };
  const snapshot: HostedBackupSnapshot = {
    tables: new Map([
      [
        'library_books',
        [{ id: 'book_1', user_id: 'old_user', object_id: null, title: 'Restored', cover_asset_id: 'cover_1' }],
      ],
      [
        'book_assets',
        [
          {
            id: 'cover_1',
            user_id: 'old_user',
            book_id: 'book_1',
            kind: 'cover',
            status: 'active',
            storage_key: 'archived/cover.webp',
          },
        ],
      ],
      ['reader_settings', []],
    ]),
    objects: [object],
    books: [{ id: 'book_1', format: 'txt', title: 'Restored' }],
    exportedAt: '2026-07-13T00:00:00.000Z',
    appVersion: '0.1.0',
  };
  const result = createHostedBackupStream(snapshot, async () => cover);
  const [archive] = await Promise.all([collect(result.readable), result.completion]);
  return archive;
}

function restorePool(options: { failLibraryInsert?: boolean; events?: string[] } = {}): pg.Pool {
  const events = options.events ?? [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === 'rollback') events.push('rollback');
      if (sql === 'commit') events.push('commit');
      if (sql.includes('insert into object_delete_outbox')) {
        events.push(`enqueue-old:${String((values?.[0] as string[] | undefined)?.[0])}:${String(values?.[1])}`);
      }
      if (sql.includes('delete from object_delete_outbox') && sql.includes('storage_key')) {
        events.push(`release:${String((values?.[0] as string[] | undefined)?.[0])}`);
      }
      if (sql.includes('select id, title from library_books')) {
        return { rows: [{ id: 'book_1', title: 'Existing' }] };
      }
      if (sql.includes('select a.storage_key')) return { rows: [{ storage_key: 'user_1/book_1/cover.webp' }] };
      if (sql.includes('join library_books b on b.object_id')) return { rows: [] };
      if (sql.includes('insert into "library_books"') && options.failLibraryInsert) throw new Error('injected failure');
      if (sql.includes('select storage_key from book_objects where storage_key = any')) {
        return { rows: ((values?.[0] as string[] | undefined) ?? []).map((storage_key) => ({ storage_key })) };
      }
      if (sql.includes('where exists (select 1 from book_objects')) return { rows: [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const key = String((values?.[0] as string[] | undefined)?.[0]);
    const reason = String(values?.[1]);
    if (sql.includes("now() + ($3::bigint * interval '1 millisecond')")) events.push(`reserve:${key}:${reason}`);
    else if (sql.includes('insert into object_delete_outbox')) events.push(`enqueue-due:${key}:${reason}`);
    return { rows: [], rowCount: 1 };
  });
  return { connect: vi.fn(async () => client), query } as unknown as pg.Pool;
}

describe('hosted backup restore object safety', () => {
  it('reserves before PUT and makes a failed restore key immediately due without touching an old key', async () => {
    objectStorage.putRawBookObject.mockReset();
    objectStorage.deleteObject.mockClear();
    const events: string[] = [];
    objectStorage.putRawBookObject.mockImplementation(
      async (_s3: unknown, _config: unknown, key: string, _bytes: Uint8Array, _contentType: string) => {
        events.push(`put:${key}`);
      },
    );
    const archive = await coverArchive();
    const config = { defaultUserId: 'user_1', s3: {} } as ServerConfig;

    await expect(
      restoreHostedBackup(restorePool({ failLibraryInsert: true, events }), config, archive, {
        defaultConflictResolution: 'replace',
      }),
    ).rejects.toThrow('injected failure');

    const uploadedKey = String(objectStorage.putRawBookObject.mock.calls[0]?.[2]);
    expect(uploadedKey).toMatch(/^user_1\/backup-restores\/[0-9a-f]+\/books\/book_1\/covers\/cover_1\/cover\.webp$/);
    expect(uploadedKey).not.toBe('user_1/book_1/covers/cover_1/cover.webp');
    expect(events).toEqual([
      `reserve:${uploadedKey}:backup_restore_staging`,
      `put:${uploadedKey}`,
      'rollback',
      `enqueue-due:${uploadedKey}:backup_restore_failed`,
    ]);
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('atomically releases new reservations and queues superseded keys before commit', async () => {
    objectStorage.putRawBookObject.mockReset();
    objectStorage.deleteObject.mockClear();
    const events: string[] = [];
    objectStorage.putRawBookObject.mockImplementation(
      async (_s3: unknown, _config: unknown, key: string, _bytes: Uint8Array, _contentType: string) => {
        events.push(`put:${key}`);
      },
    );
    const archive = await coverArchive();

    await restoreHostedBackup(restorePool({ events }), { defaultUserId: 'user_1', s3: {} } as ServerConfig, archive, {
      defaultConflictResolution: 'replace',
    });

    const restoredKey = String(objectStorage.putRawBookObject.mock.calls[0]?.[2]);
    expect(events).toEqual([
      `reserve:${restoredKey}:backup_restore_staging`,
      `put:${restoredKey}`,
      'enqueue-old:user_1/book_1/cover.webp:backup_restore_superseded',
      `release:${restoredKey}`,
      'commit',
    ]);
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });
});
