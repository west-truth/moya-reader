import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import type { ParsedNovel } from '../domain/types';
import { listSyncOutbox, openReaderDb, resetReaderDbForTests, saveImportedNovel } from '../storage/db';
import {
  claimSyncOutboxBatchInDatabase,
  recoverStaleSendingOutboxInDatabase,
  settleClaimedSyncOutboxItemsInDatabase,
} from '../storage/sync-outbox-store';
import { LocalOutboxSyncService, type SyncEventSource } from '../sync/local-outbox-sync-service';
import type { RejectedSyncEvent, SyncEvent } from '../sync/types';

const T0 = '2026-07-10T00:00:00.000Z';
const T1 = '2026-07-10T00:01:00.000Z';
const T2 = '2026-07-10T00:02:00.000Z';
const T3 = '2026-07-10T00:03:00.000Z';

function parsedNovel(id: string): ParsedNovel {
  const text = 'body';
  const chapterId = `${id}:chapter:1`;
  return {
    novel: {
      id,
      title: 'Lease Test',
      sourceFileName: 'lease-test.txt',
      sourceEncoding: 'utf-8',
      rawText: text,
      normalizedText: text,
      rawTextHash: integrityHash(text),
      normalizedTextHash: integrityHash(text),
      createdAt: T0,
      updatedAt: T0,
      totalChapters: 1,
      totalCharacters: text.length,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: chapterId,
        novelId: id,
        index: 1,
        title: 'Chapter 1',
        normalizedText: text,
        textHash: integrityHash(text),
        rawStartOffset: 0,
        rawEndOffset: text.length,
        characterCount: text.length,
        paragraphCount: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    paragraphs: [
      {
        id: `${id}:paragraph:1`,
        novelId: id,
        chapterId,
        index: 1,
        text,
        startOffsetInChapter: 0,
        endOffsetInChapter: text.length,
        textHash: integrityHash(text),
      },
    ],
  };
}

function clock(iso: string): () => Date {
  return () => new Date(iso);
}

function idleSource(pushSync: SyncEventSource['pushSync']): SyncEventSource {
  return {
    pushSync,
    async pullSync() {
      return { cursor: 1, events: [] };
    },
  };
}

async function queuedItemId(): Promise<string> {
  const [item] = await listSyncOutbox('pending');
  if (!item) throw new Error('expected a pending outbox item');
  return item.id;
}

describe('connected sync outbox leases', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('recovers an expired sending row after restart and reclaims it with a new lease', async () => {
    await saveImportedNovel(parsedNovel('lease-restart'));
    const itemId = await queuedItemId();
    await claimSyncOutboxBatchInDatabase(await openReaderDb(), {
      leaseToken: 'lease-old',
      now: T0,
      leaseExpiresAt: T1,
      candidateIds: [itemId],
    });
    const pushed: SyncEvent[] = [];
    const service = new LocalOutboxSyncService(
      idleSource(async (events) => {
        pushed.push(...events);
        return { accepted: events.length };
      }),
      { now: clock(T2), createLeaseToken: () => 'lease-new', leaseDurationMs: 60_000 },
    );

    await service.flushPending();

    expect(pushed).toHaveLength(1);
    const [sent] = await listSyncOutbox('sent');
    expect(sent).toMatchObject({ id: itemId, attemptCount: 2, lastAttemptAt: T2 });
    expect(sent.leaseToken).toBeUndefined();
    expect(sent.leaseExpiresAt).toBeUndefined();
  });

  it('leaves a nonexpired sending row owned by its current worker', async () => {
    await saveImportedNovel(parsedNovel('lease-fresh'));
    const itemId = await queuedItemId();
    await claimSyncOutboxBatchInDatabase(await openReaderDb(), {
      leaseToken: 'lease-current',
      now: T0,
      leaseExpiresAt: T3,
      candidateIds: [itemId],
    });
    let pushes = 0;
    const service = new LocalOutboxSyncService(
      idleSource(async (events) => {
        pushes += 1;
        return { accepted: events.length };
      }),
      { now: clock(T1), createLeaseToken: () => 'lease-other' },
    );

    await service.flushPending();

    expect(pushes).toBe(0);
    expect(await listSyncOutbox('sending')).toMatchObject([
      { id: itemId, leaseToken: 'lease-current', leaseExpiresAt: T3, attemptCount: 1 },
    ]);
  });

  it('fences settlement from a stale worker after a newer flush claims the row', async () => {
    await saveImportedNovel(parsedNovel('lease-fence'));
    const itemId = await queuedItemId();
    await claimSyncOutboxBatchInDatabase(await openReaderDb(), {
      leaseToken: 'lease-old',
      now: T0,
      leaseExpiresAt: T1,
      candidateIds: [itemId],
    });
    expect(await recoverStaleSendingOutboxInDatabase(await openReaderDb(), T2)).toEqual([itemId]);
    await claimSyncOutboxBatchInDatabase(await openReaderDb(), {
      leaseToken: 'lease-new',
      now: T2,
      leaseExpiresAt: T3,
      candidateIds: [itemId],
    });

    const staleSettlement = await settleClaimedSyncOutboxItemsInDatabase(
      await openReaderDb(),
      'lease-old',
      [{ id: itemId, status: 'sent' }],
      T2,
    );

    expect(staleSettlement).toEqual({ updatedIds: [], skippedIds: [itemId] });
    expect(await listSyncOutbox('sending')).toMatchObject([{ id: itemId, leaseToken: 'lease-new' }]);
    await settleClaimedSyncOutboxItemsInDatabase(
      await openReaderDb(),
      'lease-new',
      [{ id: itemId, status: 'sent' }],
      T2,
    );
    expect((await listSyncOutbox('sent')).map((item) => item.id)).toEqual([itemId]);
  });

  it('returns one active promise to concurrent flush callers and pushes once', async () => {
    await saveImportedNovel(parsedNovel('lease-single-flight'));
    let resolvePush!: () => void;
    let notifyPushStarted!: () => void;
    const pushGate = new Promise<void>((resolve) => {
      resolvePush = resolve;
    });
    const pushStarted = new Promise<void>((resolve) => {
      notifyPushStarted = resolve;
    });
    let pushes = 0;
    const service = new LocalOutboxSyncService(
      idleSource(async (events) => {
        pushes += 1;
        notifyPushStarted();
        await pushGate;
        return { accepted: events.length };
      }),
      { now: clock(T0), createLeaseToken: () => 'lease-single-flight' },
    );

    const first = service.flushPending();
    const second = service.flushPending();

    expect(second).toBe(first);
    await pushStarted;
    expect(pushes).toBe(1);
    resolvePush();
    await Promise.all([first, second]);
    expect(await listSyncOutbox('sent')).toHaveLength(1);
  });

  it.each(['duplicate', 'already_applied'] as const)(
    'treats a %s response as terminal success',
    async (reason: RejectedSyncEvent['reason']) => {
      await saveImportedNovel(parsedNovel(`lease-${reason}`));
      const service = new LocalOutboxSyncService(
        idleSource(async (events) => ({
          accepted: 0,
          acceptedIds: [],
          rejected: [{ id: events[0].id, reason, message: 'event was already applied' }],
        })),
        { now: clock(T0), createLeaseToken: () => `lease-${reason}` },
      );

      const state = await service.flushPending();

      expect(state).toMatchObject({ status: 'idle', pendingCount: 0 });
      expect(await listSyncOutbox('failed')).toEqual([]);
      expect(await listSyncOutbox('sent')).toHaveLength(1);
    },
  );

  it('releases only its claimed rows to failed when the push fails', async () => {
    await saveImportedNovel(parsedNovel('lease-failure'));
    const service = new LocalOutboxSyncService(
      idleSource(async () => {
        throw new Error('network down');
      }),
      { now: clock(T0), createLeaseToken: () => 'lease-failure' },
    );

    const state = await service.flushPending();

    expect(state).toMatchObject({ status: 'failed', pendingCount: 1, lastError: 'network down' });
    const [failed] = await listSyncOutbox('failed');
    expect(failed).toMatchObject({ attempts: 1, attemptCount: 1, lastAttemptAt: T0, lastError: 'network down' });
    expect(failed.leaseToken).toBeUndefined();
    expect(failed.leaseExpiresAt).toBeUndefined();
  });
});
