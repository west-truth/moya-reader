import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { resourceEntityRevision } from '@noveldesk/text-core/identity/sync';
import { appWithBooks } from './books/books-route-test-harness.js';

describe('book routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists books with last reading position metadata for the hosted library', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('left join reading_positions');
        expect(sql).toContain('left join chapters rc');
        expect(sql).toContain('b.document_section_count');
        expect(sql).toContain('rc.chapter_index as last_read_chapter_index');
        expect(params).toEqual(['user_test', 1001, 0]);
        return {
          rows: [
            {
              id: 'book_1',
              title: 'Server Novel',
              source_file_name: 'server-novel.txt',
              source_encoding: 'utf-8',
              total_chapters: 12,
              total_characters: 12345,
              total_paragraphs: 678,
              document_section_count: 6,
              last_read_chapter_id: 'chapter_2',
              last_read_chapter_index: 2,
              last_read_paragraph_id: 'paragraph_88',
              last_read_offset: 240,
              last_read_progress: 0.42,
            },
          ],
        };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'GET', url: '/api/books' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      books: [
        expect.objectContaining({
          id: 'book_1',
          title: 'Server Novel',
          document_section_count: 6,
          last_read_chapter_id: 'chapter_2',
          last_read_chapter_index: 2,
          last_read_progress: 0.42,
        }),
      ],
    });

    await app.close();
  });

  it('serves manifest and chapter metadata for opening a server book', async () => {
    const book = {
      id: 'book_1',
      title: 'Server Novel',
      source_file_name: 'server-novel.txt',
      source_encoding: 'utf-8',
      normalized_text_hash: 'hash_book',
      total_chapters: 2,
      total_characters: 2000,
      total_paragraphs: 20,
      document_section_count: 2,
      cover_seed: 'seed',
      favorite: false,
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:01:00.000Z',
    };
    const readingPosition = {
      book_id: 'book_1',
      user_id: 'user_test',
      chapter_id: 'chapter_1',
      paragraph_id: 'paragraph_3',
      paragraph_index: 3,
      offset_in_paragraph: 0,
      chapter_progress: 0.3,
      scroll_top: 120,
      updated_at: '2026-07-05T00:02:00.000Z',
    };
    const chapters = [
      {
        id: 'chapter_1',
        book_id: 'book_1',
        chapter_index: 0,
        title: '1화 · 1페이지',
        paragraph_count: 1,
        document_section_id: 'chapter:101',
        document_section_title: '1화',
        document_section_index: 1,
        document_page_index_in_section: 1,
      },
      {
        id: 'chapter_2',
        book_id: 'book_1',
        chapter_index: 1,
        title: '2화 · 1페이지',
        paragraph_count: 1,
        document_section_id: 'chapter:102',
        document_section_title: '2화',
        document_section_index: 2,
        document_page_index_in_section: 1,
      },
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from library_books') && sql.includes('source_file_name')) {
          expect(sql).toContain('b.document_section_count');
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [book] };
        }
        if (sql.includes('from reading_positions')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [readingPosition] };
        }
        if (sql.includes('select id from library_books')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [{ id: 'book_1' }] };
        }
        if (sql.includes('from chapters c') && sql.includes('where c.id = $1')) {
          expect(sql).toContain('c.document_section_id');
          expect(sql).toContain('c.document_section_title');
          expect(sql).toContain('c.document_section_index');
          expect(sql).toContain('c.document_page_index_in_section');
          expect(params).toEqual(['chapter_2', 'user_test']);
          return { rows: [chapters[1]] };
        }
        if (sql.includes('from chapters c') && sql.includes('order by c.chapter_index')) {
          expect(sql).toContain('document_section_id');
          expect(sql).toContain('document_section_title');
          expect(sql).toContain('document_section_index');
          expect(sql).toContain('document_page_index_in_section');
          expect(sql).toContain('fixed_document_section_read_states');
          expect(sql).toContain('document_section_read_at');
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: chapters };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const manifestResponse = await app.inject({ method: 'GET', url: '/api/books/book_1/manifest' });
    const chaptersResponse = await app.inject({ method: 'GET', url: '/api/books/book_1/chapters' });
    const chapterResponse = await app.inject({ method: 'GET', url: '/api/chapters/chapter_2' });

    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({ book, readingPosition });
    expect(chaptersResponse.statusCode).toBe(200);
    expect(chaptersResponse.json()).toEqual({ chapters });
    expect(chapterResponse.statusCode).toBe(200);
    expect(chapterResponse.json()).toEqual({ chapter: chapters[1] });

    await app.close();
  });

  it('serves bounded chapter page windows for lazy reader loading', async () => {
    const page = {
      id: 'page_2',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      page_index: 2,
      start_paragraph_index: 40,
      end_paragraph_index: 59,
      paragraphs: [{ id: 'paragraph_40', chapterId: 'chapter_1', chapterIndex: 0, index: 40, text: 'page text' }],
      text_hash: 'hash_page_2',
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('from paragraph_pages pp');
        expect(sql).toContain('limit $4');
        expect(params).toEqual(['chapter_1', 'user_test', 2, 20]);
        return { rows: [page] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'GET', url: '/api/chapters/chapter_1/pages?from=2&count=99' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pages: [page] });

    await app.close();
  });

  it('serves paragraph lookup from the search row table', async () => {
    const paragraph = {
      id: 'paragraph_40',
      chapterId: 'chapter_1',
      index: 40,
      text: 'page text',
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('from paragraph_search ps');
        expect(sql).toContain('ps.paragraph_id = $2');
        expect(params).toEqual(['user_test', 'paragraph_40']);
        return { rows: [{ paragraph }] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'GET', url: '/api/paragraphs/paragraph_40' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paragraph });

    await app.close();
  });

  it('searches server book paragraphs with escaped wildcards and a capped query contract', async () => {
    const paragraph = {
      id: 'paragraph_7',
      chapterId: 'chapter_1',
      chapterIndex: 0,
      index: 7,
      text: 'Dragon wakes in the city.',
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('from paragraph_search ps');
        expect(sql).toContain('ps.text_lower like $3');
        expect(sql).toContain('escape');
        expect(sql).toContain('order by c.chapter_index asc, ps.paragraph_index asc');
        expect(params).toEqual(['user_test', 'book_1', '%dr\\%\\_agon%', 300]);
        return { rows: [{ paragraph }] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/search?query=%20Dr%25_agon%20&limit=999',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paragraphs: [paragraph] });

    await app.close();
  });

  it('searches server chapter paragraphs with escaped wildcards and the chapter cap', async () => {
    const paragraph = {
      id: 'paragraph_9',
      chapterId: 'chapter_1',
      index: 9,
      text: 'Dragon sleeps.',
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('from paragraph_search ps');
        expect(sql).toContain('ps.chapter_id = $2');
        expect(sql).toContain('escape');
        expect(sql).toContain('order by ps.paragraph_index asc');
        expect(params).toEqual(['user_test', 'chapter_1', '%dra\\_gon\\%%', 200]);
        return { rows: [{ paragraph }] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'GET',
      url: '/api/chapters/chapter_1/search?query=Dra_gon%25&limit=999',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paragraphs: [paragraph] });

    await app.close();
  });

  it('saves reading position and emits a sync event only when the update is applied', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('insert into reading_positions')) {
          expect(sql).toContain('pg_advisory_xact_lock(hashtextextended($1, 7319))');
          expect(sql).toContain('requested_chapter');
          expect(sql).toContain('insert into fixed_document_section_read_states');
          expect(sql).toContain('on conflict (book_id, user_id, document_section_id)');
          expect(params).toEqual([
            'book_1',
            'user_test',
            'chapter_1',
            'paragraph_7',
            7,
            2,
            0.55,
            320,
            'device_a',
            '2026-07-05T00:03:00.000Z',
            'chapter:6',
          ]);
          return { rows: [{ chapter_found: true, applied: true, read_applied: true }] };
        }
        if (sql.includes('insert into sync_events')) {
          expect(params?.[1]).toBe('user_test');
          expect(params?.[2]).toBe('device_a');
          expect(params?.[3]).toBe('reading_position_updated');
          expect(params?.[4]).toBe('book_1');
          expect(params?.[5]).toBe('reading_position_book_1');
          const payload = JSON.parse(String(params?.[6])) as Record<string, unknown>;
          const revision = JSON.parse(String(params?.[7])) as Record<string, unknown>;
          expect(payload).toMatchObject({
            position: {
              bookId: 'book_1',
              chapterId: 'chapter_1',
              paragraphId: 'paragraph_7',
              updatedAt: '2026-07-05T00:03:00.000Z',
            },
          });
          expect(revision).toMatchObject({
            entityType: 'reading_position',
            entityId: 'reading_position_book_1',
            novelId: 'book_1',
            localSequence: 0,
            updatedAt: '2026-07-05T00:03:00.000Z',
          });
          expect(typeof revision.payloadHash).toBe('string');
          expect(params?.[8]).toBe('2026-07-05T00:03:00.000Z');
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/books/book_1/reading-position',
      payload: {
        chapterId: 'chapter_1',
        documentSectionId: 'chapter:6',
        paragraphId: 'paragraph_7',
        paragraphIndex: 7,
        offsetInParagraph: 2,
        chapterProgress: 0.55,
        scrollTop: 320,
        deviceId: 'device_a',
        updatedAt: '2026-07-05T00:03:00.000Z',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, applied: true });
    expect(pool.query).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('does not emit sync events for stale reading-position patches', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(sql).toContain('insert into reading_positions');
        expect(sql).toContain('pg_advisory_xact_lock(hashtextextended($1, 7319))');
        expect(params).toEqual([
          'book_1',
          'user_test',
          'chapter_1',
          undefined,
          0,
          0,
          0,
          0,
          undefined,
          '2026-07-04T23:59:00.000Z',
          null,
        ]);
        return { rows: [{ chapter_found: true, applied: false, read_applied: false }] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/books/book_1/reading-position',
      payload: {
        chapterId: 'chapter_1',
        updatedAt: '2026-07-04T23:59:00.000Z',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, applied: false });
    expect(pool.query).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('creates, lists, and tombstones hosted annotations with sync events', async () => {
    const bookmarks = new Map<string, Record<string, unknown>>();
    const highlights = new Map<string, Record<string, unknown>>();
    const notes = new Map<string, Record<string, unknown>>();
    const syncEvents: Array<{
      type: string;
      bookId?: string;
      entityId?: string;
      payload: Record<string, unknown>;
      revision?: Record<string, unknown>;
    }> = [];
    const activeRows = (rows: Map<string, Record<string, unknown>>) => {
      return Array.from(rows.values()).filter((row) => !row.deleted_at);
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select id from library_books')) {
          return { rows: [{ id: 'book_1' }] };
        }
        if (sql.includes('select exists(') && sql.includes('from chapters c')) {
          expect(params?.[0]).toBe('book_1');
          expect(params?.[1]).toBe('user_test');
          expect(params?.[2]).toMatch(/^chapter_1$/);
          return { rows: [{ exists: true }] };
        }
        if (sql.includes('select book_id from bookmarks')) {
          const row = bookmarks.get(String(params?.[0]));
          return { rows: row ? [{ book_id: row.book_id }] : [] };
        }
        if (sql.includes('from bookmarks') && sql.includes('where id = $1 and user_id = $2')) {
          const row = bookmarks.get(String(params?.[0]));
          return { rows: row && !row.deleted_at ? [row] : [] };
        }
        if (sql.includes('from bookmarks')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: activeRows(bookmarks) };
        }
        if (sql.includes('insert into bookmarks')) {
          expect(sql).toContain('bookmarks.book_id = excluded.book_id');
          expect(sql).toContain('bookmarks.user_id = excluded.user_id');
          const existing = bookmarks.get(String(params?.[0]));
          if (existing && String(existing.updated_at) > String(params?.[8])) return { rowCount: 0, rows: [] };
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            user_id: params?.[2],
            chapter_id: params?.[3],
            paragraph_id: params?.[4],
            label: params?.[5],
            progress: params?.[6],
            scroll_top: params?.[7],
            created_at: params?.[8],
            updated_at: params?.[8],
          };
          bookmarks.set(String(row.id), row);
          return { rowCount: 1, rows: [{ id: row.id }] };
        }
        if (sql.includes('update bookmarks set deleted_at')) {
          const row = bookmarks.get(String(params?.[0]));
          if (!row || row.deleted_at) return { rows: [] };
          row.deleted_at = params?.[2];
          row.updated_at = params?.[2];
          return { rows: [{ book_id: row.book_id }] };
        }

        if (sql.includes('select book_id from highlights')) {
          const row = highlights.get(String(params?.[0]));
          return { rows: row ? [{ book_id: row.book_id }] : [] };
        }
        if (sql.includes('from highlights') && sql.includes('where id = $1 and user_id = $2')) {
          const row = highlights.get(String(params?.[0]));
          return { rows: row && !row.deleted_at ? [row] : [] };
        }
        if (sql.includes('from highlights')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: activeRows(highlights) };
        }
        if (sql.includes('insert into highlights')) {
          expect(sql).toContain('highlights.book_id = excluded.book_id');
          expect(sql).toContain('highlights.user_id = excluded.user_id');
          const existing = highlights.get(String(params?.[0]));
          if (existing && String(existing.updated_at) > String(params?.[9])) return { rowCount: 0, rows: [] };
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            user_id: params?.[2],
            chapter_id: params?.[3],
            paragraph_id: params?.[4],
            quote: params?.[5],
            color: params?.[6],
            progress: params?.[7],
            created_at: params?.[8],
            updated_at: params?.[9],
          };
          highlights.set(String(row.id), row);
          return { rowCount: 1, rows: [{ id: row.id }] };
        }
        if (sql.includes('update highlights set deleted_at')) {
          const row = highlights.get(String(params?.[0]));
          if (!row || row.deleted_at) return { rows: [] };
          row.deleted_at = params?.[2];
          row.updated_at = params?.[2];
          return { rows: [{ book_id: row.book_id }] };
        }

        if (sql.includes('select book_id from notes')) {
          const row = notes.get(String(params?.[0]));
          return { rows: row ? [{ book_id: row.book_id }] : [] };
        }
        if (sql.includes('from notes') && sql.includes('where id = $1 and user_id = $2')) {
          const row = notes.get(String(params?.[0]));
          return { rows: row && !row.deleted_at ? [row] : [] };
        }
        if (sql.includes('from notes')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: activeRows(notes) };
        }
        if (sql.includes('insert into notes')) {
          expect(sql).toContain('notes.book_id = excluded.book_id');
          expect(sql).toContain('notes.user_id = excluded.user_id');
          const existing = notes.get(String(params?.[0]));
          if (existing && String(existing.updated_at) > String(params?.[9])) return { rowCount: 0, rows: [] };
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            user_id: params?.[2],
            chapter_id: params?.[3],
            paragraph_id: params?.[4],
            quote: params?.[5],
            body: params?.[6],
            progress: params?.[7],
            created_at: params?.[8],
            updated_at: params?.[9],
          };
          notes.set(String(row.id), row);
          return { rowCount: 1, rows: [{ id: row.id }] };
        }
        if (sql.includes('update notes set deleted_at')) {
          const row = notes.get(String(params?.[0]));
          if (!row || row.deleted_at) return { rows: [] };
          row.deleted_at = params?.[2];
          row.updated_at = params?.[2];
          return { rows: [{ book_id: row.book_id }] };
        }

        if (sql.includes('insert into sync_events')) {
          syncEvents.push({
            type: String(params?.[3]),
            bookId: typeof params?.[4] === 'string' ? params[4] : undefined,
            entityId: typeof params?.[5] === 'string' ? params[5] : undefined,
            payload: JSON.parse(String(params?.[6])) as Record<string, unknown>,
            revision: params?.[7] ? (JSON.parse(String(params[7])) as Record<string, unknown>) : undefined,
          });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const bookmark = {
      id: 'bookmark_1',
      novelId: 'wrong_book',
      bookId: 'wrong_book',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_3',
      label: '42%',
      progress: 0.42,
      scrollTop: 420,
      createdAt: '2026-07-05T00:04:00.000Z',
    };
    const highlight = {
      id: 'highlight_1',
      novelId: 'wrong_book',
      bookId: 'wrong_book',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_4',
      quote: 'highlighted text',
      color: 'yellow',
      progress: 0.44,
      createdAt: '2026-07-05T00:05:00.000Z',
      updatedAt: '2026-07-05T00:05:00.000Z',
    };
    const note = {
      id: 'note_1',
      novelId: 'wrong_book',
      bookId: 'wrong_book',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_5',
      quote: 'note quote',
      body: 'reader note',
      progress: 0.5,
      createdAt: '2026-07-05T00:06:00.000Z',
      updatedAt: '2026-07-05T00:06:00.000Z',
    };

    await expect(
      app.inject({ method: 'POST', url: '/api/books/book_1/bookmarks', payload: bookmark }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'POST', url: '/api/books/book_1/highlights', payload: highlight }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: 'POST', url: '/api/books/book_1/notes', payload: note })).resolves.toMatchObject({
      statusCode: 200,
    });

    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/bookmarks' })).json()).toMatchObject({
      bookmarks: [expect.objectContaining({ id: 'bookmark_1', label: '42%' })],
    });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/highlights' })).json()).toMatchObject({
      highlights: [expect.objectContaining({ id: 'highlight_1', quote: 'highlighted text' })],
    });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/notes' })).json()).toMatchObject({
      notes: [expect.objectContaining({ id: 'note_1', body: 'reader note' })],
    });

    const updatedNote = {
      ...note,
      body: 'reader note updated',
      updatedAt: '2026-07-05T00:07:00.000Z',
      expectedRevision: resourceEntityRevision('note', {
        id: note.id,
        novelId: 'book_1',
        chapterId: note.chapterId,
        paragraphId: note.paragraphId,
        quote: note.quote,
        body: note.body,
        progress: note.progress,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      }),
    };
    await expect(
      app.inject({ method: 'POST', url: '/api/books/book_1/notes', payload: updatedNote }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/notes' })).json()).toMatchObject({
      notes: [expect.objectContaining({ id: 'note_1', body: 'reader note updated' })],
    });
    const eventCountBeforeStaleNote = syncEvents.length;
    const staleNoteResponse = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/notes',
      payload: { ...note, body: 'stale note' },
    });
    expect(staleNoteResponse.json()).toEqual({ ok: true, applied: false });
    expect(notes.get(note.id)?.body).toBe('reader note updated');
    expect(syncEvents).toHaveLength(eventCountBeforeStaleNote);

    await expect(
      app.inject({
        method: 'DELETE',
        url: '/api/bookmarks/bookmark_1',
        payload: {
          expectedRevision: resourceEntityRevision('bookmark', {
            id: bookmark.id,
            novelId: 'book_1',
            chapterId: bookmark.chapterId,
            paragraphId: bookmark.paragraphId,
            label: bookmark.label,
            progress: bookmark.progress,
            scrollTop: bookmark.scrollTop,
            createdAt: bookmark.createdAt,
          }),
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: 'DELETE',
        url: '/api/highlights/highlight_1',
        payload: {
          expectedRevision: resourceEntityRevision('highlight', {
            id: highlight.id,
            novelId: 'book_1',
            chapterId: highlight.chapterId,
            paragraphId: highlight.paragraphId,
            quote: highlight.quote,
            color: highlight.color,
            progress: highlight.progress,
            createdAt: highlight.createdAt,
            updatedAt: highlight.updatedAt,
          }),
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: 'DELETE',
        url: '/api/notes/note_1',
        payload: {
          expectedRevision: resourceEntityRevision('note', {
            id: note.id,
            novelId: 'book_1',
            chapterId: note.chapterId,
            paragraphId: note.paragraphId,
            quote: note.quote,
            body: updatedNote.body,
            progress: note.progress,
            createdAt: note.createdAt,
            updatedAt: updatedNote.updatedAt,
          }),
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });

    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/bookmarks' })).json()).toEqual({ bookmarks: [] });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/highlights' })).json()).toEqual({
      highlights: [],
    });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/notes' })).json()).toEqual({ notes: [] });
    expect(syncEvents.map((event) => event.type)).toEqual([
      'bookmark_created',
      'highlight_created',
      'note_created',
      'note_updated',
      'bookmark_deleted',
      'highlight_deleted',
      'note_deleted',
    ]);
    expect(syncEvents.every((event) => event.bookId === 'book_1')).toBe(true);
    expect(syncEvents.map((event) => event.entityId)).toEqual([
      'bookmark_1',
      'highlight_1',
      'note_1',
      'note_1',
      'bookmark_1',
      'highlight_1',
      'note_1',
    ]);
    expect(syncEvents[0].payload).toMatchObject({
      bookmark: { id: 'bookmark_1', novelId: 'book_1', bookId: 'book_1', chapterId: 'chapter_1' },
    });
    expect(syncEvents[1].payload).toMatchObject({
      highlight: { id: 'highlight_1', novelId: 'book_1', bookId: 'book_1', paragraphId: 'paragraph_4' },
    });
    expect(syncEvents[2].payload).toMatchObject({
      note: { id: 'note_1', novelId: 'book_1', bookId: 'book_1', body: 'reader note' },
    });
    expect(syncEvents[3].payload).toMatchObject({
      note: { id: 'note_1', novelId: 'book_1', bookId: 'book_1', body: 'reader note updated' },
    });
    expect(syncEvents.slice(4).every((event) => typeof event.payload.deletedAt === 'string')).toBe(true);
    expect(syncEvents[0].revision).toMatchObject({
      entityType: 'bookmark',
      entityId: 'bookmark_1',
      novelId: 'book_1',
      updatedAt: bookmark.createdAt,
    });
    expect(syncEvents[1].revision).toMatchObject({
      entityType: 'highlight',
      entityId: 'highlight_1',
      novelId: 'book_1',
      updatedAt: highlight.updatedAt,
    });
    expect(syncEvents[2].revision).toMatchObject({
      entityType: 'note',
      entityId: 'note_1',
      novelId: 'book_1',
      updatedAt: note.updatedAt,
    });
    expect(syncEvents[3].revision).toMatchObject({
      entityType: 'note',
      entityId: 'note_1',
      novelId: 'book_1',
      updatedAt: updatedNote.updatedAt,
    });
    expect(syncEvents.slice(4).every((event) => typeof event.revision?.deletedAt === 'string')).toBe(true);
    expect(syncEvents.every((event) => event.revision?.localSequence === 0)).toBe(true);
    expect(syncEvents.every((event) => typeof event.revision?.payloadHash === 'string')).toBe(true);

    await app.close();
  });

  it('rejects direct reader mutations for missing server book or chapter before writes', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('insert into reading_positions')) {
          expect(sql).toContain('pg_advisory_xact_lock(hashtextextended($1, 7319))');
          expect(params?.[0]).toBe('missing_book');
          expect(params?.[1]).toBe('user_test');
          expect(params?.[2]).toBe('missing_chapter');
          return { rows: [{ chapter_found: false, applied: false, read_applied: false }] };
        }
        expect(sql).toContain('select exists(');
        expect(sql).toContain('from chapters c');
        expect(params?.[0]).toBe('missing_book');
        expect(params?.[1]).toBe('user_test');
        expect(params?.[2]).toBe('missing_chapter');
        return { rows: [{ exists: false }] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);
    const timestamp = '2026-07-05T00:08:00.000Z';

    const cases = [
      {
        method: 'PATCH',
        url: '/api/books/missing_book/reading-position',
        payload: { chapterId: 'missing_chapter', chapterProgress: 0.1, updatedAt: timestamp },
      },
      {
        method: 'POST',
        url: '/api/books/missing_book/bookmarks',
        payload: {
          id: 'bookmark_missing',
          chapterId: 'missing_chapter',
          label: 'Missing',
          progress: 0.1,
          scrollTop: 0,
          createdAt: timestamp,
        },
      },
      {
        method: 'POST',
        url: '/api/books/missing_book/highlights',
        payload: {
          id: 'highlight_missing',
          chapterId: 'missing_chapter',
          paragraphId: 'paragraph_missing',
          quote: 'Missing',
          color: 'yellow',
          progress: 0.1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      {
        method: 'POST',
        url: '/api/books/missing_book/notes',
        payload: {
          id: 'note_missing',
          chapterId: 'missing_chapter',
          body: 'Missing',
          progress: 0.1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    ] as const;

    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        payload: item.payload,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'book or chapter not found' });
    }
    expect(pool.query).toHaveBeenCalledTimes(cases.length);

    await app.close();
  });

  it('rejects malformed reader mutation payloads before database writes', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be touched for invalid payloads');
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const cases = [
      { method: 'PATCH', url: '/api/books/book_1', payload: { title: 123 } },
      {
        method: 'PATCH',
        url: '/api/books/book_1/reading-position',
        payload: { chapterId: 'chapter_1', chapterProgress: 2 },
      },
      { method: 'PUT', url: '/api/settings', payload: { theme: 'neon' } },
      {
        method: 'POST',
        url: '/api/books/book_1/bookmarks',
        payload: { chapterId: 'chapter_1', label: 'bad', progress: 0.5 },
      },
      {
        method: 'POST',
        url: '/api/books/book_1/highlights',
        payload: { id: 'h1', chapterId: 'chapter_1', paragraphId: 'p1', quote: 'bad', color: 'orange', progress: 0.5 },
      },
      { method: 'POST', url: '/api/books/book_1/notes', payload: { id: 'n1', chapterId: 'chapter_1', progress: 0.5 } },
    ] as const;

    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        payload: item.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty('error');
    }
    expect(pool.query).not.toHaveBeenCalled();

    await app.close();
  });
});
