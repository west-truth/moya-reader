import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import { validateV2SyncEvent } from '../../../../../src/sync/event-contract-validation.js';
import { SELF_HOST_SESSION_COOKIE } from '../../auth-cookie.js';
import type { ServerConfig } from '../../config.js';
import { loadProviderSecretMasterKey } from '../../providers/server-provider-secrets.js';
import { querySyncEventsAfter } from './pull-query.js';
import { applySyncEventsInTransaction } from './push-route.js';
import { mapSyncEventRow } from './row-mappers.js';

const PEER_KEY_VERSION = 'local-aes-256-gcm-v1';
const MAX_PEER_RESPONSE_BYTES = 4 * 1024 * 1024;
const PEER_POLL_INTERVAL_MS = 15_000;
const SUPPORTED_TYPES = new Set(['reading_position_updated', 'reading_position_deleted']);

interface PeerRow {
  user_id: string;
  peer_id: string;
  peer_url: string;
  peer_server_id: string;
  session_ciphertext: string;
  session_iv: string;
  session_auth_tag: string;
  session_key_version: string;
  outbound_cursor: number | string;
  inbound_cursor: number | string;
  status: string;
  last_error: string | null;
  last_synced_at: Date | string | null;
}

interface BookIdentity {
  bookId: string;
  sourceHash: string;
  activeRevisionId: string;
  normalizedTextHash: string;
  chapterIds: string[];
}

interface PullResponse {
  contractVersion: number;
  idContract: string;
  hashContract: string;
  cursor: number;
  events: Array<Record<string, unknown>>;
}

class PeerSyncFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: 'offline' | 'needs_login' | 'blocked',
  ) {
    super(code);
  }
}

function peerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new PeerSyncFailure('invalid_peer_url', 'blocked');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PeerSyncFailure('invalid_peer_url', 'blocked');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new PeerSyncFailure('invalid_peer_url', 'blocked');
  }
  return url.origin;
}

