import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { afterAll, describe, expect, it } from 'vitest';
import { registerAuthHook } from '../src/auth.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { ServerConfig } from '../src/config.js';
import { registerSelfHostAuthRoutes } from '../src/routes/auth.js';
import { registerBackupRoutes } from '../src/routes/backups.js';
import { registerReaderStateRoutes } from '../src/routes/books/reader-state-routes.js';
import { registerSyncRoutes } from '../src/routes/sync.js';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from '../src/services/self-host-auth-service.js';
import { FileObjectStore } from '../src/services/file-object-store.js';
import { startPostgresIntegrationHarness } from '../src/services/id-v2-migration/postgres-integration-harness.js';
import {
  bookmarkCreatedEvent,
  canonicalV2Event,
  readingPositionEvent,
  v2PushEnvelope,
} from '../src/routes/sync/sync-route-test-harness.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());

const USER_A = 'user_desktop';
const USER_B = 'user_dev';

function ownedEvent(event: SyncEvent, userId: string): SyncEvent {
  return {
    ...event,
    id: syncEventId({
      userId,
      deviceId: event.deviceId,
      type: event.type,
      novelId: event.novelId,
      entityId: event.entityId,
      seed: `peer-fixture:${event.id}`,
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

async function testServer(pool: pg.Pool, directory: string, token: string, userId: string, port = 0) {
  const config: ServerConfig = {
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
  const auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), userId);
  await registerAuthHook(app, config, auth);
  await registerSelfHostAuthRoutes(app, auth, config);
  await registerReaderStateRoutes(app, pool, config);
  await registerBackupRoutes(app, pool, config);
  await registerSyncRoutes(app, pool, config);
  const url = await app.listen({ host: '127.0.0.1', port });
  return { app, url, token, config };
}

async function withTwoDatabases(run: (poolA: pg.Pool, poolB: pg.Pool) => Promise<void>) {
  const names = ['a', 'b'].map((side) => `moya_peer_${side}_${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  const admin = new pg.Pool({ connectionString: harness!.url });
  const pools: pg.Pool[] = [];
  try {
    for (const name of names) await admin.query(`create database "${name}"`);
    for (const name of names) {
      const url = new URL(harness!.url);
      url.pathname = `/${name}`;
      pools.push(new pg.Pool({ connectionString: url.toString(), max: 4 }));
    }
    await run(pools[0], pools[1]);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    for (const name of names) await admin.query(`drop database if exists "${name}"`);
    await admin.end();
  }
}

describe.skipIf(!harness)('two server reading position sync', () => {
  it('seeds an empty peer from the existing streamed server backup and then syncs new positions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-peer-bootstrap-'));
    try {
      await withTwoDatabases(async (poolA, poolB) => {
        await fixtureBook(poolA, USER_A);
        await migrateDatabase(poolB);
        await poolB.query("insert into users (id,email,display_name) values ($1,'peer@example.com','Peer')", [USER_B]);
        const a = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
        let b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
        try {
          const account = await fetch(`${a.url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'long bootstrap password', setupCode: a.token }),
          });
          expect(account.status).toBe(201);
          const paired = await fetch(`${b.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: a.url,
              username: 'source',
              password: 'long bootstrap password',
              startFromNow: true,
              requireEmptyLibrary: true,
            }),
          });
          expect(paired.status).toBe(200);
          expect(await paired.json()).toMatchObject({ status: 'awaiting_bootstrap', bootstrapRequired: true });
          await b.app.close();
          b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
          // Closing the panel between pairing and copying must retain a durable retry state.
          const waiting = await fetch(`${b.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}` },
          });
          expect(await waiting.json()).toMatchObject({ status: 'awaiting_bootstrap', bootstrapRequired: true });
          const source = Buffer.from('Example text');
          const hash = `sha256:${createHash('sha256').update(source).digest('hex')}`;
          await poolA.query('update book_objects set raw_text_hash = $1, size_bytes = $2 where id = $3', [
            hash,
            source.length,
            'source_1',
          ]);
          const bootstrap = () =>
            fetch(`${b.url}/api/sync/peer/bootstrap`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${b.token}` },
            });
          await poolA.query('delete from self_host_sessions');
          expect((await bootstrap()).status).toBe(409);
          const pendingAuth = await fetch(`${b.url}/api/sync/peer`, {
            headers: { Authorization: `Bearer ${b.token}` },
          });
          expect(await pendingAuth.json()).toMatchObject({ status: 'needs_login', bootstrapRequired: true });
          const resumeAuth = await fetch(`${b.url}/api/sync/peer/reauthenticate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'long bootstrap password' }),
          });
          expect(await resumeAuth.json()).toMatchObject({ status: 'awaiting_bootstrap', bootstrapRequired: true });
          const missingSource = await bootstrap();
          expect(missingSource.status).toBe(409);
          expect((await poolB.query('select count(*)::int as count from library_books')).rows[0].count).toBe(0);
          await new FileObjectStore(a.config.objectStorageDir!).put('test', 'fixture/source', source, 'text/plain');
          const seeded = await bootstrap();
          expect(await seeded.json()).toMatchObject({ status: 'ready', restoredBooks: 1 });
          expect((await poolB.query('select count(*)::int as count from library_books')).rows[0].count).toBe(1);
          const object = (await poolB.query("select storage_key from book_objects where id='source_1'")).rows[0];
          const stored = await new FileObjectStore(b.config.objectStorageDir!).get('test', object.storage_key);
          const chunks: Buffer[] = [];
          for await (const chunk of stored.body) chunks.push(Buffer.from(chunk));
          const copied = Buffer.concat(chunks);
          expect(copied).toEqual(source);
          expect((await bootstrap()).status).toBe(409);
          const linkedPeer = (await poolB.query('select peer_id from sync_server_peers where user_id = $1', [USER_B]))
            .rows[0].peer_id;
          const reconnect = await fetch(`${b.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: a.url,
              username: 'source',
              password: 'long bootstrap password',
              startFromNow: true,
              requireEmptyLibrary: true,
            }),
          });
          expect(reconnect.status).toBe(409);
          expect(await reconnect.json()).toMatchObject({ error: 'peer_bootstrap_requires_empty_library' });
          expect(
            (await poolB.query('select peer_id from sync_server_peers where user_id = $1', [USER_B])).rows[0].peer_id,
          ).toBe(linkedPeer);

          const changed = await fetch(`${a.url}/api/books/book_1/reading-position`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chapterId: 'chapter_1',
              paragraphId: 'paragraph_1',
              chapterProgress: 0.5,
              scrollTop: 320,
              deviceId: 'source',
              updatedAt: '2026-09-24T05:00:00.000Z',
            }),
          });
          expect(await changed.json()).toMatchObject({ ok: true, applied: true });
          const beforeLogin = (await poolB.query('select * from sync_server_peers')).rows[0];
          await poolA.query('delete from self_host_sessions');
          const expired = await fetch(`${b.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}` },
          });
          expect(await expired.json()).toMatchObject({ status: 'needs_login' });
          const wrongPassword = await fetch(`${b.url}/api/sync/peer/reauthenticate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'incorrect password' }),
          });
          expect(wrongPassword.status).toBe(400);
          expect((await poolB.query('select * from sync_server_peers')).rows[0]).toMatchObject({
            peer_id: beforeLogin.peer_id,
            inbound_cursor: beforeLogin.inbound_cursor,
            outbound_cursor: beforeLogin.outbound_cursor,
            session_ciphertext: beforeLogin.session_ciphertext,
          });
          const loginAgain = await fetch(`${b.url}/api/sync/peer/reauthenticate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'long bootstrap password' }),
          });
          expect(loginAgain.status).toBe(200);
          const afterLogin = (await poolB.query('select * from sync_server_peers')).rows[0];
          expect(afterLogin).toMatchObject({
            peer_id: beforeLogin.peer_id,
            inbound_cursor: beforeLogin.inbound_cursor,
            outbound_cursor: beforeLogin.outbound_cursor,
          });
          const sync = await fetch(`${b.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}` },
          });
          const syncState = await sync.json();
          expect(syncState, JSON.stringify(syncState)).toMatchObject({ status: 'ready' });
          expect(
            (await poolB.query("select scroll_top from reading_positions where book_id='book_1'")).rows[0].scroll_top,
          ).toBe(320);
        } finally {
          await a.app.close();
          await b.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('commits a local position and its event together, and rejects a changed replay', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-position-atomic-'));
    try {
      await withTwoDatabases(async (pool) => {
        await fixtureBook(pool, USER_A);
        const server = await testServer(pool, directory, 'native_a', USER_A);
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

  it('pairs with an account session and exchanges new positions in both directions across a restart', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-peer-sync-'));
    try {
      await withTwoDatabases(async (poolA, poolB) => {
        await fixtureBook(poolA, USER_A);
        await fixtureBook(poolB, USER_B);
        const a = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
        let b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
        try {
          const register = await fetch(`${b.url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'peer', password: 'long peer test password', setupCode: b.token }),
          });
          expect(register.status).toBe(201);
          const cookie = register.headers.get('set-cookie')!.split(';', 1)[0];
          const unsafeUrl = await fetch(`${a.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'http://192.0.2.1',
              username: 'peer',
              password: 'long peer test password',
              startFromNow: true,
            }),
          });
          expect(unsafeUrl.status).toBe(400);
          expect(await unsafeUrl.json()).toEqual({ error: 'invalid_peer_url' });
          const pair = await fetch(`${a.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: b.url,
              username: 'peer',
              password: 'long peer test password',
              startFromNow: true,
            }),
          });
          expect(pair.status).toBe(200);
          expect(await pair.json()).toMatchObject({ outboundCursor: 0, inboundCursor: 0, status: 'ready' });
          const secret = await poolA.query('select session_ciphertext from sync_server_peers');
          expect(secret.rows[0].session_ciphertext).not.toContain('moya_session');

          const writeA = await fetch(`${a.url}/api/books/book_1/reading-position`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chapterId: 'chapter_1',
              paragraphId: 'paragraph_1',
              paragraphIndex: 12,
              offsetInParagraph: 3,
              chapterProgress: 0.42,
              scrollTop: 240,
              deviceId: 'device_a',
              updatedAt: '2026-09-24T01:00:00.000Z',
            }),
          });
          expect(await writeA.json()).toMatchObject({ ok: true, applied: true });
          const identities = await Promise.all([
            fetch(`${a.url}/api/sync/book-identity/book_1`, { headers: { Authorization: `Bearer ${a.token}` } }).then(
              (r) => r.json(),
            ),
            fetch(`${b.url}/api/sync/book-identity/book_1`, { headers: { Cookie: cookie } }).then((r) => r.json()),
          ]);
          expect(identities[0], JSON.stringify(identities)).toEqual(identities[1]);
          const firstRun = await fetch(`${a.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}` },
          });
          const firstState = await firstRun.json();
          expect(firstState, JSON.stringify(firstState)).toMatchObject({
            status: 'ready',
            outboundCursor: 1,
            inboundCursor: 1,
          });
          expect(
            (await poolB.query("select chapter_id from reading_positions where book_id='book_1'")).rows[0],
          ).toMatchObject({ chapter_id: 'chapter_1' });

          const peerPort = Number(new URL(b.url).port);
          await b.app.close();
          const offlineRun = await fetch(`${a.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}` },
          });
          expect(await offlineRun.json()).toMatchObject({ status: 'offline', lastError: 'peer_unreachable' });
          b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B, peerPort);
          const recoveredRun = await fetch(`${a.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}` },
          });
          expect(await recoveredRun.json()).toMatchObject({ status: 'ready' });

          await a.app.close();
          const restarted = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
          try {
            const bPosition = ownedEvent(readingPositionEvent('peer_b_position', '2026-09-24T02:00:00.000Z'), USER_B);
            const pushB = await fetch(`${b.url}/api/sync/events`, {
              method: 'POST',
              headers: { Cookie: cookie, 'Content-Type': 'application/json' },
              body: JSON.stringify(v2PushEnvelope([bPosition])),
            });
            expect((await pushB.json()).acceptedIds).toEqual([bPosition.id]);
            const secondRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await secondRun.json()).toMatchObject({ status: 'ready', outboundCursor: 1, inboundCursor: 2 });
            expect(
              (
                await poolA.query("select updated_at from reading_positions where book_id='book_1'")
              ).rows[0].updated_at.toISOString(),
            ).toBe('2026-09-24T02:00:00.000Z');
            const replay = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect((await replay.json()).status).toBe('ready');

            const deletedAt = '2026-09-24T02:30:00.000Z';
            const deleted = ownedEvent(
              canonicalV2Event({
                id: 'peer_b_position_deleted',
                type: 'reading_position_deleted',
                deviceId: 'device_b',
                novelId: 'book_1',
                entityId: 'reading_position_book_1',
                payload: { id: 'reading_position_book_1', bookId: 'book_1', deletedAt },
                createdAt: deletedAt,
              }),
              USER_B,
            );
            const pushedDelete = await fetch(`${b.url}/api/sync/events`, {
              method: 'POST',
              headers: { Cookie: cookie, 'Content-Type': 'application/json' },
              body: JSON.stringify(v2PushEnvelope([deleted])),
            });
            expect((await pushedDelete.json()).acceptedIds).toEqual([deleted.id]);
            const deletedRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            const peerWatermark = Number(
              (await poolB.query('select max(sequence) as cursor from sync_events')).rows[0].cursor,
            );
            expect(await deletedRun.json()).toMatchObject({ status: 'ready', inboundCursor: peerWatermark });
            expect((await poolA.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
            expect((await poolB.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
            const deletedReplay = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await deletedReplay.json()).toMatchObject({ status: 'ready' });

            const pairedAgain = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            }).then((response) => response.json());
            const aConflict = ownedEvent(readingPositionEvent('peer_a_conflict', '2026-09-24T03:00:00.000Z'), USER_A);
            const bBase = ownedEvent(readingPositionEvent('peer_b_conflict', '2026-09-24T03:00:00.000Z'), USER_B);
            const bPayload = {
              position: { ...(bBase.payload as { position: Record<string, unknown> }).position, scrollTop: 777 },
            };
            const bConflict = {
              ...bBase,
              payload: bPayload,
              revision: bBase.revision
                ? { ...bBase.revision, payloadHash: syncPayloadIntegrityHash(bPayload) }
                : undefined,
            };
            for (const [server, headers, event] of [
              [restarted, { Authorization: `Bearer ${restarted.token}` }, aConflict],
              [b, { Cookie: cookie }, bConflict],
            ] as const) {
              const pushed = await fetch(`${server.url}/api/sync/events`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(v2PushEnvelope([event])),
              });
              expect((await pushed.json()).acceptedIds).toEqual([event.id]);
            }
            const conflictRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await conflictRun.json()).toMatchObject({
              status: 'blocked',
              lastError: 'peer_stale_or_conflicting_position',
              outboundCursor: pairedAgain.outboundCursor,
              inboundCursor: pairedAgain.inboundCursor,
            });
            expect(
              (await poolA.query("select scroll_top from reading_positions where book_id='book_1'")).rows[0].scroll_top,
            ).toBe(240);
            expect(
              (await poolB.query("select scroll_top from reading_positions where book_id='book_1'")).rows[0].scroll_top,
            ).toBe(777);

            const unsupportedBaseline = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            }).then((response) => response.json());
            const bookmark = ownedEvent(
              bookmarkCreatedEvent('peer_unsupported_bookmark', '2026-09-24T04:00:00.000Z'),
              USER_A,
            );
            const pushedBookmark = await fetch(`${restarted.url}/api/sync/events`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(v2PushEnvelope([bookmark])),
            });
            expect((await pushedBookmark.json()).acceptedIds).toEqual([bookmark.id]);
            const unsupportedRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await unsupportedRun.json()).toMatchObject({
              status: 'blocked',
              lastError: 'peer_event_type_unsupported',
              outboundCursor: unsupportedBaseline.outboundCursor,
              inboundCursor: unsupportedBaseline.inboundCursor,
            });
            expect((await poolB.query('select count(*)::int as count from bookmarks')).rows[0].count).toBe(0);

            const reauthenticated = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            });
            expect(reauthenticated.status).toBe(200);
            await poolB.query('delete from self_host_sessions');
            const expiredRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await expiredRun.json()).toMatchObject({ status: 'needs_login', lastError: 'peer_auth_required' });

            const rePairBeforeShutdown = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            });
            expect(rePairBeforeShutdown.status).toBe(200);
            const hangingPort = Number(new URL(b.url).port);
            await b.app.close();
            let requestArrived: () => void = () => undefined;
            const requestStarted = new Promise<void>((resolve) => {
              requestArrived = resolve;
            });
            const hanging = createServer(() => requestArrived());
            await new Promise<void>((resolve) => hanging.listen(hangingPort, '127.0.0.1', resolve));
            try {
              const pending = fetch(`${restarted.url}/api/sync/peer/run`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${restarted.token}` },
              }).catch(() => undefined);
              await Promise.race([
                requestStarted,
                delay(2_000).then(() => {
                  throw new Error('peer request never started');
                }),
              ]);
              const shutdownStarted = Date.now();
              await restarted.app.close();
              expect(Date.now() - shutdownStarted).toBeLessThan(2_000);
              await pending;
            } finally {
              hanging.closeAllConnections();
              await new Promise<void>((resolve) => hanging.close(() => resolve()));
            }
          } finally {
            await restarted.app.close();
          }
        } finally {
          await a.app.close();
          await b.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
