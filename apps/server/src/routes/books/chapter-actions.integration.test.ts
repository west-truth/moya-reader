import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import type { ServerConfig } from '../../config.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../../services/id-v2-migration/postgres-integration-harness.js';
import { registerChapterReadRoutes } from './chapter-read-routes.js';

const harness = await startPostgresIntegrationHarness();
(harness ? describe : describe.skip)('chapter actions with isolated PostgreSQL', () => {
  afterAll(async () => harness?.stop());
  test('marks exact/prior chapters and renames without moving resume or changing chapter identity', async () => {
    await withPostgresSchema(harness!, 'chapter_actions', async (pool) => {
      await pool.query(`
        create table library_books (id text primary key, user_id text, deleted_at timestamptz, active_content_revision_id text);
        create table chapters (id text primary key, book_id text, chapter_index integer, title text, document_section_id text, updated_at timestamptz);
        create table fixed_document_section_read_states (book_id text, user_id text, document_section_id text, last_read_at timestamptz, primary key(book_id,user_id,document_section_id));
        create table reading_positions (book_id text, chapter_id text, progress float);
        insert into library_books values ('book','a',null,'rev');
        insert into chapters values ('one','book',1,'One',null,now()),('two','book',2,'Two',null,now()),('three','book',3,'Three',null,now());
        insert into reading_positions values ('book','two',0.5);
      `);
      const a = Fastify(),
        b = Fastify();
      registerChapterReadRoutes(a, pool, { defaultUserId: 'a' } as ServerConfig);
      registerChapterReadRoutes(b, pool, { defaultUserId: 'b' } as ServerConfig);
      const request = {
        method: 'POST' as const,
        url: '/api/books/book/chapters/read',
        payload: { chapterId: 'three', previous: true, expectedContentRevisionId: 'rev' },
      };
      try {
        expect((await b.inject(request)).statusCode).toBe(409);
        expect(
          (await a.inject({ ...request, payload: { ...request.payload, expectedContentRevisionId: 'stale' } }))
            .statusCode,
        ).toBe(409);
        expect((await a.inject(request)).statusCode).toBe(200);
        expect(
          (
            await pool.query(
              'select document_section_id from fixed_document_section_read_states order by document_section_id',
            )
          ).rows,
        ).toEqual([{ document_section_id: 'one' }, { document_section_id: 'two' }]);
        expect((await a.inject({ ...request, payload: { ...request.payload, previous: false } })).statusCode).toBe(200);
        const rename = {
          method: 'PATCH' as const,
          url: '/api/books/book/chapters/two',
          payload: { title: '  Changed  ', expectedContentRevisionId: 'rev' },
        };
        expect((await b.inject(rename)).statusCode).toBe(409);
        expect((await a.inject(rename)).statusCode).toBe(200);
        expect((await pool.query("select title from chapters where id='two'")).rows[0].title).toBe('Changed');
        expect((await pool.query('select * from reading_positions')).rows).toEqual([
          { book_id: 'book', chapter_id: 'two', progress: 0.5 },
        ]);
      } finally {
        await a.close();
        await b.close();
      }
    });
  });
});