function encryptedSession(key: Buffer, userId: string, peerId: string, cookie: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`peer-sync:${userId}:${peerId}`));
  const ciphertext = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptedSession(key: Buffer, row: PeerRow): string {
  if (row.session_key_version !== PEER_KEY_VERSION)
    throw new PeerSyncFailure('peer_key_version_unsupported', 'blocked');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.session_iv, 'base64'));
  decipher.setAAD(Buffer.from(`peer-sync:${row.user_id}:${row.peer_id}`));
  decipher.setAuthTag(Buffer.from(row.session_auth_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.session_ciphertext, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

async function peerRequest(
  baseUrl: string,
  resource: string,
  cookie: string | undefined,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<{ body: unknown; setCookie: string | null }> {
  let response: Response;
  try {
    response = await fetch(new URL(resource, baseUrl), {
      method: options.method ?? 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PeerSyncFailure('peer_unreachable', 'offline');
  }
  if (response.status === 401 || response.status === 403)
    throw new PeerSyncFailure('peer_auth_required', 'needs_login');
  if (!response.ok)
    throw new PeerSyncFailure(`peer_http_${response.status}`, response.status === 404 ? 'blocked' : 'offline');
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > MAX_PEER_RESPONSE_BYTES) throw new PeerSyncFailure('peer_response_too_large', 'blocked');
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_PEER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PeerSyncFailure('peer_response_too_large', 'blocked');
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    if (error instanceof PeerSyncFailure) throw error;
    throw new PeerSyncFailure('peer_response_interrupted', 'offline');
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new PeerSyncFailure('peer_invalid_response', 'blocked');
    }
    return { body, setCookie: response.headers.get('set-cookie') };
  } catch {
    throw new PeerSyncFailure('peer_invalid_response', 'blocked');
  }
}

function sessionCookie(header: string | null): string {
  const first = header?.split(';', 1)[0] ?? '';
  if (!first.startsWith(`${SELF_HOST_SESSION_COOKIE}=`)) {
    throw new PeerSyncFailure('peer_session_missing', 'needs_login');
  }
  return first;
}

async function serverId(pool: pg.Pool): Promise<string> {
  await pool.query(
    `insert into sync_server_identity (singleton, server_id) values (true, $1)
     on conflict (singleton) do nothing`,
    [randomUUID()],
  );
  const result = await pool.query<{ server_id: string }>(
    'select server_id from sync_server_identity where singleton = true',
  );
  return result.rows[0].server_id;
}

async function watermark(pool: pg.Pool, userId: string): Promise<number> {
  const result = await pool.query<{ cursor: string }>(
    'select coalesce(max(sequence), 0)::text as cursor from sync_events where user_id = $1',
    [userId],
  );
  const cursor = Number(result.rows[0].cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new PeerSyncFailure('peer_cursor_invalid', 'blocked');
  return cursor;
}

async function bookIdentity(pool: pg.Pool, userId: string, bookId: string): Promise<BookIdentity | undefined> {
  const result = await pool.query<{
    id: string;
    source_hash: string | null;
    active_revision_id: string | null;
    normalized_text_hash: string;
    chapter_ids: string[];
  }>(
    `select b.id, o.raw_text_hash as source_hash, b.active_content_revision_id as active_revision_id,
            b.normalized_text_hash,
            coalesce(array_agg(c.id order by c.chapter_index) filter (where c.id is not null), '{}'::text[]) as chapter_ids
       from library_books b
       left join book_objects o on o.id = b.object_id
       left join chapters c on c.book_id = b.id
      where b.id = $1 and b.user_id = $2 and b.deleted_at is null
      group by b.id, o.raw_text_hash`,
    [bookId, userId],
  );
  const row = result.rows[0];
  if (!row?.source_hash || !row.active_revision_id || !row.chapter_ids.length) return undefined;
  return {
    bookId: row.id,
    sourceHash: row.source_hash,
    activeRevisionId: row.active_revision_id,
    normalizedTextHash: row.normalized_text_hash,
    chapterIds: row.chapter_ids,
  };
}

function readPeerEvent(row: Record<string, unknown>): SyncEvent {
  const event: SyncEvent = {
    contractVersion: row.contractVersion as 2,
    idContract: row.idContract as SyncEvent['idContract'],
    hashContract: row.hashContract as SyncEvent['hashContract'],
    sequence: Number(row.sequence),
    id: String(row.id ?? ''),
    deviceId: String(row.device_id ?? ''),
    type: row.type as SyncEvent['type'],
    novelId: typeof row.book_id === 'string' ? row.book_id : undefined,
    entityId: typeof row.entity_id === 'string' ? row.entity_id : undefined,
    payload: row.payload as SyncEvent['payload'],
    revision: (row.revision ?? undefined) as SyncEvent['revision'],
    createdAt: String(row.created_at ?? ''),
  };
  validateV2SyncEvent(event);
  return event;
}

function assertSupportedEvents(events: readonly SyncEvent[]): void {
  if (events.some((event) => !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1)) {
    throw new PeerSyncFailure('peer_cursor_invalid', 'blocked');
  }
  if (events.some((event) => !SUPPORTED_TYPES.has(event.type))) {
    throw new PeerSyncFailure('peer_event_type_unsupported', 'blocked');
  }
  if (events.some((event) => !event.novelId || event.contractVersion !== 2)) {
    throw new PeerSyncFailure('peer_event_contract_unsupported', 'blocked');
  }
}

async function assertMatchingBooks(
  pool: pg.Pool,
  userId: string,
  row: PeerRow,
  cookie: string,
  events: SyncEvent[],
  signal: AbortSignal,
) {
  for (const bookId of new Set(events.map((event) => event.novelId!))) {
    const local = await bookIdentity(pool, userId, bookId);
    const remote = (
      await peerRequest(row.peer_url, `/api/sync/book-identity/${encodeURIComponent(bookId)}`, cookie, { signal })
    ).body as BookIdentity;
    if (!local || JSON.stringify(local) !== JSON.stringify(remote)) {
      throw new PeerSyncFailure('peer_book_identity_mismatch', 'blocked');
    }
  }
}

async function loadPeer(pool: pg.Pool, userId: string): Promise<PeerRow | undefined> {
  const result = await pool.query<PeerRow>('select * from sync_server_peers where user_id = $1', [userId]);
  return result.rows[0];
}

function publicPeer(row: PeerRow | undefined) {
  return row
    ? {
        url: row.peer_url,
        serverId: row.peer_server_id,
        outboundCursor: Number(row.outbound_cursor),
        inboundCursor: Number(row.inbound_cursor),
        status: row.status,
        lastError: row.last_error,
        lastSyncedAt: row.last_synced_at,
        scope: 'matching_books_new_reading_positions_only',
      }
    : { configured: false };
}

export function registerPeerReadingPositionRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): void {
  const userId = config.defaultUserId;
  const key = () => loadProviderSecretMasterKey(config, process.env);
  let running: Promise<void> | undefined;
  let activeAbort: AbortController | undefined;
  let configuring = false;

  const execute = () => {
    if (configuring) return Promise.resolve();
    if (running) return running;
    activeAbort = new AbortController();
    const timeout = setTimeout(() => activeAbort?.abort(), 60_000);
    timeout.unref();
    running = runOnce(activeAbort.signal)
      .catch((error) => {
        app.log.warn(
          { code: error instanceof PeerSyncFailure ? error.code : 'internal_error' },
          'peer_reading_sync_failed',
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        activeAbort = undefined;
        running = undefined;
      });
    return running;
  };

  async function runOnce(signal: AbortSignal): Promise<void> {
    const row = await loadPeer(pool, userId);
    if (!row || row.status === 'blocked' || row.status === 'needs_login') return;
    try {
      const cookie = decryptedSession(key(), row);
      const identity = (await peerRequest(row.peer_url, '/api/sync/identity', cookie, { signal })).body as {
        serverId?: string;
      };
      if (identity.serverId !== row.peer_server_id)
        throw new PeerSyncFailure('peer_server_identity_changed', 'blocked');

      const client = await pool.connect();
      let outbound: SyncEvent[];
      try {
        const rows = await querySyncEventsAfter(client, userId, Number(row.outbound_cursor));
        outbound = rows.map(mapSyncEventRow);
      } finally {
        client.release();
      }
      assertSupportedEvents(outbound);
      if (outbound.length) {
        await assertMatchingBooks(pool, userId, row, cookie, outbound, signal);
        const response = (
          await peerRequest(row.peer_url, '/api/sync/events', cookie, {
            method: 'POST',
            body: { ...SYNC_CONTRACT_V2, events: outbound },
            signal,
          })
        ).body as { acceptedIds?: string[]; rejected?: Array<{ reason?: string }> };
        if (
          response.rejected?.length ||
          JSON.stringify(response.acceptedIds) !== JSON.stringify(outbound.map((e) => e.id))
        ) {
          throw new PeerSyncFailure(
            response.rejected?.some((item) => item.reason === 'stale')
              ? 'peer_stale_or_conflicting_position'
              : 'peer_rejected_events',
            'blocked',
          );
        }
        const updated = await pool.query(
          `update sync_server_peers set outbound_cursor = $3, updated_at = now()
            where user_id = $1 and peer_id = $2 and outbound_cursor = $4`,
          [userId, row.peer_id, outbound.at(-1)!.sequence, row.outbound_cursor],
        );
        if (updated.rowCount !== 1) throw new PeerSyncFailure('peer_cursor_changed', 'blocked');
      }

      const pulled = (
        await peerRequest(
          row.peer_url,
          `/api/sync?since=${Number(row.inbound_cursor)}&contractVersion=2&idContract=v2-sha256-128&hashContract=v2-sha256-tagged`,
          cookie,
          { signal },
        )
      ).body as PullResponse;
      if (
        pulled.contractVersion !== 2 ||
        pulled.idContract !== SYNC_CONTRACT_V2.idContract ||
        pulled.hashContract !== SYNC_CONTRACT_V2.hashContract ||
        !Array.isArray(pulled.events) ||
        pulled.events.length > 500 ||
        !Number.isSafeInteger(pulled.cursor)
      ) {
        throw new PeerSyncFailure('peer_contract_unsupported', 'blocked');
      }
      const inbound = pulled.events.map(readPeerEvent);
      const sequences = inbound.map((event) => Number(event.sequence));
      if (
        pulled.cursor < Number(row.inbound_cursor) ||
        (inbound.length === 0 && pulled.cursor !== Number(row.inbound_cursor)) ||
        (inbound.length > 0 && pulled.cursor !== sequences.at(-1)) ||
        sequences.some(
          (sequence, index) =>
            !Number.isSafeInteger(sequence) ||
            sequence <= (index === 0 ? Number(row.inbound_cursor) : sequences[index - 1]!),
        )
      ) {
        throw new PeerSyncFailure('peer_cursor_invalid', 'blocked');
      }
      assertSupportedEvents(inbound);
      await assertMatchingBooks(pool, userId, row, cookie, inbound, signal);
      if (inbound.length) {
        const transaction = await pool.connect();
        try {
          await transaction.query('begin');
          const result = await applySyncEventsInTransaction(transaction, config, inbound, SYNC_CONTRACT_V2);
          if (
            result.rejected?.length ||
            JSON.stringify(result.acceptedIds) !== JSON.stringify(inbound.map((e) => e.id))
          ) {
            throw new PeerSyncFailure(
              result.rejected?.some((item) => item.reason === 'stale')
                ? 'local_stale_or_conflicting_position'
                : 'local_rejected_events',
              'blocked',
            );
          }
          const updated = await transaction.query(
            `update sync_server_peers set inbound_cursor = $3, status = 'ready', last_error = null,
                    last_synced_at = now(), updated_at = now()
              where user_id = $1 and peer_id = $2 and inbound_cursor = $4`,
            [userId, row.peer_id, pulled.cursor, row.inbound_cursor],
          );
          if (updated.rowCount !== 1) throw new PeerSyncFailure('peer_cursor_changed', 'blocked');
          await transaction.query('commit');
        } catch (error) {
          await transaction.query('rollback');
          throw error;
        } finally {
          transaction.release();
        }
      } else {
        await pool.query(
          `update sync_server_peers set status = 'ready', last_error = null, last_synced_at = now(), updated_at = now()
            where user_id = $1 and peer_id = $2`,
          [userId, row.peer_id],
        );
      }
    } catch (error) {
      const failure = error instanceof PeerSyncFailure ? error : new PeerSyncFailure('peer_sync_failed', 'offline');
      await pool.query(
        `update sync_server_peers set status = $3, last_error = $4, updated_at = now()
          where user_id = $1 and peer_id = $2`,
        [userId, row.peer_id, failure.status, failure.code],
      );
      throw failure;
    }
  }

  app.get('/api/sync/identity', async () => ({ serverId: await serverId(pool) }));
  app.get('/api/sync/watermark', async () => ({ cursor: await watermark(pool, userId) }));
  app.get<{ Params: { bookId: string } }>('/api/sync/book-identity/:bookId', async (request, reply) => {
    const identity = await bookIdentity(pool, userId, request.params.bookId);
    return identity ?? reply.code(404).send({ error: 'sync_book_identity_unavailable' });
  });
  app.get('/api/sync/peer', async () => publicPeer(await loadPeer(pool, userId)));
  app.post<{
    Body: { url?: unknown; username?: unknown; password?: unknown; startFromNow?: unknown };
  }>('/api/sync/peer', { bodyLimit: 4096 }, async (request, reply) => {
    if (request.body?.startFromNow !== true) return reply.code(400).send({ error: 'start_from_now_required' });
    if (typeof request.body.username !== 'string' || typeof request.body.password !== 'string') {
      return reply.code(400).send({ error: 'peer_credentials_required' });
    }
    let url: string;
    try {
      url = peerUrl(request.body.url);
    } catch {
      return reply.code(400).send({ error: 'invalid_peer_url' });
    }
    if (configuring) return reply.code(409).send({ error: 'peer_configuration_busy' });
    configuring = true;
    try {
      await running;
      const login = await peerRequest(url, '/api/auth/login', undefined, {
        method: 'POST',
        body: { username: request.body.username, password: request.body.password },
      });
      const cookie = sessionCookie(login.setCookie);
      const identity = (await peerRequest(url, '/api/sync/identity', cookie)).body as { serverId?: string };
      if (!identity.serverId || identity.serverId === (await serverId(pool))) {
        throw new PeerSyncFailure('peer_server_identity_invalid', 'blocked');
      }
      const capabilities = (await peerRequest(url, '/api/sync/capabilities', cookie)).body as {
        contractVersion?: number;
        idContract?: string;
        hashContract?: string;
      };
      if (
        capabilities.contractVersion !== 2 ||
        capabilities.idContract !== SYNC_CONTRACT_V2.idContract ||
        capabilities.hashContract !== SYNC_CONTRACT_V2.hashContract
      ) {
        throw new PeerSyncFailure('peer_contract_unsupported', 'blocked');
      }
      const remote = (await peerRequest(url, '/api/sync/watermark', cookie)).body as { cursor?: number };
      if (!Number.isSafeInteger(remote.cursor) || remote.cursor! < 0) {
        throw new PeerSyncFailure('peer_cursor_invalid', 'blocked');
      }
      const localCursor = await watermark(pool, userId);
      const peerId = randomUUID();
      const secret = encryptedSession(key(), userId, peerId, cookie);
      const previous = await loadPeer(pool, userId);
      await pool.query(
        `insert into sync_server_peers (
           user_id, peer_id, peer_url, peer_server_id, session_ciphertext, session_iv,
           session_auth_tag, session_key_version, outbound_cursor, inbound_cursor, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready')
         on conflict (user_id) do update set
           peer_id = excluded.peer_id, peer_url = excluded.peer_url, peer_server_id = excluded.peer_server_id,
           session_ciphertext = excluded.session_ciphertext, session_iv = excluded.session_iv,
           session_auth_tag = excluded.session_auth_tag, session_key_version = excluded.session_key_version,
           outbound_cursor = excluded.outbound_cursor, inbound_cursor = excluded.inbound_cursor,
           status = 'ready', last_error = null, last_synced_at = null, updated_at = now()`,
        [
          userId,
          peerId,
          url,
          identity.serverId,
          secret.ciphertext,
          secret.iv,
          secret.authTag,
          PEER_KEY_VERSION,
          localCursor,
          remote.cursor,
        ],
      );
      if (previous) {
        try {
          await peerRequest(previous.peer_url, '/api/auth/logout', decryptedSession(key(), previous), {
            method: 'POST',
          });
        } catch {
          // The previous remote session expires even when its server is unavailable now.
        }
      }
      return publicPeer(await loadPeer(pool, userId));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof PeerSyncFailure ? error.code : 'peer_pairing_failed' });
    } finally {
      configuring = false;
    }
  });
  app.post('/api/sync/peer/run', async (_request, reply) => {
    if (configuring) return reply.code(409).send({ error: 'peer_configuration_busy' });
    await execute();
    return publicPeer(await loadPeer(pool, userId));
  });
  app.delete('/api/sync/peer', async (_request, reply) => {
    if (configuring) return reply.code(409).send({ error: 'peer_configuration_busy' });
    configuring = true;
    try {
      await running;
      const row = await loadPeer(pool, userId);
      await pool.query('delete from sync_server_peers where user_id = $1', [userId]);
      if (row) {
        try {
          await peerRequest(row.peer_url, '/api/auth/logout', decryptedSession(key(), row), { method: 'POST' });
        } catch {
          // The local pairing is already removed; the remote session also expires there.
        }
      }
      return { ok: true };
    } finally {
      configuring = false;
    }
  });

  const timer = setInterval(() => void execute(), PEER_POLL_INTERVAL_MS);
  timer.unref();
  app.addHook('preClose', async () => {
    clearInterval(timer);
    activeAbort?.abort();
  });
  app.addHook('onClose', async () => {
    await running;
  });
}
