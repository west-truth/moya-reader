import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { syncEventId } from '@noveldesk/text-core/identity/sync';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { afterAll, describe, expect, it } from 'vitest';
import { registerAuthHook } from '../src/auth.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { ServerConfig } from '../src/config.js';
import { registerReaderStateRoutes } from '../src/routes/books/reader-state-routes.js';
import { registerSyncRoutes } from '../src/routes/sync.js';
import { startPostgresIntegrationHarness } from '../src/services/id-v2-migration/postgres-integration-harness.js';
import { canonicalV2Event, v2PushEnvelope } from '../src/routes/sync/sync-route-test-harness.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());
const USER_ID = 'user_desktop';

function ownedEvent(event: SyncEvent, userId: string): SyncEvent {
  return {
    ...event,
    id: syncEventId({
      userId,
      deviceId: event.deviceId,
      type: event.type,
      novelId: event.novelId,
      entityId: event.entityId,
      seed: `client-fixture:${event.id}`,
    }),
  };
}

async function fixtureBook(pool: pg.Pool, userId: string) {
  await migrateDatabase(pool);
  await pool.query("insert into users (id,email,display_name) values ($1,'reader@example.com','Reader')", [userId]);
  await pool.query(
    `insert into book_objects (id,raw_text_hash,storage_key,file_name,content_type,size_bytes)
     values ('source_1','sha256:fixture','fixture/source','book.txt','text/plain',12)`,
  );
  await pool.query(
    `insert into library_books (
       id,user_id,object_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs
     ) values ('book_1',$1,'source_1','Same Book','book.txt','sha256:normalized',1,12,1)`,
    [userId],
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query("update book_content_revisions set id = 'revision_1' where book_id = 'book_1'");
    await client.query("update library_books set active_content_revision_id = 'revision_1' where id = 'book_1'");
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    `insert into chapters (
       id,book_id,chapter_index,title,text_hash,raw_start_offset,raw_end_offset,character_count,paragraph_count
     ) values ('chapter_1','book_1',1,'Chapter','sha256:chapter',0,12,12,1)`,
  );
  await pool.query(
    `insert into paragraph_pages (
       id,book_id,chapter_id,page_index,start_paragraph_index,end_paragraph_index,paragraphs,text_hash
     ) values ('page_1','book_1','chapter_1',0,0,0,$1::jsonb,'sha256:page')`,
    [JSON.stringify([{ id: 'paragraph_1', index: 0, text: 'Text' }])],
  );
  await pool.query(
    `insert into paragraph_search (
       id,paragraph_id,book_id,chapter_id,page_index,paragraph_index,text,text_lower,paragraph
     ) values ('search_1','paragraph_1','book_1','chapter_1',0,0,'Text','text','{}'::jsonb)`,
  );
}

async function testServer(
  pool: pg.Pool,
  directory: string,
  token: string,
  userId: string,
  port = 0,
  override?: ServerConfig,
) {
  const config: ServerConfig = override
    ? { ...override, authToken: token }
    : {
        host: '127.0.0.1',
        port: 0,
        databaseUrl: '',
        redisUrl: '',
        dataDir: directory,
        objectStorageDir: path.join(directory, 'objects'),
        authToken: token,
        maxChunkBytes: 1024,
        maxUploadBytes: 1024,
        staleUploadMaxAgeMs: 1000,
        runMigrationsOnStart: false,
        defaultUserId: userId,
        s3: {
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          bucket: 'test',
          accessKeyId: 'test',
          secretAccessKey: 'test',
          forcePathStyle: true,
        },
      };
  const app = Fastify({ logger: false });
  await registerAuthHook(app, config);
  await registerReaderStateRoutes(app, pool, config);
  await registerSyncRoutes(app, pool, config);
  const url = await app.listen({ host: '127.0.0.1', port });
  return { app, url, token, config };
}

