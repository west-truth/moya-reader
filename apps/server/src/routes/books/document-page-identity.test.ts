import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { archiveThumbnailPageHash } from '../../../../../src/features/fixed-document/archive-thumbnail';
import { documentPageHash } from './document-page-identity.js';

describe('imported fixed-document page identity', () => {
  it("uses the reader's archive asset identity and requires a real page", async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({
      rows:
        params[1] === 0
          ? [
              {
                format: 'image_archive',
                raw_text_hash: 'sha256:source',
                chapter_id: 'chapter_1',
                asset_id: 'document_page_1',
              },
            ]
          : [{ format: 'image_archive', raw_text_hash: 'sha256:source', chapter_id: null, asset_id: null }],
    }));
    const db = { query } as unknown as pg.Pool;
    await expect(documentPageHash(db, 'book_1', 0, 'owner_1')).resolves.toBe(
      archiveThumbnailPageHash('document_page_1', 0),
    );
    await expect(documentPageHash(db, 'book_1', 1, 'owner_1')).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('b.user_id = $3'), ['book_1', 0, 'owner_1']);
  });
});
