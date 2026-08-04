import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { appWithBooks } from './books-route-test-harness.js';

const expectedRoutes = [
  ['GET', '/api/books'],
  ['PATCH', '/api/books/:bookId'],
  ['DELETE', '/api/books/:bookId'],
  ['GET', '/api/books/:bookId/manifest'],
  ['GET', '/api/books/:bookId/chapters'],
  ['GET', '/api/books/:bookId/chapter-structure'],
  ['POST', '/api/books/:bookId/chapter-structure/preview'],
  ['GET', '/api/books/:bookId/chapter-structure/review'],
  ['POST', '/api/chapter-structure/drafts/:draftId/apply'],
  ['POST', '/api/chapter-structure/receipts/:receiptId/rollback'],
  ['GET', '/api/books/:bookId/cover/metadata'],
  ['GET', '/api/books/:bookId/cover'],
  ['PUT', '/api/books/:bookId/cover'],
  ['DELETE', '/api/books/:bookId/cover'],
  ['GET', '/api/books/:bookId/resources/:assetId'],
  ['GET', '/api/shelves'],
  ['POST', '/api/shelves'],
  ['PATCH', '/api/shelves/:shelfId'],
  ['DELETE', '/api/shelves/:shelfId'],
  ['PUT', '/api/shelves/:shelfId/books/:bookId'],
  ['DELETE', '/api/shelves/:shelfId/books/:bookId'],
  ['POST', '/api/library/batch'],
  ['GET', '/api/chapters/:chapterId'],
  ['GET', '/api/chapters/:chapterId/pages'],
  ['GET', '/api/paragraphs/:paragraphId'],
  ['GET', '/api/books/:bookId/search'],
  ['GET', '/api/chapters/:chapterId/search'],
  ['PATCH', '/api/books/:bookId/reading-position'],
  ['DELETE', '/api/books/:bookId/reading-position'],
  ['GET', '/api/settings'],
  ['PUT', '/api/settings'],
  ['GET', '/api/books/:bookId/bookmarks'],
  ['POST', '/api/books/:bookId/bookmarks'],
  ['DELETE', '/api/bookmarks/:bookmarkId'],
  ['GET', '/api/books/:bookId/highlights'],
  ['POST', '/api/books/:bookId/highlights'],
  ['DELETE', '/api/highlights/:highlightId'],
  ['GET', '/api/books/:bookId/notes'],
  ['POST', '/api/books/:bookId/notes'],
  ['DELETE', '/api/notes/:noteId'],
] as const;

describe('book route composition', () => {
  it('registers every hosted book and reader endpoint through the facade', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    for (const [method, url] of expectedRoutes) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }

    await app.close();
  });
});