async function withDatabase(run: (pool: pg.Pool) => Promise<void>) {
  const names = ['a'].map((side) => `moya_client_${side}_${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  const admin = new pg.Pool({ connectionString: harness!.url });
  const pools: pg.Pool[] = [];
  try {
    for (const name of names) await admin.query(`create database "${name}"`);
    for (const name of names) {
      const url = new URL(harness!.url);
      url.pathname = `/${name}`;
      pools.push(new pg.Pool({ connectionString: url.toString(), max: 4 }));
    }
    await run(pools[0]);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    for (const name of names) await admin.query(`drop database if exists "${name}"`);
    await admin.end();
  }
}

describe.skipIf(!harness)('single-server sync consistency', () => {
  it('accepts ordinary client notes and rejects edits or deletes under another book', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-client-notes-'));
    try {
      await withDatabase(async (pool) => {
        await fixtureBook(pool, USER_ID);
        await pool.query(
          `insert into library_books
          (id,user_id,object_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs)
          values ('book_other',$1,'source_1','Other','other.txt','sha256:other',1,12,1)`,
          [USER_ID],
        );
        await pool.query(`insert into chapters
          (id,book_id,chapter_index,title,text_hash,raw_start_offset,raw_end_offset,character_count,paragraph_count)
          values ('chapter_other','book_other',1,'Other','sha256:other',0,12,12,1)`);
        const server = await testServer(pool, directory, 'native_a', USER_ID);
        try {
          const now = new Date(Date.now() + 60_000).toISOString();
          const note = {
            id: 'note_client',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            body: 'Keep this note',
            progress: 0,
            createdAt: now,
            updatedAt: now,
          };
          const send = async (
            type: 'note_created' | 'note_updated' | 'note_deleted',
            novelId: string,
            payload: SyncEvent['payload'],
          ) => {
            const event = ownedEvent(
              canonicalV2Event({
                id: randomUUID(),
                type,
                novelId,
                entityId: note.id,
                deviceId: 'browser',
                payload,
                createdAt: now,
              }),
              USER_ID,
            );
            const response = await server.app.inject({
              method: 'POST',
              url: '/api/sync/events',
              headers: { authorization: `Bearer ${server.token}` },
              payload: v2PushEnvelope([event]),
            });
            expect(response.statusCode).toBe(200);
            return response.json();
          };
          expect(await send('note_created', 'book_1', { note })).toMatchObject({ accepted: 1 });
          expect(
            await send('note_updated', 'book_other', {
              note: { ...note, novelId: 'book_other', chapterId: 'chapter_other', body: 'Wrong book' },
            }),
          ).toMatchObject({ accepted: 0, rejected: [{ reason: 'stale' }] });
          expect(await send('note_deleted', 'book_other', { id: note.id, deletedAt: now })).toMatchObject({
            accepted: 0,
            rejected: [{ reason: 'stale' }],
          });
          expect((await pool.query('select book_id,body,deleted_at from notes where id=$1', [note.id])).rows).toEqual([
            { book_id: 'book_1', body: note.body, deleted_at: null },
          ]);
          expect(await send('note_deleted', 'book_1', { id: note.id, deletedAt: now })).toMatchObject({ accepted: 1 });
          expect(
            (await pool.query('select deleted_at from notes where id=$1', [note.id])).rows[0].deleted_at,
          ).not.toBeNull();
        } finally {
          await server.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not skip an earlier event when transactions commit in the opposite sequence order', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-client-cursor-'));
    try {
      await withDatabase(async (pool) => {
        await fixtureBook(pool, USER_ID);
        const server = await testServer(pool, directory, 'native_a', USER_ID);
        const writer = await pool.connect();
        let pending: Promise<{ cursor: number; events: Array<{ id: string }> }> | undefined;
        try {
          const event = (id: string) =>
            ownedEvent(
              canonicalV2Event({
                id,
                type: 'book_imported',
                deviceId: 'server',
                novelId: 'book_1',
                entityId: 'book_1',
                payload: { bookId: 'book_1' },
                createdAt: '2026-09-24T00:00:00.000Z',
              }),
              USER_ID,
            );
          const earlier = event('earlier');
          const later = event('later');
          const sql = `insert into sync_events (id,user_id,type,book_id,entity_id,payload,created_at,id_contract,hash_contract)
            values ($1,$2,'book_imported','book_1','book_1',$3,$4,'v2-sha256-128','v2-sha256-tagged')`;
          const args = (e: SyncEvent) => [e.id, USER_ID, JSON.stringify(e.payload), e.createdAt];
          await writer.query('begin');
          await writer.query(sql, args(earlier));
          await pool.query(sql, args(later));
          const pull = async (since: number) => {
            const response = await fetch(
              `${server.url}/api/sync?since=${since}&contractVersion=2&idContract=v2-sha256-128&hashContract=v2-sha256-tagged`,
              {
                headers: { Authorization: `Bearer ${server.token}` },
              },
            );
            expect(response.status).toBe(200);
            return response.json() as Promise<{ cursor: number; events: Array<{ id: string }> }>;
          };
          let settled = false;
          pending = pull(0).finally(() => {
            settled = true;
          });
          // Either the old SELECT returns too early, or the fixed pull queues its
          // table read lock behind the uncommitted writer. Do not rely on sleeps.
          const deadline = Date.now() + 3_000;
          while (!settled) {
            const queued = await pool.query(
              "select 1 from pg_locks where relation='sync_events'::regclass and mode='ShareLock' and not granted",
            );
            if (queued.rows.length) break;
            if (Date.now() > deadline) throw new Error('Sync pull did not reach its snapshot boundary');
            await delay(10);
          }
          await writer.query('commit');
          const first = await pending;
          const second = await pull(first.cursor);
          expect([...first.events, ...second.events].map((row) => row.id)).toEqual([earlier.id, later.id]);
        } finally {
          await writer.query('rollback');
          writer.release();
          await pending?.catch(() => undefined);
          await server.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('commits a local position and its event together, and rejects a changed replay', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-position-atomic-'));
    try {
      await withDatabase(async (pool) => {
        await fixtureBook(pool, USER_ID);
        const server = await testServer(pool, directory, 'native_a', USER_ID);
        try {
          const position = {
            chapterId: 'chapter_1',
            paragraphId: 'paragraph_1',
            chapterProgress: 0.25,
            scrollTop: 120,
            deviceId: 'device_a',
            updatedAt: '2026-09-24T01:00:00.000Z',
          };
          const request = (method: 'PATCH' | 'DELETE', body: Record<string, unknown>) =>
            fetch(`${server.url}/api/books/book_1/reading-position`, {
              method,
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          const rejectEvent = async () => {
            await pool.query(`create function reject_position_event() returns trigger language plpgsql as $$
              begin raise exception 'injected event write failure'; end $$`);
            await pool.query(`create trigger reject_position_event before insert on sync_events
              for each row execute function reject_position_event()`);
          };
          const allowEvent = async () => {
            await pool.query('drop trigger reject_position_event on sync_events');
            await pool.query('drop function reject_position_event()');
          };
          await rejectEvent();
          expect((await request('PATCH', position)).status).toBe(500);
          expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
          await allowEvent();

          expect((await request('PATCH', position)).status).toBe(200);
          expect((await request('PATCH', position)).status).toBe(200);
          expect(
            (await pool.query("select count(*)::int as count from sync_events where type='reading_position_updated'"))
              .rows[0].count,
          ).toBe(1);
          expect((await request('PATCH', { ...position, scrollTop: 777 })).status).toBe(409);
          expect((await pool.query('select scroll_top from reading_positions')).rows[0].scroll_top).toBe(120);

          await rejectEvent();
          const deletion = { deviceId: 'device_a', updatedAt: '2026-09-24T02:00:00.000Z' };
          expect((await request('DELETE', deletion)).status).toBe(500);
          expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(1);
          await allowEvent();
          expect((await request('DELETE', deletion)).status).toBe(200);
          expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
          expect(
            (await pool.query("select count(*)::int as count from sync_events where type='reading_position_deleted'"))
              .rows[0].count,
          ).toBe(1);
          // Both requests wait behind the same lock. The later PATCH must read the
          // DELETE tombstone committed while it was waiting, not its old statement snapshot.
          await request('PATCH', { ...position, updatedAt: '2026-09-24T03:00:00.000Z' });
          const blocker = await pool.connect();
          const pending: Array<Promise<Response>> = [];
          try {
            await blocker.query('begin');
            await blocker.query("select pg_advisory_xact_lock(hashtextextended('book_1', 7319))");
            const waitQueued = async (count: number) => {
              const deadline = Date.now() + 3_000;
              while (Date.now() < deadline) {
                const result = await pool.query(
                  "select count(*)::int as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())",
                );
                if (result.rows[0].n >= count) return;
                await delay(10);
              }
              throw new Error('Reading position requests did not queue behind the test lock');
            };
            pending.push(request('DELETE', { deviceId: 'device_a', updatedAt: '2026-09-24T05:00:00.000Z' }));
            await waitQueued(1);
            pending.push(request('PATCH', { ...position, updatedAt: '2026-09-24T04:00:00.000Z' }));
            await waitQueued(2);
            await blocker.query('commit');
            const [deleted, staleWrite] = await Promise.all(pending);
            expect(deleted.status).toBe(200);
            expect(await staleWrite.json()).toMatchObject({ applied: false });
            expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
          } finally {
            await blocker.query('rollback');
            blocker.release();
            await Promise.allSettled(pending);
          }
        } finally {
          await server.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
