import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { registerDocumentAnnotationRoutes } from './document-annotation-routes.js';
import { testConfig } from './books-route-test-harness.js';

describe('hosted document annotations', () => {
  it('stores full PDF annotation data, rejects stale pages and preserves ownership', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    let syncEvents = 0;
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('select id from library_books')) return { rows: [{ id: 'pdf_1' }] };
        if (sql.includes('select 1 from library_books')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('from library_books b')) {
          return { rows: [{ format: 'pdf', raw_text_hash: 'sha256:source', chapter_id: 'chapter_1' }] };
        }
        if (sql.includes('insert into document_annotations')) {
          const [id, bookId, userId, pageIndex, type, anchor, quote, body, color, remap, createdAt, updatedAt] = params;
          if (rows.has(String(id)) && rows.get(String(id))?.book_id !== bookId) return { rows: [] };
          rows.set(String(id), {
            id,
            book_id: bookId,
            user_id: userId,
            page_index: pageIndex,
            annotation_type: type,
            anchor: JSON.parse(String(anchor)),
            quote,
            body,
            color,
            text_anchor_remap: remap ? JSON.parse(String(remap)) : null,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { rows: [{ id }] };
        }
        if (sql.includes('from document_annotations')) {
          return { rows: [...rows.values()].filter((row) => row.book_id === params[0] && row.user_id === params[1]) };
        }
        if (sql.includes('insert into sync_events')) {
          syncEvents++;
          return { rows: [] };
        }
        if (sql.includes('update document_annotations')) {
          const row = rows.get(String(params[0]));
          if (!row || row.book_id !== params[1] || row.user_id !== params[2]) return { rows: [] };
          rows.delete(String(params[0]));
          return { rows: [{ id: params[0] }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    } as unknown as pg.Pool;
    const app = Fastify();
    await registerDocumentAnnotationRoutes(app, pool, testConfig());
    const annotation = {
      id: 'annotation_1',
      bookId: 'pdf_1',
      pageIndex: 0,
      type: 'region_note',
      anchor: {
        kind: 'fixed_region',
        bookId: 'pdf_1',
        pageIndex: 0,
        pageHash: 'sha256:source:pdf-page:0',
        quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
      },
      quote: 'visible quote',
      body: 'memo',
      color: 'blue',
      textAnchorRemap: {
        status: 'needs_review',
        fromTextRevisionId: 'a',
        targetTextRevisionId: 'b',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const url = '/api/books/pdf_1/document-annotations/annotation_1';
    expect((await app.inject({ method: 'PUT', url, payload: annotation })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/books/pdf_1/document-annotations' })).json()).toEqual({
      annotations: [annotation],
    });
    expect(syncEvents).toBe(1);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: {
            ...annotation,
            anchor: { ...annotation.anchor, pageHash: 'old-source' },
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/books/other/document-annotations/annotation_1',
          payload: annotation,
        })
      ).statusCode,
    ).toBe(400);
    expect(syncEvents).toBe(1);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/books/pdf_1/document-annotations' })).json()).toEqual({
      annotations: [],
    });
    expect(syncEvents).toBe(2);
    await app.close();
  });
});
