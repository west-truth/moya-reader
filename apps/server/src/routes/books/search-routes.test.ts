import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import {
  decodeReaderSearchCursor,
  encodeReaderSearchCursor,
} from '../../../../../src/repositories/reader-query-contract.js';
import { appWithBooks } from './books-route-test-harness.js';

function paragraph(index: number, chapterId = 'chapter_1') {
  return {
    id: `${chapterId}:paragraph:${index}`,
    novelId: 'book_1',
    chapterId,
    index,
    text: `needle paragraph ${index}`,
    startOffsetInChapter: index * 20,
    endOffsetInChapter: index * 20 + 18,
    textHash: `hash-${chapterId}-${index}`,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('paginated book search routes', () => {
  it('uses a query-bound keyset cursor for book search pages', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('c.chapter_index > $4');
        expect(sql).toContain('ps.paragraph_index > $5');
        const afterParagraph = params?.[4];
        if (afterParagraph === null) {
          expect(params).toEqual(['user_test', 'book_1', '%needle%', null, null, 3]);
          return {
            rows: [1, 2, 3].map((index) => ({
              paragraph: paragraph(index),
              search_chapter_index: 1,
              search_paragraph_index: index,
            })),
          };
        }
        expect(params).toEqual(['user_test', 'book_1', '%needle%', 1, 2, 3]);
        return {
          rows: [3, 4].map((index) => ({
            paragraph: paragraph(index),
            search_chapter_index: 1,
            search_paragraph_index: index,
          })),
        };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const first = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/search?query=needle&pageSize=2',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      paragraphs: [paragraph(1), paragraph(2)],
      capped: false,
      scannedRows: 2,
    });
    const nextCursor = String(first.json().nextCursor);
    expect(decodeReaderSearchCursor(nextCursor, { scope: 'book', targetId: 'book_1', query: 'needle' })).toMatchObject({
      source: 'remote',
      chapterIndex: 1,
      paragraphIndex: 2,
      matchedCount: 2,
    });

    const second = await app.inject({
      method: 'GET',
      url: `/api/books/book_1/search?query=needle&pageSize=2&cursor=${encodeURIComponent(nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      paragraphs: [paragraph(3), paragraph(4)],
      capped: false,
      scannedRows: 2,
    });
    expect(second.json()).not.toHaveProperty('nextCursor');
    await app.close();
  });

  it('enforces chapter/book hard limits and rejects a cursor reused for another query', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('ps.chapter_id = $2')) {
          expect(params).toEqual(['user_test', 'chapter_1', '%needle%', 199, 2]);
          return {
            rows: [200, 201].map((index) => ({
              paragraph: paragraph(index),
              search_paragraph_index: index,
            })),
          };
        }
        expect(params).toEqual(['user_test', 'book_1', '%needle%', 2, 99, 2]);
        return {
          rows: [
            { paragraph: paragraph(100, 'chapter_2'), search_chapter_index: 2, search_paragraph_index: 100 },
            { paragraph: paragraph(101, 'chapter_2'), search_chapter_index: 2, search_paragraph_index: 101 },
          ],
        };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);
    const chapterCursor = encodeReaderSearchCursor({
      version: 1,
      scope: 'chapter',
      targetId: 'chapter_1',
      query: 'needle',
      source: 'remote',
      chapterIndex: 0,
      paragraphIndex: 199,
      matchedCount: 199,
    });
    const bookCursor = encodeReaderSearchCursor({
      version: 1,
      scope: 'book',
      targetId: 'book_1',
      query: 'needle',
      source: 'remote',
      chapterIndex: 2,
      paragraphIndex: 99,
      matchedCount: 299,
    });

    const chapterResponse = await app.inject({
      method: 'GET',
      url: `/api/chapters/chapter_1/search?query=needle&pageSize=10&cursor=${encodeURIComponent(chapterCursor)}`,
    });
    expect(chapterResponse.json()).toMatchObject({ paragraphs: [paragraph(200)], capped: true });
    expect(chapterResponse.json()).not.toHaveProperty('nextCursor');

    const bookResponse = await app.inject({
      method: 'GET',
      url: `/api/books/book_1/search?query=needle&pageSize=10&cursor=${encodeURIComponent(bookCursor)}`,
    });
    expect(bookResponse.json()).toMatchObject({
      paragraphs: [paragraph(100, 'chapter_2')],
      capped: true,
    });
    expect(bookResponse.json()).not.toHaveProperty('nextCursor');

    const invalidResponse = await app.inject({
      method: 'GET',
      url: `/api/books/book_1/search?query=another&pageSize=2&cursor=${encodeURIComponent(bookCursor)}`,
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(pool.query).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
