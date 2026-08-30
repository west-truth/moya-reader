import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ExternalCatalogCachePage,
  ExternalSourceCredentialRecord,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from './contracts';
import { externalSourceLinkId } from './contracts';
import {
  externalSourceCatalogPreferenceId,
  externalSourceDefaultFolderId,
  externalSourceSubscriptionId,
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from './local-state';

const connectorId = 'moya.external.fixture.files';

describe('ExternalSourceLocalStateStore', () => {
  beforeEach(async () => resetExternalSourceLocalStateForTests());

  it('keeps encrypted credentials, metadata cache and remote links in the source-local database', async () => {
    const store = new ExternalSourceLocalStateStore();
    const firstKey = await store.getOrCreateCredentialKey();
    const restoredKey = await new ExternalSourceLocalStateStore().getOrCreateCredentialKey();
    expect(firstKey).toBe(restoredKey);
    expect(firstKey.extractable).toBe(false);
    const credential: ExternalSourceCredentialRecord = {
      id: 'credential-1',
      connectorId,
      accountConnectionId: 'account-1',
      label: 'Dropbox',
      credentialEnvelope: 'encrypted-only',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const cache: ExternalCatalogCachePage = {
      id: 'cache-1',
      connectorId,
      accountConnectionId: 'account-1',
      queryFingerprint: '{}',
      items: [],
      fetchedAt: '2026-08-24T00:00:00.000Z',
      expiresAt: '2026-08-24T00:15:00.000Z',
      schemaVersion: 1,
    };
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'remote-1' };
    const link: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-1',
      importedRemoteRevision: 'rev-1',
      linkedAt: '2026-08-24T00:01:00.000Z',
    };
    const defaultFolder = {
      id: externalSourceDefaultFolderId(connectorId, 'account-1'),
      connectorId,
      accountConnectionId: 'account-1',
      parentRef: '/소설/완결',
      breadcrumbs: [
        { label: '소설', parentRef: '/소설' },
        { label: '완결', parentRef: '/소설/완결' },
      ],
      updatedAt: '2026-08-24T00:02:00.000Z',
      schemaVersion: 1 as const,
    };
    const selectedItem: ExternalSourceSelectionRecord = {
      id: `${connectorId}::account-1::picked-1`,
      connectorId,
      accountConnectionId: 'account-1',
      item: {
        key: { connectorId, accountConnectionId: 'account-1', remoteId: 'picked-1' },
        kind: 'file',
        title: '선택한 작품.epub',
        mimeType: 'application/epub+zip',
        importability: 'supported',
      },
      selectedAt: '2026-08-24T00:03:00.000Z',
      updatedAt: '2026-08-24T00:03:00.000Z',
      schemaVersion: 1,
    };
    const catalogPreference = {
      id: externalSourceCatalogPreferenceId(connectorId, 'account-1', 'source:9'),
      connectorId,
      accountConnectionId: 'account-1',
      parentRef: 'source:9',
      browseMode: 'latest' as const,
      filterValues: { '0': 1 },
      filters: [{ position: 0, value: 1 }],
      updatedAt: '2026-08-24T00:04:00.000Z',
      schemaVersion: 1 as const,
    };
    const subscription = {
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:1'),
      connectorId,
      accountConnectionId: 'account-1',
      collectionRemoteId: 'manga:1',
      navigationRef: 'manga:1',
      sourceNavigationRef: 'source:9',
      title: '라이브러리 작품',
      thumbnailUrl: 'http://localhost:4567/cover.jpg',
      knownReleaseIds: ['chapter:1'],
      newReleaseIds: [],
      availableReleaseCount: 1,
      lastCheckedAt: '2026-08-24T00:04:00.000Z',
      createdAt: '2026-08-24T00:04:00.000Z',
      updatedAt: '2026-08-24T00:04:00.000Z',
      schemaVersion: 1 as const,
    };

    await store.saveCredential(credential);
    await store.saveCachePage(cache);
    await store.saveLink(link);
    await store.saveDefaultFolder(defaultFolder);
    await store.saveCatalogPreference(catalogPreference);
    await store.saveSubscription(subscription);
    await store.saveSelectedItem(selectedItem);

    expect(await store.getCredential(connectorId)).toEqual(credential);
    expect(await store.getCachePage(cache.id)).toEqual(cache);
    expect(await store.listLinks(connectorId)).toEqual([link]);
    expect(await new ExternalSourceLocalStateStore().getDefaultFolder(connectorId, 'account-1')).toEqual(defaultFolder);
    expect(await store.getCatalogPreference(connectorId, 'account-1', 'source:9')).toEqual(catalogPreference);
    expect(await store.listSubscriptions(connectorId, 'account-1')).toEqual([subscription]);
    expect(await store.listSelectedItems(connectorId, 'account-1')).toEqual([selectedItem]);

    await store.deleteCredential(connectorId);
    await store.clearCache(connectorId, 'account-1');
    expect(await store.getCredential(connectorId)).toBeUndefined();
    expect(await store.getCachePage(cache.id)).toBeUndefined();
    expect(await store.listLinks(connectorId)).toEqual([link]);
    expect(await store.getDefaultFolder(connectorId, 'account-1')).toEqual(defaultFolder);

    await store.deleteDefaultFolder(connectorId, 'account-1');
    expect(await store.getDefaultFolder(connectorId, 'account-1')).toBeUndefined();
    await store.deleteSelectedItem(selectedItem.id);
    expect(await store.listSelectedItems(connectorId, 'account-1')).toEqual([]);
    await store.deleteSubscription(subscription.id);
    expect(await store.listSubscriptions(connectorId, 'account-1')).toEqual([]);
  });

  it('finalizes only the pending operation that still owns the link', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'remote-cas' };
    const staged: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-1',
      linkedAt: '2026-08-29T00:00:00.000Z',
      pendingImport: {
        operationId: 'operation-new',
        stagedAt: '2026-08-29T00:01:00.000Z',
        hadExistingLink: true,
        expectedActiveSourceContentHash: 'sha256:new',
      },
    };
    await store.saveLink(staged);

    expect(
      await store.compareAndSwapPendingLinks(
        [{ id: staged.id, operationId: 'operation-old' }],
        [{ ...staged, pendingImport: undefined, importedRemoteRevision: 'wrong' }],
        [],
      ),
    ).toBe(false);
    expect((await store.listLinks())[0]?.pendingImport?.operationId).toBe('operation-new');

    const finalized = { ...staged, pendingImport: undefined, importedRemoteRevision: 'revision-2' };
    expect(
      await store.compareAndSwapPendingLinks([{ id: staged.id, operationId: 'operation-new' }], [finalized], []),
    ).toBe(true);
    expect(await store.listLinks()).toEqual([finalized]);
  });

  it('allows only one pending operation to acquire the same existing link', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'remote-acquire' };
    const existing: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-1',
      importedRemoteRevision: 'revision-1',
      importedSourceContentHash: 'sha256:source-1',
      activeContentRevisionId: 'content-1',
      linkedAt: '2026-08-29T00:00:00.000Z',
    };
    const staged = (operationId: string): ExternalSourceLink => ({
      ...existing,
      pendingImport: {
        operationId,
        stagedAt: '2026-08-29T00:01:00.000Z',
        hadExistingLink: true,
        previousActiveContentRevisionId: 'content-1',
        expectedActiveSourceContentHash: 'sha256:source-2',
        importedRemoteRevision: 'revision-2',
        importedSourceContentHash: 'sha256:source-2',
      },
    });
    await store.saveLink(existing);

    expect(await store.acquirePendingLinks([staged('operation-a')])).toBe(true);
    expect(await store.acquirePendingLinks([staged('operation-b')])).toBe(false);

    expect((await store.listLinks())[0]?.pendingImport?.operationId).toBe('operation-a');
  });

  it('keeps bindings while a book is merely trashed and atomically removes them after permanent purge', async () => {
    const store = new ExternalSourceLocalStateStore();
    const subscription = {
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:1'),
      connectorId,
      accountConnectionId: 'account-1',
      collectionRemoteId: 'manga:1',
      navigationRef: 'manga:1',
      title: '연재 작품',
      knownReleaseIds: ['chapter:1'],
      newReleaseIds: [],
      availableReleaseCount: 1,
      lastCheckedAt: '2026-08-29T00:00:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      schemaVersion: 1 as const,
    };
    const link: ExternalSourceLink = {
      id: externalSourceLinkId({ connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:1' }),
      source: { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:1' },
      localBookId: 'book-1',
      collectionRemoteId: 'manga:1',
      linkedAt: '2026-08-29T00:00:00.000Z',
    };
    await store.saveLink(link);
    await store.saveSubscription(subscription);

    // Moving to trash does not call purgeBookAssociations, so both records remain restorable.
    expect(await store.listLinks()).toEqual([link]);
    expect(await store.listSubscriptions()).toEqual([subscription]);

    const snapshot = await store.captureBookAssociations();
    await store.purgeBookAssociations(['book-1'], snapshot);

    expect(await store.listLinks()).toEqual([]);
    expect(await store.listSubscriptions()).toEqual([]);
    await expect(store.purgeBookAssociations(['book-1'], snapshot)).resolves.toBeUndefined();
  });

  it('removes only subscriptions whose last materialized book binding was purged', async () => {
    const store = new ExternalSourceLocalStateStore();
    const sharedSubscription = {
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:shared'),
      connectorId,
      accountConnectionId: 'account-1',
      collectionRemoteId: 'manga:shared',
      navigationRef: 'manga:shared',
      title: '공유 연재 작품',
      knownReleaseIds: [],
      newReleaseIds: [],
      availableReleaseCount: 2,
      lastCheckedAt: '2026-08-29T00:00:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      schemaVersion: 1 as const,
    };
    const unrelatedSubscription = {
      ...sharedSubscription,
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:unrelated'),
      collectionRemoteId: 'manga:unrelated',
      navigationRef: 'manga:unrelated',
      title: '무관한 연재 작품',
    };
    const link = (remoteId: string, localBookId: string): ExternalSourceLink => ({
      id: externalSourceLinkId({ connectorId, accountConnectionId: 'account-1', remoteId }),
      source: { connectorId, accountConnectionId: 'account-1', remoteId },
      localBookId,
      collectionRemoteId: 'manga:shared',
      linkedAt: '2026-08-29T00:00:00.000Z',
    });
    const firstLink = link('chapter:1', 'book-1');
    const secondLink = link('chapter:2', 'book-2');
    await store.saveLinks([firstLink, secondLink]);
    await store.saveSubscription(sharedSubscription);
    await store.saveSubscription(unrelatedSubscription);

    await store.purgeBookAssociations(['book-1'], await store.captureBookAssociations());

    expect(await store.listLinks()).toEqual([secondLink]);
    expect(await store.listSubscriptions()).toEqual([sharedSubscription, unrelatedSubscription]);

    await store.purgeBookAssociations(
      ['book-2', 'book-does-not-exist'],
      await store.captureBookAssociations(),
    );

    expect(await store.listLinks()).toEqual([]);
    expect(await store.listSubscriptions()).toEqual([unrelatedSubscription]);
  });

  it('does not remove a binding that was recreated after the purge snapshot was captured', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:1' };
    const original: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-1',
      collectionRemoteId: 'manga:1',
      linkedAt: '2026-08-29T00:00:00.000Z',
    };
    await store.saveLink(original);
    const snapshot = await store.captureBookAssociations();

    const recreated: ExternalSourceLink = {
      ...original,
      linkedAt: '2026-08-29T00:01:00.000Z',
      activeContentRevisionId: 'new-incarnation-revision',
    };
    await store.saveLink(recreated);
    await store.purgeBookAssociations(['book-1'], snapshot);

    expect(await store.listLinks()).toEqual([recreated]);
  });

  it('does not remove a subscription refreshed after the purge snapshot was captured', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:1' };
    await store.saveLink({
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-1',
      collectionRemoteId: 'manga:1',
      linkedAt: '2026-08-29T00:00:00.000Z',
    });
    const subscription = {
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:1'),
      connectorId,
      accountConnectionId: 'account-1',
      collectionRemoteId: 'manga:1',
      navigationRef: 'manga:1',
      title: 'series',
      knownReleaseIds: ['chapter:1'],
      newReleaseIds: [],
      availableReleaseCount: 1,
      lastCheckedAt: '2026-08-29T00:00:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      schemaVersion: 1 as const,
    };
    await store.saveSubscription(subscription);
    const snapshot = await store.captureBookAssociations();

    const refreshed = {
      ...subscription,
      lastCheckedAt: '2026-08-29T00:01:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
    };
    await store.saveSubscription(refreshed);
    await store.purgeBookAssociations(['book-1'], snapshot);

    expect(await store.listLinks()).toEqual([]);
    expect(await store.listSubscriptions()).toEqual([refreshed]);
  });

  it('retries a durable purge intent after restart only when the exact book generation is gone', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:durable' };
    const link: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-durable',
      collectionRemoteId: 'manga:durable',
      activeContentRevisionId: 'content-old',
      linkedAt: '2026-08-30T00:00:00.000Z',
    };
    const subscription = {
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:durable'),
      connectorId,
      accountConnectionId: 'account-1',
      collectionRemoteId: 'manga:durable',
      navigationRef: 'manga:durable',
      title: 'durable series',
      knownReleaseIds: ['chapter:durable'],
      newReleaseIds: [],
      availableReleaseCount: 1,
      lastCheckedAt: '2026-08-30T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      schemaVersion: 1 as const,
    };
    await store.saveLink(link);
    await store.saveSubscription(subscription);
    await store.prepareBookAssociationPurge([
      { bookId: link.localBookId, activeContentRevisionId: link.activeContentRevisionId },
    ]);

    const restarted = new ExternalSourceLocalStateStore();
    await expect(
      restarted.reconcileBookAssociationPurges([
        { bookId: link.localBookId, activeContentRevisionId: link.activeContentRevisionId },
      ]),
    ).resolves.toBe(0);
    expect(await restarted.listLinks()).toEqual([link]);

    await expect(restarted.reconcileBookAssociationPurges([])).resolves.toBe(2);
    expect(await restarted.listLinks()).toEqual([]);
    expect(await restarted.listSubscriptions()).toEqual([]);
  });

  it('captures a pre-existing stale link by book id and removes it only after the current generation is purged', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:stale' };
    const staleLink: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-stale',
      activeContentRevisionId: 'content-older-than-book',
      linkedAt: '2026-08-30T00:00:00.000Z',
    };
    await store.saveLink(staleLink);
    await store.prepareBookAssociationPurge([
      { bookId: staleLink.localBookId, activeContentRevisionId: 'content-current-book' },
    ]);

    await expect(
      store.reconcileBookAssociationPurges([
        { bookId: staleLink.localBookId, activeContentRevisionId: 'content-current-book' },
      ]),
    ).resolves.toBe(0);
    expect(await store.listLinks()).toEqual([staleLink]);

    await expect(store.reconcileBookAssociationPurges([])).resolves.toBe(1);
    expect(await store.listLinks()).toEqual([]);
  });

  it('never lets an old purge intent remove a recreated generation or an in-flight import', async () => {
    const store = new ExternalSourceLocalStateStore();
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:recreated' };
    const pending: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-recreated',
      collectionRemoteId: 'manga:recreated',
      activeContentRevisionId: 'content-old',
      linkedAt: '2026-08-30T00:00:00.000Z',
      pendingImport: {
        operationId: 'new-import',
        stagedAt: '2026-08-30T00:01:00.000Z',
        hadExistingLink: true,
        previousActiveContentRevisionId: 'content-old',
        expectedActiveSourceContentHash: 'sha256:new',
      },
    };
    await store.saveLink(pending);
    await store.prepareBookAssociationPurge([
      { bookId: pending.localBookId, activeContentRevisionId: pending.activeContentRevisionId },
    ]);

    await expect(store.reconcileBookAssociationPurges([])).resolves.toBe(0);
    expect(await store.listLinks()).toEqual([pending]);

    const recreated: ExternalSourceLink = {
      ...pending,
      activeContentRevisionId: 'content-new',
      pendingImport: undefined,
      importedSourceContentHash: 'sha256:new',
      linkedAt: '2026-08-30T00:02:00.000Z',
    };
    await store.saveLink(recreated);
    await expect(
      store.reconcileBookAssociationPurges([
        { bookId: recreated.localBookId, activeContentRevisionId: recreated.activeContentRevisionId },
      ]),
    ).resolves.toBe(0);
    expect(await store.listLinks()).toEqual([recreated]);
  });

  it('uses pulled purge evidence only for finalized links of the deleted incarnation', async () => {
    const store = new ExternalSourceLocalStateStore();
    const oldSource = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:old' };
    const newSource = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:new' };
    const staleSource = { connectorId, accountConnectionId: 'account-1', remoteId: 'chapter:stale-before-purge' };
    const oldLink: ExternalSourceLink = {
      id: externalSourceLinkId(oldSource),
      source: oldSource,
      localBookId: 'book-evidence',
      collectionRemoteId: 'manga:evidence',
      activeContentRevisionId: 'content-old',
      linkedAt: '2026-08-30T00:00:00.000Z',
    };
    const newLink: ExternalSourceLink = {
      id: externalSourceLinkId(newSource),
      source: newSource,
      localBookId: 'book-evidence',
      collectionRemoteId: 'manga:evidence',
      activeContentRevisionId: 'content-new',
      linkedAt: '2026-08-30T00:01:00.000Z',
    };
    const staleLink: ExternalSourceLink = {
      id: externalSourceLinkId(staleSource),
      source: staleSource,
      localBookId: 'book-evidence',
      collectionRemoteId: 'manga:evidence',
      activeContentRevisionId: 'content-even-older',
      linkedAt: '2026-08-29T23:59:00.000Z',
    };
    const subscription = {
      id: externalSourceSubscriptionId(connectorId, 'account-1', 'manga:evidence'),
      connectorId,
      accountConnectionId: 'account-1',
      collectionRemoteId: 'manga:evidence',
      navigationRef: 'manga:evidence',
      title: 'evidence series',
      knownReleaseIds: ['chapter:old', 'chapter:new'],
      newReleaseIds: [],
      availableReleaseCount: 2,
      lastCheckedAt: '2026-08-30T00:01:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
      schemaVersion: 1 as const,
    };
    await store.saveLinks([oldLink, newLink, staleLink]);
    await store.saveSubscription(subscription);

    await expect(
      store.reconcileBookAssociationPurges(
        [{ bookId: 'book-evidence', activeContentRevisionId: 'content-new' }],
        [{ bookId: 'book-evidence', activeContentRevisionId: 'content-old' }],
      ),
    ).resolves.toBe(2);
    expect(await store.listLinks()).toEqual([newLink]);
    expect(await store.listSubscriptions()).toEqual([subscription]);
  });
});
