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
              page_index: 0,
              start_paragraph_index: 0,
              end_paragraph_index: 0,
              text_hash: 'sha256:page',
              paragraphs: [
                {
                  id: 'paragraph_1',
                  novelId: 'book_1',
                  chapterId: 'chapter_1',
                  index: 0,
                  text: 'Line',
                  startOffsetInChapter: 0,
                  endOffsetInChapter: 4,
                  textHash: 'sha256:paragraph',
                },
              ],
            },
          ],
        ],
        [
          'chapters',
          [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter',
              text_hash: 'sha256:chapter',
              raw_start_offset: 0,
              raw_end_offset: 4,
              character_count: 4,
              paragraph_count: 1,
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
          'fixed_document_section_read_states',
          [
            {
              book_id: 'book_1',
              user_id: 'old_user',
              document_section_id: 'chapter:6',
              last_read_at: '2026-08-30T01:06:00.000Z',
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
        if (sql.includes('select count(*)::text as count from paragraph_search')) return { rows: [{ count: '1' }] };
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
    const paragraphSearchInsert = calls.find((call) => call.sql.includes('insert into paragraph_search'));
    expect(paragraphSearchInsert?.values).toEqual([
      expect.any(String),
      expect.stringMatching(/^paragraph_1__copy_/),
      expect.stringMatching(/^book_1__copy_/),
      expect.stringMatching(/^chapter_1__copy_/),
      0,
      0,
      'Line',
      'line',
      expect.stringContaining('paragraph_1__copy_'),
    ]);
    const sectionReadStateInsert = calls.find((call) =>
      call.sql.includes('insert into "fixed_document_section_read_states"'),
    );
    expect(sectionReadStateInsert?.values).toEqual([
      expect.stringMatching(/^book_1__copy_/),
      'user_1',
      'chapter:6',
      '2026-08-30T01:06:00.000Z',
    ]);
    expect(calls.some((call) => call.sql.includes('insert into "voice_casting_states"'))).toBe(false);
  });

  it('rolls back instead of reporting success when the rebuilt paragraph search index is incomplete', async () => {
    const paragraph = {
      id: 'paragraph_1',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      index: 0,
      text: 'Searchable line',
      startOffsetInChapter: 0,
      endOffsetInChapter: 15,
      textHash: 'sha256:paragraph',
    };
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
          'chapters',
          [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter',
              text_hash: 'sha256:chapter',
              raw_start_offset: 0,
              raw_end_offset: 15,
              character_count: 15,
              paragraph_count: 1,
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
              page_index: 0,
              start_paragraph_index: 0,
              end_paragraph_index: 0,
              paragraphs: [paragraph],
              text_hash: 'sha256:page',
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
        if (sql.includes('select count(*)::text as count from paragraph_search')) return { rows: [{ count: '0' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    await expect(
      restoreHostedBackup(pool, { defaultUserId: 'user_1', s3: {} } as ServerConfig, archive, {
        defaultConflictResolution: 'replace',
      }),
    ).rejects.toThrow('Backup paragraph search index could not be restored completely');
    expect(calls).toContain('rollback');
    expect(calls).not.toContain('commit');
  });
});
