import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { createHostedBackupStream, type HostedBackupSnapshot } from './hosted-backup-archive.js';
import { restoreHostedBackup } from './hosted-backup-service.js';

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe('hosted backup restore', () => {
  it('ignores superseded asset metadata from older archives when no object blob was exported', async () => {
    const snapshot: HostedBackupSnapshot = {
      tables: new Map([
        [
          'library_books',
          [{ id: 'book_1', user_id: 'old_user', object_id: null, title: 'Book', cover_asset_id: null }],
        ],
        [
          'book_assets',
          [
            {
              id: 'cover_old',
              user_id: 'old_user',
              book_id: 'book_1',
              kind: 'cover',
              status: 'superseded',
              storage_key: 'old/cover.webp',
            },
          ],
        ],
        ['reader_settings', []],
      ]),
      objects: [],
      books: [{ id: 'book_1', format: 'txt', title: 'Book' }],
      exportedAt: '2026-07-13T00:00:00.000Z',
      appVersion: '0.1.0',
    };
    const streamed = createHostedBackupStream(snapshot, async () => Buffer.alloc(0));
    const [archive] = await Promise.all([collect(streamed.readable), streamed.completion]);
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes('select id, title from library_books')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    await expect(
      restoreHostedBackup(pool, { defaultUserId: 'user_1', s3: {} } as ServerConfig, archive, {
        defaultConflictResolution: 'replace',
      }),
    ).resolves.toMatchObject({ restoredBooks: 1 });
    expect(calls.some((sql) => sql.includes('insert into "book_assets"'))).toBe(false);
  });

  it('preserves user casting settings but invalidates derived assignments on restore', async () => {
    const snapshot: HostedBackupSnapshot = {
      tables: new Map([
        [
          'library_books',
          [
            {
              id: 'book_1',
              user_id: 'old_user',
              object_id: null,
              title: 'Book',
              active_content_revision_id: 'revision_1',
            },
          ],
        ],
        ['book_content_revisions', [{ id: 'revision_1', book_id: 'book_1', revision_number: 1, status: 'active' }]],
        [
          'voice_casting_states',
          [
            {
              user_id: 'old_user',
              book_id: 'book_1',
              version: 'voice-casting-v1',
              revision: 4,
              state_payload: {
                bookId: 'book_1',
                contentRevisionId: 'revision_1',
                status: 'active',
                assignments: [{ id: 'old_assignment' }],
              },
              user_authored_payload: {
                voiceProfileIds: ['voice_1'],
                pools: [],
                overrides: [],
                traitEvidence: [],
              },
              derived_payload: { importanceProfiles: [{ id: 'old_importance' }] },
            },
          ],
        ],
        ['reader_settings', []],
      ]),
      objects: [],
      books: [{ id: 'book_1', format: 'txt', activeContentRevisionId: 'revision_1', title: 'Book' }],
      exportedAt: '2026-07-13T00:00:00.000Z',
      appVersion: '0.1.0',
    };
    const streamed = createHostedBackupStream(snapshot, async () => Buffer.alloc(0));
    const [archive] = await Promise.all([collect(streamed.readable), streamed.completion]);
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('select id, title from library_books')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const config = { defaultUserId: 'user_1', s3: {} } as ServerConfig;

    await restoreHostedBackup(pool, config, archive, { defaultConflictResolution: 'replace' });
    const insert = calls.find((call) => call.sql.includes('insert into "voice_casting_states"'));

    expect(insert?.values?.[4]).toMatchObject({ status: 'staging', assignments: [] });
    expect(insert?.values?.[5]).toEqual(snapshot.tables.get('voice_casting_states')?.[0]?.user_authored_payload);
    expect(insert?.values?.[6]).toEqual({
      importanceProfiles: [],
      traitEvidence: [],
      traitProfiles: [],
      pools: [],
    });
  });

  it('rekeys nested paragraph identities when a conflicting book is restored as a copy', async () => {
    const snapshot: HostedBackupSnapshot = {
      tables: new Map([
        [
          'library_books',
          [
            {
              id: 'book_1',
              user_id: 'old_user',
              object_id: null,
              title: 'Book',
              active_content_revision_id: null,
            },
          ],
        ],
        [
          'paragraph_pages',
          [
            {
              id: 'page_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraphs: [{ id: 'paragraph_1', novelId: 'book_1', chapterId: 'chapter_1', text: 'line' }],
            },
          ],
        ],
        [
          'book_content_revisions',
          [
            {
              id: 'revision_1',
              book_id: 'book_1',
              revision_number: 1,
              status: 'active',
            },
          ],
        ],
        [
          'reading_positions',
          [
            {
              book_id: 'book_1',
              user_id: 'old_user',
              chapter_id: 'chapter_1',
              paragraph_id: 'paragraph_1',
            },
          ],
        ],
        [
          'voice_casting_states',
          [
            {
              user_id: 'old_user',
              book_id: 'book_1',
              version: 'voice-casting-v1',
              revision: 1,
              state_payload: { bookId: 'book_1', contentRevisionId: 'revision_1' },
              user_authored_payload: {
                voiceProfileIds: ['voice_1'],
                pools: [],
                overrides: [],
                traitEvidence: [],
              },
              derived_payload: { automaticAssignments: [] },
            },
          ],
        ],
        ['reader_settings', []],
      ]),
      objects: [],
      books: [{ id: 'book_1', format: 'txt', title: 'Book' }],
      exportedAt: '2026-07-13T00:00:00.000Z',
      appVersion: '0.1.0',
    };
    const streamed = createHostedBackupStream(snapshot, async () => Buffer.alloc(0));
    const [archive] = await Promise.all([collect(streamed.readable), streamed.completion]);
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('select id, title from library_books')) return { rows: [{ id: 'book_1', title: 'Existing' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const config = {
      defaultUserId: 'user_1',
      s3: {},
    } as ServerConfig;

    const result = await restoreHostedBackup(pool, config, archive, { defaultConflictResolution: 'copy' });
    const serializedValues = JSON.stringify(calls.flatMap((call) => call.values ?? []));

    expect(result).toMatchObject({ restoredBooks: 1, copiedBooks: 1, skippedBooks: 0 });
    expect(serializedValues).not.toContain('"paragraph_1"');
    expect(serializedValues).toContain('paragraph_1__copy_');
    expect(serializedValues).toContain('book_1__copy_');
    expect(calls.some((call) => call.sql.includes('insert into "voice_casting_states"'))).toBe(false);
  });
});
