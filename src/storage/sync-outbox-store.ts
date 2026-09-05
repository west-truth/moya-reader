import type { SyncOutboxItem, SyncOutboxQueryOptions } from '../sync/types';

export interface ClaimSyncOutboxBatchOptions {
  leaseToken: string;
  now: string;
  leaseExpiresAt: string;
  candidateIds?: string[];
  limit?: number;
}

export interface SyncOutboxSettlement {
  id: string;
  status: 'pending' | 'failed' | 'sent';
  lastError?: string;
}

export interface SyncOutboxMutationResult {
  updatedIds: string[];
  skippedIds: string[];
}

const STORE_NAME = 'sync_outbox';
const claimableStatuses = new Set<SyncOutboxItem['status']>(['pending', 'failed']);

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function sorted(items: SyncOutboxItem[]): SyncOutboxItem[] {
  return items.sort(
    (a, b) => (a.localSequence ?? 0) - (b.localSequence ?? 0) || a.createdAt.localeCompare(b.createdAt),
  );
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function assertIsoDate(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid ISO date`);
  return timestamp;
}

function withoutLease(
  item: SyncOutboxItem,
  status: SyncOutboxItem['status'],
  now: string,
  lastError?: string,
): SyncOutboxItem {
  return {
    ...item,
    status,
    attempts: status === 'failed' ? (item.attempts ?? 0) + 1 : (item.attempts ?? 0),
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    lastError: status === 'failed' ? lastError : undefined,
    updatedAt: now,
  };
}

export async function listSyncOutboxInDatabase(
  db: IDBDatabase,
  status?: SyncOutboxItem['status'],
  options?: SyncOutboxQueryOptions,
): Promise<SyncOutboxItem[]> {
  if (options && !status) throw new Error('Filtered outbox queries require a status');
  const tx = db.transaction(STORE_NAME, 'readonly');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  if (options && status) {
    const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER));
    const items: SyncOutboxItem[] = [];
    if (limit > 0) {
      const request = store.index('status').openCursor(status);
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const item = cursor.value as SyncOutboxItem;
          items.push(item);
          if (items.length >= limit) return resolve();
          cursor.continue();
        };
      });
    }
    await done;
    return sorted(items);
  }
  const items = status
    ? await requestToPromise<SyncOutboxItem[]>(store.index('status').getAll(status))
    : await requestToPromise<SyncOutboxItem[]>(store.getAll());
  await done;
  return sorted(items);
}

export async function countQueuedSyncOutboxInDatabase(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const done = transactionDone(tx);
  const statusIndex = tx.objectStore(STORE_NAME).index('status');
  const counts = await Promise.all(
    (['pending', 'sending', 'failed'] as const).map((status) => requestToPromise<number>(statusIndex.count(status))),
  );
  await done;
  return counts.reduce((total, count) => total + count, 0);
}

export async function updateSyncOutboxItemsInDatabase(
  db: IDBDatabase,
  ids: string[],
  status: SyncOutboxItem['status'],
  lastError: string | undefined,
  now: string,
): Promise<string[]> {
  const itemIds = uniqueIds(ids);
  if (!itemIds.length) return [];

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await Promise.all(itemIds.map((id) => requestToPromise<SyncOutboxItem | undefined>(store.get(id))));
  const updatedIds: string[] = [];
  items.forEach((item) => {
    if (!item) return;
    const next =
      status === 'sending'
        ? { ...item, status, lastError: undefined, updatedAt: now }
        : withoutLease(item, status, now, lastError);
    store.put(next);
    updatedIds.push(item.id);
  });
  await done;
  return updatedIds;
}

export async function settleUnclaimedSyncOutboxItemsInDatabase(
  db: IDBDatabase,
  ids: string[],
  status: 'pending' | 'failed' | 'sent',
  now: string,
  lastError?: string,
): Promise<SyncOutboxMutationResult> {
  const itemIds = uniqueIds(ids);
  if (!itemIds.length) return { updatedIds: [], skippedIds: [] };

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await Promise.all(itemIds.map((id) => requestToPromise<SyncOutboxItem | undefined>(store.get(id))));
  const updatedIds: string[] = [];
  const skippedIds: string[] = [];
  items.forEach((item, index) => {
    if (!item || !claimableStatuses.has(item.status)) {
      skippedIds.push(itemIds[index]);
      return;
    }
    store.put(withoutLease(item, status, now, lastError));
    updatedIds.push(item.id);
  });
  await done;
  return { updatedIds, skippedIds };
}

export async function recoverStaleSendingOutboxInDatabase(db: IDBDatabase, now: string): Promise<string[]> {
  const nowTimestamp = assertIsoDate(now, 'now');
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const sending = await requestToPromise<SyncOutboxItem[]>(store.index('status').getAll('sending'));
  const recoveredIds: string[] = [];

  sending.forEach((item) => {
    const leaseExpiry = item.leaseExpiresAt ? Date.parse(item.leaseExpiresAt) : Number.NaN;
    const expired = !item.leaseToken || !Number.isFinite(leaseExpiry) || leaseExpiry <= nowTimestamp;
    if (!expired) return;
    store.put(withoutLease(item, 'pending', now));
    recoveredIds.push(item.id);
  });
  await done;
  return recoveredIds;
}

export async function claimSyncOutboxBatchInDatabase(
  db: IDBDatabase,
  options: ClaimSyncOutboxBatchOptions,
): Promise<SyncOutboxItem[]> {
  if (!options.leaseToken.trim()) throw new Error('leaseToken is required');
  const nowTimestamp = assertIsoDate(options.now, 'now');
  const leaseExpiry = assertIsoDate(options.leaseExpiresAt, 'leaseExpiresAt');
  if (leaseExpiry <= nowTimestamp) throw new Error('leaseExpiresAt must be later than now');
  if (options.candidateIds && options.candidateIds.length === 0) return [];

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const requestedIds = options.candidateIds ? uniqueIds(options.candidateIds) : undefined;
  const candidates = requestedIds
    ? await Promise.all(requestedIds.map((id) => requestToPromise<SyncOutboxItem | undefined>(store.get(id))))
    : (
        await Promise.all(
          (['pending', 'failed'] as const).map((status) =>
            requestToPromise<SyncOutboxItem[]>(store.index('status').getAll(status)),
          ),
        )
      ).flat();
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER));
  const claimed = sorted(candidates.filter((item): item is SyncOutboxItem => Boolean(item)))
    .filter((item) => claimableStatuses.has(item.status))
    .slice(0, limit)
    .map((item) => ({
      ...item,
      status: 'sending' as const,
      attemptCount: (item.attemptCount ?? 0) + 1,
      lastAttemptAt: options.now,
      leaseToken: options.leaseToken,
      leaseExpiresAt: options.leaseExpiresAt,
      lastError: undefined,
      updatedAt: options.now,
    }));
  claimed.forEach((item) => store.put(item));
  await done;
  return claimed;
}

export async function settleClaimedSyncOutboxItemsInDatabase(
  db: IDBDatabase,
  leaseToken: string,
  settlements: SyncOutboxSettlement[],
  now: string,
): Promise<SyncOutboxMutationResult> {
  const settlementById = new Map(settlements.map((settlement) => [settlement.id, settlement]));
  const itemIds = uniqueIds(Array.from(settlementById.keys()));
  if (!itemIds.length) return { updatedIds: [], skippedIds: [] };

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await Promise.all(itemIds.map((id) => requestToPromise<SyncOutboxItem | undefined>(store.get(id))));
  const updatedIds: string[] = [];
  const skippedIds: string[] = [];
  items.forEach((item, index) => {
    const settlement = settlementById.get(itemIds[index]);
    if (!item || item.status !== 'sending' || item.leaseToken !== leaseToken || !settlement) {
      skippedIds.push(itemIds[index]);
      return;
    }
    store.put(withoutLease(item, settlement.status, now, settlement.lastError));
    updatedIds.push(item.id);
  });
  await done;
  return { updatedIds, skippedIds };
}

export function releaseClaimedSyncOutboxItemsInDatabase(
  db: IDBDatabase,
  leaseToken: string,
  ids: string[],
  status: 'pending' | 'failed',
  now: string,
  lastError?: string,
): Promise<SyncOutboxMutationResult> {
  return settleClaimedSyncOutboxItemsInDatabase(
    db,
    leaseToken,
    uniqueIds(ids).map((id) => ({ id, status, lastError })),
    now,
  );
}
