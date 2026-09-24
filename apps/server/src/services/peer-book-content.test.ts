import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import type { HostedBackupTableName, ParsedHostedBackupArchive } from './hosted-backup-archive.js';
import { restorePeerBookContent } from './peer-book-content.js';

describe('peer book archive scope', () => {
  it.each<[HostedBackupTableName, Record<string, unknown>]>([
    ['reader_settings', { user_id: 'source', settings: { fontSize: 90 } }],
    ['shelves', { id: 'shelf', user_id: 'source' }],
    ['reading_positions', { book_id: 'book', scroll_top: 900 }],
    ['bookmarks', { book_id: 'book', id: 'bookmark' }],
    ['chapters', { book_id: 'other_book', id: 'chapter' }],
    ['book_assets', { book_id: 'book', kind: 'unknown', storage_key: 'other-local-object' }],
  ])('rejects unrelated state in %s before accessing the target database', async (table, row) => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const parsed = {
      tables: new Map([
        ['library_books', [{ id: 'book', content_revision_number: 1 }]],
        [table, [row]],
      ]),
      objects: [],
    } as unknown as ParsedHostedBackupArchive;
    await expect(
      restorePeerBookContent(
        pool as unknown as pg.Pool,
        { defaultUserId: 'target' } as ServerConfig,
        parsed,
        'book',
        new AbortController().signal,
      ),
    ).rejects.toThrow('peer_book_content_scope_invalid');
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
