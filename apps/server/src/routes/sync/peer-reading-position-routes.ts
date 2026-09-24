import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import { validateV2SyncEvent } from '../../../../../src/sync/event-contract-validation.js';
import { SELF_HOST_SESSION_COOKIE } from '../../auth-cookie.js';
import type { ServerConfig } from '../../config.js';
import { loadProviderSecretMasterKey } from '../../providers/server-provider-secrets.js';
import { BackupStaging } from '../../services/backup-staging.js';
import { exportHostedBackup, inspectHostedBackup, restoreHostedBackup } from '../../services/hosted-backup-service.js';
import path from 'node:path';
import {
  bookIdentity,
  PeerBookContentError,
  restorePeerBookContent,
  type BookIdentity,
} from '../../services/peer-book-content.js';
import { querySyncEventsAfter, waitForSyncWriters } from './pull-query.js';
import { applySyncEventsInTransaction } from './push-route.js';
import { mapSyncEventRow } from './row-mappers.js';

const PEER_KEY_VERSION = 'local-aes-256-gcm-v1';
const MAX_PEER_RESPONSE_BYTES = 4 * 1024 * 1024;
const PEER_POLL_INTERVAL_MS = 15_000;
const SUPPORTED_TYPES = new Set(['book_imported', 'reading_position_updated', 'reading_position_deleted']);

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
  bootstrap_required: boolean;
  last_error: string | null;
  last_synced_at: Date | string | null;
}

interface PullResponse {
  contractVersion: number;
  idContract: string;
  hashContract: string;
  cursor: number;
  events: Array<Record<string, unknown>>;
}

interface PeerConflictContext {
  direction: 'inbound' | 'outbound';
  eventId: string;
  eventType: string;
  bookId?: string;
  localIdentity?: BookIdentity;
  remoteIdentity?: BookIdentity;
}

function eventConflict(event: SyncEvent, direction: PeerConflictContext['direction']): PeerConflictContext {
  return { direction, eventId: event.id, eventType: event.type, bookId: event.novelId };
}

class PeerSyncFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: 'offline' | 'needs_login' | 'blocked',
    readonly conflict?: PeerConflictContext,
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
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    archive?: ReadableStream<Uint8Array>;
    timeoutMs?: number;
  } = {},
): Promise<{ body: unknown; setCookie: string | null }> {
  let response: Response;
  try {
    response = await fetch(new URL(resource, baseUrl), {
      method: options.method ?? 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.archive
          ? { 'Content-Type': 'application/zip' }
          : options.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
      },
      ...(options.archive
        ? { body: options.archive, duplex: 'half' }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)])
        : AbortSignal.timeout(options.timeoutMs ?? 10_000),
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
  const client = await pool.connect();
  try {
    await client.query('begin');
    await waitForSyncWriters(client);
    const result = await client.query<{ cursor: string }>(
      'select coalesce(max(sequence), 0)::text as cursor from sync_events where user_id = $1',
      [userId],
    );
    const cursor = Number(result.rows[0].cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new PeerSyncFailure('peer_cursor_invalid', 'blocked');
    await client.query('commit');
    return cursor;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
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

function assertSupportedEvents(events: readonly SyncEvent[], direction: PeerConflictContext['direction']): void {
  const invalidCursor = events.find((event) => !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1);
  if (invalidCursor) {
    throw new PeerSyncFailure('peer_cursor_invalid', 'blocked', eventConflict(invalidCursor, direction));
  }
  const unsupported = events.find((event) => !SUPPORTED_TYPES.has(event.type));
  if (unsupported) {
    throw new PeerSyncFailure('peer_event_type_unsupported', 'blocked', eventConflict(unsupported, direction));
  }
  const invalidContract = events.find((event) => !event.novelId || event.contractVersion !== 2);
  if (invalidContract) {
    throw new PeerSyncFailure('peer_event_contract_unsupported', 'blocked', eventConflict(invalidContract, direction));
  }
}

async function ensurePeerBooks(
  pool: pg.Pool,
  config: ServerConfig,
  row: PeerRow,
  cookie: string,
  events: SyncEvent[],
  signal: AbortSignal,
  direction: 'inbound' | 'outbound',
  staging: BackupStaging,
) {
  for (const bookId of new Set(events.map((event) => event.novelId!))) {
    const local = await bookIdentity(pool, config.defaultUserId, bookId);
    let remote: BookIdentity | undefined;
    try {
      remote = (
        await peerRequest(row.peer_url, `/api/sync/book-identity/${encodeURIComponent(bookId)}`, cookie, { signal })
      ).body as BookIdentity;
    } catch (error) {
      if (!(error instanceof PeerSyncFailure) || error.code !== 'peer_http_404') throw error;
    }
    if (local && remote && JSON.stringify(local) === JSON.stringify(remote)) continue;
    const source = direction === 'outbound' ? local : remote;
    const target = direction === 'outbound' ? remote : local;
    if (!source || target || !events.some((event) => event.novelId === bookId && event.type === 'book_imported')) {
      const event = events.find((item) => item.novelId === bookId)!;
      throw new PeerSyncFailure('peer_book_identity_mismatch', 'blocked', {
        ...eventConflict(event, direction),
        localIdentity: local,
        remoteIdentity: remote,
      });
    }
    const transferAbort = new AbortController();
    const transferSignal = AbortSignal.any([signal, transferAbort.signal]);
    try {
      const resource = `/api/sync/book-content/${encodeURIComponent(bookId)}`;
      if (direction === 'outbound') {
        const archive = await exportHostedBackup(pool, config, transferSignal, false, bookId);
        // Observe failures even if the receiver rejects before it consumes the stream.
        void archive.completion.catch(() => undefined);
        const response = (
          await peerRequest(row.peer_url, resource, cookie, {
            method: 'POST',
            archive: archive.readable,
            signal: transferSignal,
            timeoutMs: 60 * 60_000,
          })
        ).body as { identity?: BookIdentity };
        await archive.completion;
        if (JSON.stringify(response.identity) !== JSON.stringify(source))
          throw new PeerSyncFailure('peer_book_identity_changed', 'blocked');
      } else {
        const response = await fetch(new URL(resource, row.peer_url), {
          headers: { Cookie: cookie, Accept: 'application/zip' },
          redirect: 'manual',
          signal: transferSignal,
        });
        if (response.status === 401 || response.status === 403)
          throw new PeerSyncFailure('peer_auth_required', 'needs_login');
        if (response.status === 409 || response.status === 404)
          throw new PeerSyncFailure('peer_book_transfer_rejected', 'blocked');
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/zip'))
          throw new PeerSyncFailure('peer_book_archive_unavailable', 'offline');
        const input = Readable.fromWeb(response.body as never);
        input.on('error', () => undefined);
        const length = response.headers.get('content-length');
        const received = await staging.receive(input, length === null ? undefined : Number(length), transferSignal);
        try {
          if (received.stage.source !== 'hosted') throw new PeerBookContentError('peer_book_content_scope_invalid');
          await restorePeerBookContent(pool, config, received.stage.parsed, bookId, transferSignal, source);
        } finally {
          await staging.discard(received.id);
        }
      }
    } catch (error) {
      if (
        (error instanceof PeerSyncFailure && ['peer_http_409', 'peer_http_404'].includes(error.code)) ||
        (error instanceof Error && error.message === 'peer_book_initial_content_required')
      )
        throw new PeerSyncFailure('peer_book_transfer_rejected', 'blocked');
      throw error;
    } finally {
      transferAbort.abort();
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
        bootstrapRequired: row.bootstrap_required,
        lastError: row.last_error,
        lastSyncedAt: row.last_synced_at,
        scope: 'new_book_content_and_matching_reading_positions',
      }
    : { configured: false };
}

export function registerPeerReadingPositionRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): void {
  const userId = config.defaultUserId;
  const key = () => loadProviderSecretMasterKey(config, process.env);
  const backupStaging = new BackupStaging(path.join(config.dataDir, 'peer-backup-staging'));
  let running: Promise<void> | undefined;
  let activeAbort: AbortController | undefined;
  let bootstrapAbort: AbortController | undefined;
  let bootstrapProgress:
    | { stage: 'preparing' | 'downloading' | 'validating' | 'restoring'; completedBytes?: number; totalBytes?: number }
    | undefined;
  let configuring = false;
  const shutdown = new AbortController();

  const execute = () => {
    if (configuring || shutdown.signal.aborted) return Promise.resolve();
    if (running) return running;
    activeAbort = new AbortController();
    const timeout = setTimeout(() => activeAbort?.abort(), 60 * 60_000);
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
    if (
      !row ||
      row.bootstrap_required ||
      row.status === 'blocked' ||
      row.status === 'needs_login' ||
      row.status === 'bootstrapping'
    )
      return;
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
        await client.query('begin');
        const rows = await querySyncEventsAfter(client, userId, Number(row.outbound_cursor));
        outbound = rows.map(mapSyncEventRow);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      assertSupportedEvents(outbound, 'outbound');
      if (outbound.length) {
        await ensurePeerBooks(pool, config, row, cookie, outbound, signal, 'outbound', backupStaging);
        const response = (
          await peerRequest(row.peer_url, '/api/sync/events', cookie, {
            method: 'POST',
            body: { ...SYNC_CONTRACT_V2, events: outbound },
            signal,
          })
        ).body as { acceptedIds?: string[]; rejected?: Array<{ id?: string; reason?: string }> };
        if (
          response.rejected?.length ||
          JSON.stringify(response.acceptedIds) !== JSON.stringify(outbound.map((e) => e.id))
        ) {
          const rejectedId = response.rejected?.[0]?.id;
          const rejectedEvent = outbound.find((event) => event.id === rejectedId) ?? outbound[0];
          throw new PeerSyncFailure(
            response.rejected?.some((item) => item.reason === 'stale')
              ? 'peer_stale_or_conflicting_position'
              : 'peer_rejected_events',
            'blocked',
            rejectedEvent ? eventConflict(rejectedEvent, 'outbound') : undefined,
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
      assertSupportedEvents(inbound, 'inbound');
      await ensurePeerBooks(pool, config, row, cookie, inbound, signal, 'inbound', backupStaging);
      if (inbound.length) {
        const transaction = await pool.connect();
        try {
          await transaction.query('begin');
          const result = await applySyncEventsInTransaction(transaction, config, inbound, SYNC_CONTRACT_V2);
          if (
            result.rejected?.length ||
            JSON.stringify(result.acceptedIds) !== JSON.stringify(inbound.map((e) => e.id))
          ) {
            const rejectedId = result.rejected?.[0]?.id;
            const rejectedEvent = inbound.find((event) => event.id === rejectedId) ?? inbound[0];
            throw new PeerSyncFailure(
              result.rejected?.some((item) => item.reason === 'stale')
                ? 'local_stale_or_conflicting_position'
                : 'local_rejected_events',
              'blocked',
              rejectedEvent ? eventConflict(rejectedEvent, 'inbound') : undefined,
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
      const failure =
        error instanceof PeerSyncFailure
          ? error
          : error instanceof PeerBookContentError
            ? new PeerSyncFailure(error.message, 'blocked')
            : new PeerSyncFailure('peer_sync_failed', 'offline');
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (failure.status === 'blocked' && failure.conflict) {
          const conflict = failure.conflict;
          await client.query(
            `insert into sync_peer_conflicts (
               user_id, peer_id, direction, event_id, event_type, book_id, reason, local_identity, remote_identity
             ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
             on conflict (user_id, peer_id, direction, event_id) do update set
               reason=excluded.reason, local_identity=excluded.local_identity,
               remote_identity=excluded.remote_identity, updated_at=now()`,
            [
              userId,
              row.peer_id,
              conflict.direction,
              conflict.eventId,
              conflict.eventType,
              conflict.bookId ?? null,
              failure.code,
              conflict.localIdentity ? JSON.stringify(conflict.localIdentity) : null,
              conflict.remoteIdentity ? JSON.stringify(conflict.remoteIdentity) : null,
            ],
          );
        }
        await client.query(
          `update sync_server_peers set status = $3, last_error = $4, updated_at = now()
            where user_id = $1 and peer_id = $2`,
          [userId, row.peer_id, failure.status, failure.code],
        );
        await client.query('commit');
      } catch (persistError) {
        await client.query('rollback');
        throw persistError;
      } finally {
        client.release();
      }
      throw failure;
    }
  }

  app.get('/api/sync/identity', async () => ({ serverId: await serverId(pool) }));
  app.get('/api/sync/watermark', async () => ({ cursor: await watermark(pool, userId) }));
  app.get<{ Params: { bookId: string } }>('/api/sync/book-identity/:bookId', async (request, reply) => {
    const identity = await bookIdentity(pool, userId, request.params.bookId);
    return identity ?? reply.code(404).send({ error: 'sync_book_identity_unavailable' });
  });
  app.get('/api/sync/peer', async () => ({
    ...publicPeer(await loadPeer(pool, userId)),
    ...(bootstrapProgress ? { bootstrapProgress } : {}),
  }));
  app.get('/api/sync/peer/conflicts', async () => {
    const row = await loadPeer(pool, userId);
    if (!row) return { conflicts: [] };
    const result = await pool.query(
      `select direction, event_id, event_type, book_id, reason, local_identity, remote_identity,
              created_at, updated_at
         from sync_peer_conflicts
        where user_id=$1 and peer_id=$2 and status='unresolved'
        order by updated_at desc limit 100`,
      [userId, row.peer_id],
    );
    return { conflicts: result.rows };
  });
  app.post<{
    Body: {
      url?: unknown;
      username?: unknown;
      password?: unknown;
      startFromNow?: unknown;
      requireEmptyLibrary?: unknown;
    };
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
      activeAbort?.abort();
      await running;
      if (request.body.requireEmptyLibrary === true) {
        const existing = await pool.query('select 1 from library_books where user_id = $1 limit 1', [userId]);
        if (existing.rowCount) throw new PeerSyncFailure('peer_bootstrap_requires_empty_library', 'blocked');
      }
      const login = await peerRequest(url, '/api/auth/login', undefined, {
        method: 'POST',
        body: { username: request.body.username, password: request.body.password },
        signal: shutdown.signal,
      });
      const cookie = sessionCookie(login.setCookie);
      const identity = (await peerRequest(url, '/api/sync/identity', cookie, { signal: shutdown.signal })).body as {
        serverId?: string;
      };
      if (!identity.serverId || identity.serverId === (await serverId(pool))) {
        throw new PeerSyncFailure('peer_server_identity_invalid', 'blocked');
      }
      const capabilities = (await peerRequest(url, '/api/sync/capabilities', cookie, { signal: shutdown.signal }))
        .body as {
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
      const remote = (await peerRequest(url, '/api/sync/watermark', cookie, { signal: shutdown.signal })).body as {
        cursor?: number;
      };
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
           session_auth_tag, session_key_version, outbound_cursor, inbound_cursor, status, bootstrap_required
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (user_id) do update set
           peer_id = excluded.peer_id, peer_url = excluded.peer_url, peer_server_id = excluded.peer_server_id,
           session_ciphertext = excluded.session_ciphertext, session_iv = excluded.session_iv,
           session_auth_tag = excluded.session_auth_tag, session_key_version = excluded.session_key_version,
           outbound_cursor = excluded.outbound_cursor, inbound_cursor = excluded.inbound_cursor,
           status = excluded.status, bootstrap_required = excluded.bootstrap_required,
           last_error = null, last_synced_at = null, updated_at = now()`,
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
          request.body.requireEmptyLibrary === true ? 'awaiting_bootstrap' : 'ready',
          request.body.requireEmptyLibrary === true,
        ],
      );
      if (previous) {
        try {
          await peerRequest(previous.peer_url, '/api/auth/logout', decryptedSession(key(), previous), {
            method: 'POST',
            signal: shutdown.signal,
          });
        } catch {
          // The previous remote session expires even when its server is unavailable now.
        }
      }
      return publicPeer(await loadPeer(pool, userId));
    } catch (error) {
      return reply
        .code(error instanceof PeerSyncFailure && error.code === 'peer_bootstrap_requires_empty_library' ? 409 : 400)
        .send({ error: error instanceof PeerSyncFailure ? error.code : 'peer_pairing_failed' });
    } finally {
      configuring = false;
    }
  });
  app.post<{ Body: { username?: unknown; password?: unknown } }>(
    '/api/sync/peer/reauthenticate',
    { bodyLimit: 4096 },
    async (request, reply) => {
      if (typeof request.body?.username !== 'string' || typeof request.body?.password !== 'string')
        return reply.code(400).send({ error: 'peer_credentials_required' });
      if (configuring) return reply.code(409).send({ error: 'peer_configuration_busy' });
      configuring = true;
      let newSession: { url: string; cookie: string } | undefined;
      try {
        activeAbort?.abort();
        await running;
        const row = await loadPeer(pool, userId);
        if (!row) return reply.code(404).send({ error: 'peer_not_configured' });
        const login = await peerRequest(row.peer_url, '/api/auth/login', undefined, {
          method: 'POST',
          body: { username: request.body.username, password: request.body.password },
          signal: shutdown.signal,
        });
        const cookie = sessionCookie(login.setCookie);
        newSession = { url: row.peer_url, cookie };
        const identity = (await peerRequest(row.peer_url, '/api/sync/identity', cookie, { signal: shutdown.signal }))
          .body as { serverId?: string };
        if (identity.serverId !== row.peer_server_id)
          throw new PeerSyncFailure('peer_server_identity_changed', 'blocked');
        const secret = encryptedSession(key(), userId, row.peer_id, cookie);
        const status = row.bootstrap_required
          ? 'awaiting_bootstrap'
          : row.status === 'needs_login' || row.status === 'offline'
            ? 'ready'
            : row.status;
        const updated = await pool.query(
          `update sync_server_peers set session_ciphertext=$3, session_iv=$4, session_auth_tag=$5,
             session_key_version=$6, status=$7, last_error=$8, updated_at=now()
           where user_id=$1 and peer_id=$2`,
          [
            userId,
            row.peer_id,
            secret.ciphertext,
            secret.iv,
            secret.authTag,
            PEER_KEY_VERSION,
            status,
            status === 'blocked' ? row.last_error : null,
          ],
        );
        if (updated.rowCount !== 1) throw new PeerSyncFailure('peer_configuration_changed', 'blocked');
        newSession = undefined; // The new session is now owned by the persisted pairing.
        try {
          const oldCookie = decryptedSession(key(), row);
          if (oldCookie !== cookie)
            await peerRequest(row.peer_url, '/api/auth/logout', oldCookie, { method: 'POST', signal: shutdown.signal });
        } catch {
          /* An expired session needs no further cleanup. */
        }
        return publicPeer(await loadPeer(pool, userId));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof PeerSyncFailure ? error.code : 'peer_pairing_failed' });
      } finally {
        try {
          if (newSession)
            await peerRequest(newSession.url, '/api/auth/logout', newSession.cookie, {
              method: 'POST',
              signal: shutdown.signal,
            }).catch(() => undefined);
        } finally {
          configuring = false;
        }
      }
    },
  );
  app.post('/api/sync/peer/bootstrap', async (_request, reply) => {
    if (configuring) return reply.code(409).send({ error: 'peer_configuration_busy' });
    configuring = true;
    bootstrapAbort = new AbortController();
    const signal = AbortSignal.any([bootstrapAbort.signal, AbortSignal.timeout(60 * 60_000)]);
    let stagedId: string | undefined;
    let peerId: string | undefined;
    try {
      activeAbort?.abort();
      await running;
      const row = await loadPeer(pool, userId);
      if (!row) return reply.code(404).send({ error: 'peer_not_configured' });
      peerId = row.peer_id;
      const localBooks = await pool.query<{ count: string }>(
        'select count(*)::text as count from library_books where user_id = $1',
        [userId],
      );
      if (Number(localBooks.rows[0].count) !== 0) {
        return reply.code(409).send({ error: 'peer_bootstrap_requires_empty_library' });
      }
      const localCursor = await watermark(pool, userId);
      const localChanges = await pool.query(
        `select 1 from sync_events where user_id=$1 and sequence > $2 and sequence <= $3
           and type <> 'settings_updated' limit 1`,
        [userId, row.outbound_cursor, localCursor],
      );
      if (localChanges.rows.length) return reply.code(409).send({ error: 'peer_bootstrap_library_changed' });
      // Settings can be saved while opening the native panel after pairing.
      // Keep those local preferences and establish their initial baseline only
      // with the successful copy commit; a failed copy must remain retryable.
      const keepLocalSettings = localCursor !== Number(row.outbound_cursor);
      const reserved = await pool.query(
        `update sync_server_peers set status = 'bootstrapping', bootstrap_required = true, last_error = null, updated_at = now()
          where user_id = $1 and peer_id = $2`,
        [userId, peerId],
      );
      if (reserved.rowCount !== 1) throw new PeerSyncFailure('peer_configuration_changed', 'blocked');
      bootstrapProgress = { stage: 'preparing' };
      const cookie = decryptedSession(key(), row);
      const identity = (await peerRequest(row.peer_url, '/api/sync/identity', cookie, { signal })).body as {
        serverId?: string;
      };
      if (identity.serverId !== row.peer_server_id)
        throw new PeerSyncFailure('peer_server_identity_changed', 'blocked');

      const before = (await peerRequest(row.peer_url, '/api/sync/watermark', cookie, { signal })).body as {
        cursor?: number;
      };
      if (!Number.isSafeInteger(before.cursor) || before.cursor! < 0)
        throw new PeerSyncFailure('peer_cursor_invalid', 'blocked');
      const ticket = (await peerRequest(row.peer_url, '/api/backups/download', cookie, { method: 'POST', signal }))
        .body as { ticket?: string };
      if (!ticket.ticket || !/^[A-Za-z0-9_-]{20,100}$/.test(ticket.ticket))
        throw new PeerSyncFailure('peer_backup_ticket_invalid', 'blocked');
      let archive: Response;
      try {
        archive = await fetch(new URL(`/api/backups/download/${ticket.ticket}`, row.peer_url), {
          headers: { Cookie: cookie, Accept: 'application/zip' },
          redirect: 'manual',
          signal,
        });
      } catch {
        throw new PeerSyncFailure('peer_backup_unreachable', 'offline');
      }
      if (archive.status === 401 || archive.status === 403)
        throw new PeerSyncFailure('peer_auth_required', 'needs_login');
      if (!archive.ok || !archive.body || !archive.headers.get('content-type')?.includes('application/zip')) {
        throw new PeerSyncFailure('peer_backup_unavailable', 'blocked');
      }
      const lengthHeader = archive.headers.get('content-length');
      const expectedBytes = lengthHeader === null ? undefined : Number(lengthHeader);
      bootstrapProgress = { stage: 'downloading', completedBytes: 0, totalBytes: expectedBytes };
      const input = Readable.fromWeb(archive.body as never);
      // An interrupted fetch can emit once more after pipeline has torn down its listeners.
      input.on('error', () => undefined);
      const received = await backupStaging.receive(
        input,
        expectedBytes,
        signal,
        (completedBytes) => {
          bootstrapProgress = { stage: 'downloading', completedBytes, totalBytes: expectedBytes };
        },
        () => {
          bootstrapProgress = { stage: 'validating' };
        },
      );
      stagedId = received.id;
      if (received.stage.source !== 'hosted') throw new PeerSyncFailure('peer_backup_format_invalid', 'blocked');
      const inspection = await inspectHostedBackup(pool, config, received.stage.parsed, received.stage.byteLength);
      if (inspection.conflicts.length) throw new PeerSyncFailure('peer_bootstrap_library_changed', 'blocked');
      const after = (await peerRequest(row.peer_url, '/api/sync/watermark', cookie, { signal })).body as {
        cursor?: number;
      };
      if (after.cursor !== before.cursor) throw new PeerSyncFailure('peer_changed_during_bootstrap', 'blocked');

      const staged = backupStaging.take(stagedId);
      stagedId = undefined;
      bootstrapProgress = { stage: 'restoring' };
      let restored;
      try {
        restored = await restoreHostedBackup(
          pool,
          config,
          keepLocalSettings
            ? { ...staged.parsed, tables: new Map(staged.parsed.tables).set('reader_settings', []) }
            : staged.parsed,
          { defaultConflictResolution: 'skip' },
          signal,
          {
            beforeRestore: async (client) => {
              await client.query('lock table library_books in share row exclusive mode');
              const current = await client.query<{ peer_id: string; status: string }>(
                'select peer_id, status from sync_server_peers where user_id = $1 for update',
                [userId],
              );
              if (current.rows[0]?.peer_id !== peerId || current.rows[0]?.status !== 'bootstrapping') {
                throw new PeerSyncFailure('peer_configuration_changed', 'blocked');
              }
              const books = await client.query<{ count: string }>(
                'select count(*)::text as count from library_books where user_id = $1',
                [userId],
              );
              if (Number(books.rows[0].count) !== 0)
                throw new PeerSyncFailure('peer_bootstrap_library_changed', 'blocked');
            },
            beforeCommit: async (client) => {
              const updated = await client.query(
                `update sync_server_peers set inbound_cursor = $3, outbound_cursor = $5, status = 'ready', bootstrap_required = false, last_error = null,
                        last_synced_at = now(), updated_at = now()
                  where user_id = $1 and peer_id = $2 and status = 'bootstrapping' and inbound_cursor = $4`,
                [userId, peerId, before.cursor, row.inbound_cursor, localCursor],
              );
              if (updated.rowCount !== 1) throw new PeerSyncFailure('peer_configuration_changed', 'blocked');
            },
          },
        );
      } finally {
        await staged.dispose();
      }
      return { ...publicPeer(await loadPeer(pool, userId)), restoredBooks: restored.restoredBooks };
    } catch (error) {
      const code = error instanceof PeerSyncFailure ? error.code : 'peer_bootstrap_failed';
      if (peerId) {
        await pool.query(
          `update sync_server_peers set status = $3, last_error = $4, updated_at = now()
            where user_id = $1 and peer_id = $2 and status = 'bootstrapping'`,
          [
            userId,
            peerId,
            error instanceof PeerSyncFailure && error.status === 'needs_login' ? 'needs_login' : 'blocked',
            code,
          ],
        );
      }
      return reply
        .code(error instanceof PeerSyncFailure && error.status === 'offline' ? 503 : 409)
        .send({ error: code });
    } finally {
      try {
        if (stagedId) await backupStaging.discard(stagedId);
      } finally {
        bootstrapAbort = undefined;
        bootstrapProgress = undefined;
        configuring = false;
      }
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
      activeAbort?.abort();
      await running;
      const row = await loadPeer(pool, userId);
      await pool.query('delete from sync_server_peers where user_id = $1', [userId]);
      if (row) {
        try {
          await peerRequest(row.peer_url, '/api/auth/logout', decryptedSession(key(), row), {
            method: 'POST',
            signal: shutdown.signal,
          });
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
    shutdown.abort();
    clearInterval(timer);
    activeAbort?.abort();
    bootstrapAbort?.abort();
  });
  app.addHook('onClose', async () => {
    await running;
    await backupStaging.close();
  });
}
