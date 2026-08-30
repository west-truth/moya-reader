import type {
  ExternalCatalogCachePage,
  ExternalSourceBrowseMode,
  ExternalSourceCredentialRecord,
  ExternalSourceFilterChange,
  ExternalSourceFilterValue,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from './contracts';
import { createExternalSourceCredentialKey } from './device-credential-crypto';
import { externalSerialBookId } from './serial-identity';

const DB_NAME = 'noveldesk-external-sources';
const DB_VERSION = 6;
const MAX_CACHE_PAGES_PER_CONNECTION = 24;
const CREDENTIAL_KEY_ID = 'external-source-credentials-v1';

let dbPromise: Promise<IDBDatabase> | undefined;
let credentialKeyPromise: Promise<CryptoKey> | undefined;

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

function openExternalSourceDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('credentials')) {
        const store = db.createObjectStore('credentials', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
      }
      if (!db.objectStoreNames.contains('cachePages')) {
        const store = db.createObjectStore('cachePages', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
        store.createIndex('accountConnectionId', 'accountConnectionId');
      }
      if (!db.objectStoreNames.contains('links')) {
        const store = db.createObjectStore('links', { keyPath: 'id' });
        store.createIndex('connectorId', 'source.connectorId');
        store.createIndex('localBookId', 'localBookId');
      }
      if (!db.objectStoreNames.contains('credentialKeys')) {
        db.createObjectStore('credentialKeys', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('browsePreferences')) {
        const store = db.createObjectStore('browsePreferences', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
      }
      if (!db.objectStoreNames.contains('selectedItems')) {
        const store = db.createObjectStore('selectedItems', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
        store.createIndex('accountConnectionId', 'accountConnectionId');
      }
      if (!db.objectStoreNames.contains('subscriptions')) {
        const store = db.createObjectStore('subscriptions', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
        store.createIndex('accountConnectionId', 'accountConnectionId');
      }
      if (!db.objectStoreNames.contains('associationPurgeIntents')) {
        db.createObjectStore('associationPurgeIntents', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (dbPromise === opening) dbPromise = undefined;
      reject(request.error);
    };
  });
  dbPromise = opening;
  return opening;
}

export interface ExternalSourceFolderBreadcrumb {
  readonly label: string;
  readonly parentRef: string;
}

export interface ExternalSourceDefaultFolder {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly parentRef: string;
  readonly breadcrumbs: readonly ExternalSourceFolderBreadcrumb[];
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export function externalSourceDefaultFolderId(connectorId: string, accountConnectionId: string | undefined): string {
  return ['external-source-default-folder', connectorId, accountConnectionId ?? ''].join('::');
}

export interface ExternalSourceCatalogPreference {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly parentRef: string;
  readonly browseMode: Exclude<ExternalSourceBrowseMode, 'search'>;
  readonly filterValues: Readonly<Record<string, ExternalSourceFilterValue>>;
  readonly filters: readonly ExternalSourceFilterChange[];
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export function externalSourceCatalogPreferenceId(
  connectorId: string,
  accountConnectionId: string | undefined,
  parentRef: string,
): string {
  return ['external-source-catalog-preference', connectorId, accountConnectionId ?? '', parentRef].join('::');
}

export interface ExternalSourceSubscriptionRecord {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly collectionRemoteId: string;
  readonly navigationRef: string;
  readonly sourceNavigationRef?: string;
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
  readonly sourceLabel?: string;
  readonly knownReleaseIds: readonly string[];
  readonly newReleaseIds: readonly string[];
  readonly availableReleaseCount: number;
  readonly lastCheckedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export interface ExternalSourceAssociationSnapshotEntry {
  readonly id: string;
  readonly localBookId: string;
  readonly activeContentRevisionId?: string;
  readonly version: string;
}

export interface ExternalSourceAssociationPurgeSnapshot {
  readonly entries: readonly ExternalSourceAssociationSnapshotEntry[];
  readonly subscriptions: readonly { readonly id: string; readonly version: string; readonly localBookId: string }[];
}

export interface ExternalSourceAssociationPurgeTarget {
  readonly bookId: string;
  readonly activeContentRevisionId?: string;
}

export interface ExternalSourceAssociationPurgeIntent {
  readonly id: string;
  readonly targets: readonly ExternalSourceAssociationPurgeTarget[];
  readonly snapshot: ExternalSourceAssociationPurgeSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

function externalSourceLinkVersion(link: ExternalSourceLink): string {
  return JSON.stringify([
    link.id,
    link.source.connectorId,
    link.source.accountConnectionId ?? '',
    link.source.remoteId,
    link.localBookId,
    link.collectionRemoteId ?? '',
    link.importedRemoteRevision ?? '',
    link.importedSourceContentHash ?? '',
    link.activeContentRevisionId ?? '',
    link.linkedAt,
    link.lastCheckedAt ?? '',
    link.pendingImport?.operationId ?? '',
    link.pendingImport?.stagedAt ?? '',
    link.pendingImport?.hadExistingLink ?? false,
    link.pendingImport?.expectedActiveSourceContentHash ?? '',
    link.pendingImport?.previousActiveContentRevisionId ?? '',
    link.pendingImport?.activatedContentRevisionId ?? '',
    link.pendingImport?.sourceHashResolvedByImporter ?? false,
    link.pendingImport?.collectionRemoteId ?? '',
    link.pendingImport?.importedRemoteRevision ?? '',
    link.pendingImport?.importedSourceContentHash ?? '',
  ]);
}

function externalSourceSubscriptionVersion(subscription: ExternalSourceSubscriptionRecord): string {
  return JSON.stringify([
    subscription.id,
    subscription.connectorId,
    subscription.accountConnectionId ?? '',
    subscription.collectionRemoteId,
    subscription.navigationRef,
    subscription.sourceNavigationRef ?? '',
    subscription.title,
    subscription.author ?? '',
    subscription.description ?? '',
    subscription.thumbnailUrl ?? '',
    subscription.sourceLabel ?? '',
    subscription.knownReleaseIds,
    subscription.newReleaseIds,
    subscription.availableReleaseCount,
    subscription.lastCheckedAt,
    subscription.createdAt,
    subscription.updatedAt,
  ]);
}

function sameContentRevision(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '') === (right ?? '');
}

function uniquePurgeTargets(
  targets: readonly ExternalSourceAssociationPurgeTarget[],
): ExternalSourceAssociationPurgeTarget[] {
  const byBookId = new Map<string, ExternalSourceAssociationPurgeTarget>();
  for (const target of targets) {
    if (!target.bookId) continue;
    const existing = byBookId.get(target.bookId);
    if (existing && !sameContentRevision(existing.activeContentRevisionId, target.activeContentRevisionId)) {
      throw new Error(`Book ${target.bookId} has multiple content incarnations in one purge intent`);
    }
    byBookId.set(target.bookId, target);
  }
  return [...byBookId.values()];
}

function associationPurgeIntentId(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(4));
  return `external-association-purge::${[...bytes].map((value) => value.toString(16).padStart(8, '0')).join('')}`;
}

interface AssociationCleanupPlan {
  readonly deleteLinkIds: readonly string[];
  readonly deleteSubscriptionIds: readonly string[];
  readonly unresolvedBookIds: ReadonlySet<string>;
}

function associationCleanupPlan(input: {
  readonly targets: readonly ExternalSourceAssociationPurgeTarget[];
  readonly snapshot: ExternalSourceAssociationPurgeSnapshot;
  readonly links: readonly ExternalSourceLink[];
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
}): AssociationCleanupPlan {
  const targetByBookId = new Map(input.targets.map((target) => [target.bookId, target]));
  const expectedLinks = new Map(input.snapshot.entries.map((entry) => [entry.id, entry]));
  const currentLinks = new Map(input.links.map((link) => [link.id, link]));
  const unresolvedBookIds = new Set<string>();
  const deleteLinkIds: string[] = [];

  for (const expected of expectedLinks.values()) {
    const target = targetByBookId.get(expected.localBookId);
    if (!target) continue;
    const current = currentLinks.get(expected.id);
    if (!current) continue;
    if (
      current.localBookId !== target.bookId ||
      !sameContentRevision(current.activeContentRevisionId, expected.activeContentRevisionId)
    ) {
      continue;
    }
    // A staged import can become the next content incarnation. Leave the
    // intent pending until that operation finalizes or is rolled back.
    if (current.pendingImport) {
      unresolvedBookIds.add(target.bookId);
      continue;
    }
    deleteLinkIds.push(current.id);
  }

  const deletedLinks = new Set(deleteLinkIds);
  const remainingLinks = input.links.filter((link) => !deletedLinks.has(link.id));
  const currentSubscriptions = new Map(input.subscriptions.map((subscription) => [subscription.id, subscription]));
  const expectedSubscriptions = new Map(
    input.snapshot.subscriptions.map((subscription) => [subscription.id, subscription]),
  );
  const materializedCollections = new Map<
    string,
    { readonly connectorId: string; readonly accountConnectionId?: string; readonly collectionRemoteId: string }
  >();

  for (const linkId of deleteLinkIds) {
    const link = currentLinks.get(linkId);
    if (!link?.collectionRemoteId) continue;
    const subscriptionId = externalSourceSubscriptionId(
      link.source.connectorId,
      link.source.accountConnectionId,
      link.collectionRemoteId,
    );
    materializedCollections.set(subscriptionId, {
      connectorId: link.source.connectorId,
      accountConnectionId: link.source.accountConnectionId,
      collectionRemoteId: link.collectionRemoteId,
    });
  }
  for (const expected of input.snapshot.subscriptions) {
    if (!targetByBookId.has(expected.localBookId)) continue;
    const current = currentSubscriptions.get(expected.id);
    if (!current) continue;
    materializedCollections.set(expected.id, {
      connectorId: current.connectorId,
      accountConnectionId: current.accountConnectionId,
      collectionRemoteId: current.collectionRemoteId,
    });
  }

  const deleteSubscriptionIds: string[] = [];
  for (const [subscriptionId, collection] of materializedCollections) {
    const current = currentSubscriptions.get(subscriptionId);
    const expected = expectedSubscriptions.get(subscriptionId);
    const stillMaterialized = remainingLinks.some(
      (link) =>
        link.collectionRemoteId === collection.collectionRemoteId &&
        link.source.connectorId === collection.connectorId &&
        link.source.accountConnectionId === collection.accountConnectionId,
    );
    if (
      !stillMaterialized &&
      current &&
      (!expected || expected.version === externalSourceSubscriptionVersion(current))
    ) {
      deleteSubscriptionIds.push(subscriptionId);
    }
  }

  return { deleteLinkIds, deleteSubscriptionIds, unresolvedBookIds };
}

export function externalSourceSubscriptionId(
  connectorId: string,
  accountConnectionId: string | undefined,
  collectionRemoteId: string,
): string {
  return ['external-source-subscription', connectorId, accountConnectionId ?? '', collectionRemoteId].join('::');
}

export interface ExternalSourceLocalState {
  getOrCreateCredentialKey(): Promise<CryptoKey>;
  getCredential(connectorId: string): Promise<ExternalSourceCredentialRecord | undefined>;
  saveCredential(record: ExternalSourceCredentialRecord): Promise<void>;
  deleteCredential(connectorId: string): Promise<void>;
  getCachePage(id: string): Promise<ExternalCatalogCachePage | undefined>;
  saveCachePage(page: ExternalCatalogCachePage): Promise<void>;
  clearCache(connectorId: string, accountConnectionId?: string): Promise<void>;
  listLinks(connectorId?: string): Promise<ExternalSourceLink[]>;
  saveLink(link: ExternalSourceLink): Promise<void>;
  saveLinks?(links: readonly ExternalSourceLink[]): Promise<void>;
  deleteLinks?(ids: readonly string[]): Promise<void>;
  replaceLinks?(links: readonly ExternalSourceLink[], deleteIds: readonly string[]): Promise<void>;
  acquirePendingLinks?(links: readonly ExternalSourceLink[]): Promise<boolean>;
  compareAndSwapPendingLinks?(
    expected: readonly { readonly id: string; readonly operationId: string }[],
    links: readonly ExternalSourceLink[],
    deleteIds: readonly string[],
  ): Promise<boolean>;
  getDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<ExternalSourceDefaultFolder | undefined>;
  saveDefaultFolder(folder: ExternalSourceDefaultFolder): Promise<void>;
  deleteDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<void>;
  getCatalogPreference(
    connectorId: string,
    accountConnectionId: string | undefined,
    parentRef: string,
  ): Promise<ExternalSourceCatalogPreference | undefined>;
  saveCatalogPreference(preference: ExternalSourceCatalogPreference): Promise<void>;
  listSubscriptions(connectorId?: string, accountConnectionId?: string): Promise<ExternalSourceSubscriptionRecord[]>;
  saveSubscription(subscription: ExternalSourceSubscriptionRecord): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
  captureBookAssociations?(): Promise<ExternalSourceAssociationPurgeSnapshot>;
  /**
   * Removes device-local bindings after the corresponding books have been
   * permanently deleted. A subscription is removed only when it was
   * materialized by one of those bindings and no binding for the same remote
   * collection remains.
   *
   * Moving a book to trash must not call this method: bindings intentionally
   * survive until the canonical book is purged.
   */
  purgeBookAssociations?(
    bookIds: readonly string[],
    snapshot: ExternalSourceAssociationPurgeSnapshot,
  ): Promise<void>;
  prepareBookAssociationPurge?(
    targets: readonly ExternalSourceAssociationPurgeTarget[],
  ): Promise<ExternalSourceAssociationPurgeIntent>;
  completeBookAssociationPurge?(intentId: string, confirmedBookIds?: readonly string[]): Promise<number>;
  reconcileBookAssociationPurges?(
    currentBooks: readonly ExternalSourceAssociationPurgeTarget[],
    purgeEvidence?: readonly ExternalSourceAssociationPurgeTarget[],
  ): Promise<number>;
  listSelectedItems(connectorId: string, accountConnectionId: string): Promise<ExternalSourceSelectionRecord[]>;
  saveSelectedItem(record: ExternalSourceSelectionRecord): Promise<void>;
  deleteSelectedItem(id: string): Promise<void>;
}

export class ExternalSourceLocalStateStore implements ExternalSourceLocalState {
  async getOrCreateCredentialKey(): Promise<CryptoKey> {
    if (credentialKeyPromise) return credentialKeyPromise;
    credentialKeyPromise = this.loadOrCreateCredentialKey().catch((error) => {
      credentialKeyPromise = undefined;
      throw error;
    });
    return credentialKeyPromise;
  }

  private async loadOrCreateCredentialKey(): Promise<CryptoKey> {
    const db = await openExternalSourceDb();
    const readTx = db.transaction('credentialKeys', 'readonly');
    const existing = await requestToPromise<{ id: string; key: CryptoKey } | undefined>(
      readTx.objectStore('credentialKeys').get(CREDENTIAL_KEY_ID),
    );
    if (existing?.key) return existing.key;

    const key = await createExternalSourceCredentialKey();
    const writeTx = db.transaction('credentialKeys', 'readwrite');
    writeTx.objectStore('credentialKeys').put({ id: CREDENTIAL_KEY_ID, key, createdAt: new Date().toISOString() });
    await transactionDone(writeTx);
    return key;
  }

  async getCredential(connectorId: string): Promise<ExternalSourceCredentialRecord | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('credentials', 'readonly');
    const records = await requestToPromise<ExternalSourceCredentialRecord[]>(
      tx.objectStore('credentials').index('connectorId').getAll(IDBKeyRange.only(connectorId)),
    );
    return records[0];
  }

  async saveCredential(record: ExternalSourceCredentialRecord): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').put(record);
    await transactionDone(tx);
  }

  async deleteCredential(connectorId: string): Promise<void> {
    const record = await this.getCredential(connectorId);
    if (!record) return;
    const db = await openExternalSourceDb();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').delete(record.id);
    await transactionDone(tx);
  }

  async getCachePage(id: string): Promise<ExternalCatalogCachePage | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('cachePages', 'readonly');
    return requestToPromise<ExternalCatalogCachePage | undefined>(tx.objectStore('cachePages').get(id));
  }

  async saveCachePage(page: ExternalCatalogCachePage): Promise<void> {
    const db = await openExternalSourceDb();
    const existingTx = db.transaction('cachePages', 'readonly');
    const existing = await requestToPromise<ExternalCatalogCachePage[]>(
      existingTx.objectStore('cachePages').index('connectorId').getAll(IDBKeyRange.only(page.connectorId)),
    );
    const sameConnection = existing
      .filter((item) => item.accountConnectionId === page.accountConnectionId && item.id !== page.id)
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));

    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    store.put(page);
    sameConnection.slice(MAX_CACHE_PAGES_PER_CONNECTION - 1).forEach((item) => store.delete(item.id));
    await transactionDone(tx);
  }

  async clearCache(connectorId: string, accountConnectionId?: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    const request = store.index('connectorId').openCursor(IDBKeyRange.only(connectorId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const page = cursor.value as ExternalCatalogCachePage;
      if (accountConnectionId === undefined || page.accountConnectionId === accountConnectionId) cursor.delete();
      cursor.continue();
    };
    await transactionDone(tx);
  }

  async listLinks(connectorId?: string): Promise<ExternalSourceLink[]> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readonly');
    const store = tx.objectStore('links');
    return connectorId
      ? requestToPromise<ExternalSourceLink[]>(store.index('connectorId').getAll(IDBKeyRange.only(connectorId)))
      : requestToPromise<ExternalSourceLink[]>(store.getAll());
  }

  async saveLink(link: ExternalSourceLink): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    tx.objectStore('links').put(link);
    await transactionDone(tx);
  }

  async saveLinks(links: readonly ExternalSourceLink[]): Promise<void> {
    if (links.length === 0) return;
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    links.forEach((link) => store.put(link));
    await transactionDone(tx);
  }

  async deleteLinks(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    ids.forEach((id) => store.delete(id));
    await transactionDone(tx);
  }

  async replaceLinks(links: readonly ExternalSourceLink[], deleteIds: readonly string[]): Promise<void> {
    if (links.length === 0 && deleteIds.length === 0) return;
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    links.forEach((link) => store.put(link));
    deleteIds.forEach((id) => store.delete(id));
    await transactionDone(tx);
  }

  async acquirePendingLinks(links: readonly ExternalSourceLink[]): Promise<boolean> {
    if (links.length === 0 || links.some((link) => !link.pendingImport)) return false;
    if (new Set(links.map((link) => link.id)).size !== links.length) return false;
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('links');
    const current = await Promise.all(
      links.map((link) => requestToPromise<ExternalSourceLink | undefined>(store.get(link.id))),
    );
    const canAcquire = links.every((staged, index) => {
      const pending = staged.pendingImport!;
      const existing = current[index];
      if (existing?.pendingImport) return existing.pendingImport.operationId === pending.operationId;
      if (!pending.hadExistingLink) return existing === undefined;
      return (
        existing !== undefined &&
        existing.localBookId === staged.localBookId &&
        existing.source.connectorId === staged.source.connectorId &&
        existing.source.accountConnectionId === staged.source.accountConnectionId &&
        existing.source.remoteId === staged.source.remoteId &&
        existing.importedRemoteRevision === staged.importedRemoteRevision &&
        existing.importedSourceContentHash === staged.importedSourceContentHash &&
        existing.activeContentRevisionId === staged.activeContentRevisionId &&
        existing.linkedAt === staged.linkedAt
      );
    });
    if (!canAcquire) {
      await done;
      return false;
    }
    links.forEach((link, index) => {
      if (current[index]?.pendingImport?.operationId !== link.pendingImport!.operationId) store.put(link);
    });
    await done;
    return true;
  }

  async compareAndSwapPendingLinks(
    expected: readonly { readonly id: string; readonly operationId: string }[],
    links: readonly ExternalSourceLink[],
    deleteIds: readonly string[],
  ): Promise<boolean> {
    if (expected.length === 0) return false;
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('links');
    const current = await Promise.all(
      expected.map(({ id }) => requestToPromise<ExternalSourceLink | undefined>(store.get(id))),
    );
    if (current.some((link, index) => link?.pendingImport?.operationId !== expected[index]?.operationId)) {
      await done;
      return false;
    }
    links.forEach((link) => store.put(link));
    deleteIds.forEach((id) => store.delete(id));
    await done;
    return true;
  }

  async getDefaultFolder(
    connectorId: string,
    accountConnectionId?: string,
  ): Promise<ExternalSourceDefaultFolder | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readonly');
    return requestToPromise<ExternalSourceDefaultFolder | undefined>(
      tx.objectStore('browsePreferences').get(externalSourceDefaultFolderId(connectorId, accountConnectionId)),
    );
  }

  async saveDefaultFolder(folder: ExternalSourceDefaultFolder): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').put(folder);
    await transactionDone(tx);
  }

  async deleteDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').delete(externalSourceDefaultFolderId(connectorId, accountConnectionId));
    await transactionDone(tx);
  }

  async getCatalogPreference(
    connectorId: string,
    accountConnectionId: string | undefined,
    parentRef: string,
  ): Promise<ExternalSourceCatalogPreference | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readonly');
    return requestToPromise<ExternalSourceCatalogPreference | undefined>(
      tx
        .objectStore('browsePreferences')
        .get(externalSourceCatalogPreferenceId(connectorId, accountConnectionId, parentRef)),
    );
  }

  async saveCatalogPreference(preference: ExternalSourceCatalogPreference): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').put(preference);
    await transactionDone(tx);
  }

  async listSubscriptions(
    connectorId?: string,
    accountConnectionId?: string,
  ): Promise<ExternalSourceSubscriptionRecord[]> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('subscriptions', 'readonly');
    const store = tx.objectStore('subscriptions');
    const records = connectorId
      ? await requestToPromise<ExternalSourceSubscriptionRecord[]>(
          store.index('connectorId').getAll(IDBKeyRange.only(connectorId)),
        )
      : await requestToPromise<ExternalSourceSubscriptionRecord[]>(store.getAll());
    return records
      .filter((record) => accountConnectionId === undefined || record.accountConnectionId === accountConnectionId)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }

  async saveSubscription(subscription: ExternalSourceSubscriptionRecord): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('subscriptions', 'readwrite');
    tx.objectStore('subscriptions').put(subscription);
    await transactionDone(tx);
  }

  async deleteSubscription(id: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('subscriptions', 'readwrite');
    tx.objectStore('subscriptions').delete(id);
    await transactionDone(tx);
  }

  async captureBookAssociations(): Promise<ExternalSourceAssociationPurgeSnapshot> {
    const db = await openExternalSourceDb();
    const tx = db.transaction(['links', 'subscriptions'], 'readonly');
    const [links, subscriptions] = await Promise.all([
      requestToPromise<ExternalSourceLink[]>(tx.objectStore('links').getAll()),
      requestToPromise<ExternalSourceSubscriptionRecord[]>(tx.objectStore('subscriptions').getAll()),
    ]);
    await transactionDone(tx);
    return {
      entries: links.map((link) => ({
        id: link.id,
        localBookId: link.localBookId,
        activeContentRevisionId: link.activeContentRevisionId,
        version: externalSourceLinkVersion(link),
      })),
      subscriptions: subscriptions.map((subscription) => ({
        id: subscription.id,
        version: externalSourceSubscriptionVersion(subscription),
        localBookId: externalSerialBookId(subscription),
      })),
    };
  }

  async purgeBookAssociations(
    bookIds: readonly string[],
    snapshot: ExternalSourceAssociationPurgeSnapshot,
  ): Promise<void> {
    const targetBookIds = new Set(bookIds.filter(Boolean));
    if (targetBookIds.size === 0) return;

    const db = await openExternalSourceDb();
    const tx = db.transaction(['links', 'subscriptions'], 'readwrite');
    const done = transactionDone(tx);
    const linksStore = tx.objectStore('links');
    const subscriptionsStore = tx.objectStore('subscriptions');
    const [links, subscriptions] = await Promise.all([
      requestToPromise<ExternalSourceLink[]>(linksStore.getAll()),
      requestToPromise<ExternalSourceSubscriptionRecord[]>(subscriptionsStore.getAll()),
    ]);
    const targetsByBookId = new Map(
      snapshot.entries
        .filter((entry) => targetBookIds.has(entry.localBookId))
        .map((entry) => [
          entry.localBookId,
          { bookId: entry.localBookId, activeContentRevisionId: entry.activeContentRevisionId },
        ]),
    );
    for (const subscription of snapshot.subscriptions) {
      if (targetBookIds.has(subscription.localBookId) && !targetsByBookId.has(subscription.localBookId)) {
        targetsByBookId.set(subscription.localBookId, {
          bookId: subscription.localBookId,
          activeContentRevisionId: undefined,
        });
      }
    }
    const plan = associationCleanupPlan({
      targets: [...targetsByBookId.values()],
      snapshot,
      links,
      subscriptions,
    });
    for (const id of plan.deleteLinkIds) linksStore.delete(id);
    for (const id of plan.deleteSubscriptionIds) subscriptionsStore.delete(id);

    await done;
  }

  async prepareBookAssociationPurge(
    inputTargets: readonly ExternalSourceAssociationPurgeTarget[],
  ): Promise<ExternalSourceAssociationPurgeIntent> {
    const targets = uniquePurgeTargets(inputTargets);
    if (targets.length === 0) throw new Error('A purge intent requires at least one book generation');
    const targetByBookId = new Map(targets.map((target) => [target.bookId, target]));
    const db = await openExternalSourceDb();
    const tx = db.transaction(['links', 'subscriptions', 'associationPurgeIntents'], 'readwrite');
    const done = transactionDone(tx);
    const [links, subscriptions] = await Promise.all([
      requestToPromise<ExternalSourceLink[]>(tx.objectStore('links').getAll()),
      requestToPromise<ExternalSourceSubscriptionRecord[]>(tx.objectStore('subscriptions').getAll()),
    ]);
    const snapshot: ExternalSourceAssociationPurgeSnapshot = {
      entries: links
        .filter((link) => targetByBookId.has(link.localBookId))
        .map((link) => ({
          id: link.id,
          localBookId: link.localBookId,
          activeContentRevisionId: link.activeContentRevisionId,
          version: externalSourceLinkVersion(link),
        })),
      subscriptions: subscriptions
        .map((subscription) => ({
          id: subscription.id,
          version: externalSourceSubscriptionVersion(subscription),
          localBookId: externalSerialBookId(subscription),
        }))
        .filter((subscription) => targetByBookId.has(subscription.localBookId)),
    };
    const now = new Date().toISOString();
    const intent: ExternalSourceAssociationPurgeIntent = {
      id: associationPurgeIntentId(),
      targets,
      snapshot,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    tx.objectStore('associationPurgeIntents').put(intent);
    await done;
    return intent;
  }

  async completeBookAssociationPurge(intentId: string, confirmedBookIds?: readonly string[]): Promise<number> {
    const db = await openExternalSourceDb();
    const tx = db.transaction(['links', 'subscriptions', 'associationPurgeIntents'], 'readwrite');
    const done = transactionDone(tx);
    const intentStore = tx.objectStore('associationPurgeIntents');
    const [intent, links, subscriptions] = await Promise.all([
      requestToPromise<ExternalSourceAssociationPurgeIntent | undefined>(intentStore.get(intentId)),
      requestToPromise<ExternalSourceLink[]>(tx.objectStore('links').getAll()),
      requestToPromise<ExternalSourceSubscriptionRecord[]>(tx.objectStore('subscriptions').getAll()),
    ]);
    if (!intent) {
      await done;
      return 0;
    }
    const confirmed = new Set(confirmedBookIds ?? intent.targets.map((target) => target.bookId));
    const targets = intent.targets.filter((target) => confirmed.has(target.bookId));
    const plan = associationCleanupPlan({ targets, snapshot: intent.snapshot, links, subscriptions });
    for (const id of plan.deleteLinkIds) tx.objectStore('links').delete(id);
    for (const id of plan.deleteSubscriptionIds) tx.objectStore('subscriptions').delete(id);
    const remainingTargets = intent.targets.filter(
      (target) => !confirmed.has(target.bookId) || plan.unresolvedBookIds.has(target.bookId),
    );
    if (remainingTargets.length === 0) {
      intentStore.delete(intent.id);
    } else {
      intentStore.put({ ...intent, targets: remainingTargets, updatedAt: new Date().toISOString() });
    }
    await done;
    return plan.deleteLinkIds.length + plan.deleteSubscriptionIds.length;
  }

  async reconcileBookAssociationPurges(
    inputCurrentBooks: readonly ExternalSourceAssociationPurgeTarget[],
    inputPurgeEvidence: readonly ExternalSourceAssociationPurgeTarget[] = [],
  ): Promise<number> {
    const currentBooks = uniquePurgeTargets(inputCurrentBooks);
    const purgeEvidence = uniquePurgeTargets(inputPurgeEvidence);
    const currentBookById = new Map(currentBooks.map((book) => [book.bookId, book]));
    const db = await openExternalSourceDb();
    const tx = db.transaction(['links', 'subscriptions', 'associationPurgeIntents'], 'readwrite');
    const done = transactionDone(tx);
    const linksStore = tx.objectStore('links');
    const subscriptionsStore = tx.objectStore('subscriptions');
    const intentStore = tx.objectStore('associationPurgeIntents');
    const [initialLinks, initialSubscriptions, intents] = await Promise.all([
      requestToPromise<ExternalSourceLink[]>(linksStore.getAll()),
      requestToPromise<ExternalSourceSubscriptionRecord[]>(subscriptionsStore.getAll()),
      requestToPromise<ExternalSourceAssociationPurgeIntent[]>(intentStore.getAll()),
    ]);
    const links = new Map(initialLinks.map((link) => [link.id, link]));
    const subscriptions = new Map(initialSubscriptions.map((subscription) => [subscription.id, subscription]));
    let changed = 0;

    const applyPlan = (plan: AssociationCleanupPlan) => {
      for (const id of plan.deleteLinkIds) {
        linksStore.delete(id);
        links.delete(id);
        changed += 1;
      }
      for (const id of plan.deleteSubscriptionIds) {
        subscriptionsStore.delete(id);
        subscriptions.delete(id);
        changed += 1;
      }
    };

    for (const intent of intents) {
      const confirmedTargets = intent.targets.filter((target) => {
        const current = currentBookById.get(target.bookId);
        return !current || !sameContentRevision(current.activeContentRevisionId, target.activeContentRevisionId);
      });
      if (confirmedTargets.length === 0) continue;
      const plan = associationCleanupPlan({
        targets: confirmedTargets,
        snapshot: intent.snapshot,
        links: [...links.values()],
        subscriptions: [...subscriptions.values()],
      });
      applyPlan(plan);
      const confirmedIds = new Set(confirmedTargets.map((target) => target.bookId));
      const remainingTargets = intent.targets.filter(
        (target) => !confirmedIds.has(target.bookId) || plan.unresolvedBookIds.has(target.bookId),
      );
      if (remainingTargets.length === 0) intentStore.delete(intent.id);
      else intentStore.put({ ...intent, targets: remainingTargets, updatedAt: new Date().toISOString() });
    }

    // Pulled book_purged events leave durable reader tombstones. They do not
    // have a cross-database intent, so clean only finalized links that no
    // longer name the currently projected generation. A subscription without
    // such a link is ambiguous (it can be source-only) and is preserved.
    for (const evidence of purgeEvidence) {
      const liveGeneration = currentBookById.get(evidence.bookId);
      const evidenceLinks = [...links.values()].filter(
        (link) =>
          !link.pendingImport &&
          link.localBookId === evidence.bookId &&
          (!liveGeneration ||
            !sameContentRevision(link.activeContentRevisionId, liveGeneration.activeContentRevisionId)),
      );
      if (evidenceLinks.length === 0) continue;
      const snapshot: ExternalSourceAssociationPurgeSnapshot = {
        entries: evidenceLinks.map((link) => ({
          id: link.id,
          localBookId: link.localBookId,
          activeContentRevisionId: link.activeContentRevisionId,
          version: externalSourceLinkVersion(link),
        })),
        subscriptions: [],
      };
      applyPlan(
        associationCleanupPlan({
          targets: [evidence],
          snapshot,
          links: [...links.values()],
          subscriptions: [...subscriptions.values()],
        }),
      );
    }

    await done;
    return changed;
  }

  async listSelectedItems(connectorId: string, accountConnectionId: string): Promise<ExternalSourceSelectionRecord[]> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('selectedItems', 'readonly');
    const records = await requestToPromise<ExternalSourceSelectionRecord[]>(
      tx.objectStore('selectedItems').index('connectorId').getAll(IDBKeyRange.only(connectorId)),
    );
    return records
      .filter((record) => record.accountConnectionId === accountConnectionId)
      .sort((left, right) => right.selectedAt.localeCompare(left.selectedAt) || left.id.localeCompare(right.id));
  }

  async saveSelectedItem(record: ExternalSourceSelectionRecord): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('selectedItems', 'readwrite');
    tx.objectStore('selectedItems').put(record);
    await transactionDone(tx);
  }

  async deleteSelectedItem(id: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('selectedItems', 'readwrite');
    tx.objectStore('selectedItems').delete(id);
    await transactionDone(tx);
  }
}

export async function resetExternalSourceLocalStateForTests(): Promise<void> {
  dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = undefined;
  credentialKeyPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('External source database deletion is blocked.'));
  });
}
