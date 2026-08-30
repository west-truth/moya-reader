import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { appWithBooks } from './books-route-test-harness.js';

function revisionPool() {
  return {
    query: vi.fn(async (sql: string) => {
      const revision = { active_content_revision_id: 'revision-r2', has_prior_purge: true };
      if (sql.includes('from reading_positions')) return { rows: [] };
      if (sql.includes('source_file_name')) return { rows: [{ ...revision, id: 'book-1', title: 'Book' }] };
      if (sql.includes('order by c.chapter_index')) {
        return { rows: [{ ...revision, id: 'chapter-1', book_id: 'book-1', chapter_index: 1 }] };
      }
      if (sql.includes('where c.id = $1') && !sql.includes('paragraph_pages')) {
        return { rows: [{ ...revision, id: 'chapter-1', book_id: 'book-1', chapter_index: 1 }] };
      }
      if (sql.includes('paragraph_pages')) {
        return {
          rows: [
            {
              ...revision,
              id: 'page-1',
              book_id: 'book-1',
              chapter_id: 'chapter-1',
              page_index: 0,
              paragraphs: [],
            },
          ],
        };
      }
      if (sql.includes('paragraph_search')) {
        return { rows: [{ ...revision, paragraph: { id: 'paragraph-1', novelId: 'book-1' } }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as pg.Pool;
}

describe('hosted content revision reads', () => {
  it.each([
    '/api/books/book-1/manifest?contentRevisionId=revision-r1',
    '/api/books/book-1/chapters?contentRevisionId=revision-r1',
    '/api/chapters/chapter-1?contentRevisionId=revision-r1',
    '/api/chapters/chapter-1/pages?contentRevisionId=revision-r1',
    '/api/paragraphs/paragraph-1?contentRevisionId=revision-r1',
  ])('rejects stale R1 content after the canonical book moved to R2: %s', async (url) => {
    const app = await appWithBooks(revisionPool());
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'book content revision changed',
      actualContentRevisionId: 'revision-r2',
    });
    await app.close();
  });

  it('requires a pin after a hard purge/re-add and returns canonical evidence when pinned', async () => {
    const app = await appWithBooks(revisionPool());
    const unpinned = await app.inject({ method: 'GET', url: '/api/books/book-1/chapters' });
    expect(unpinned.statusCode).toBe(409);
    expect(unpinned.json()).toMatchObject({ error: 'book content revision is required' });

    const pinned = await app.inject({
      method: 'GET',
      url: '/api/books/book-1/chapters?contentRevisionId=revision-r2',
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ contentRevisionId: 'revision-r2' });
    await app.close();
  });
});
