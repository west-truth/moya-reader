import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Novel } from '../domain/types';
import type { ExternalSourceLink } from './contracts';
import {
  ExternalSourceLocalStateStore,
  externalSourceSubscriptionId,
  resetExternalSourceLocalStateForTests,
} from './local-state';
import {
  EXTERNAL_SOURCE_PENDING_INTENT_LEASE_MS,
  reconcilePendingExternalSourceLinks,
} from './link-import-reconciliation';
import { testNovel } from '../features/book-workspace/book-workspace-test-fixtures';
import { openReaderDb, resetReaderDbForTests } from '../storage/reader-database';
import { transactionDone } from '../storage/indexeddb-transaction';
import { getNovels } from '../storage/reader-query-store';
import { moveNovelToTrash, restoreNovelFromTrash, purgeNovel } from '../storage/library-catalog-store';

const link: ExternalSourceLink = {
  id: 'chapter-link',
  source: { connectorId: 'source', accountConnectionId: 'account', remoteId: 'chapter-1' },
  collectionRemoteId: 'series-1',
  localBookId: 'book-1',
  importedSourceContentHash: 'chapter-bytes',
  activeContentRevisionId: 'revision-1',
  linkedAt: '2026-08-31T00:00:00.000Z',
};

async function seed(state: ExternalSourceLocalStateStore) {
  await state.saveLink(link);
  const subscription = {
    id: externalSourceSubscriptionId('source', 'account', 'series-1'),
    connectorId: 'source',
    accountConnectionId: 'account',
    collectionRemoteId: 'series-1',
    navigationRef: 'series-1',
    title: '테스트 작품',
    knownReleaseIds: ['chapter-1'],
    newReleaseIds: [],
    availableReleaseCount: 1,
    lastCheckedAt: link.linkedAt,
    createdAt: link.linkedAt,
    updatedAt: link.linkedAt,
    schemaVersion: 1 as const,
  };
  await state.saveSubscription(subscription);
  return subscription;
}

describe('missing book source associations', () => {
  beforeEach(async () => {
    await resetExternalSourceLocalStateForTests();
    await resetReaderDbForTests();
  });

  it('preserves trash/restore, removes a purged association and allows identical bytes to be linked again', async () => {
    const state = new ExternalSourceLocalStateStore();
    const subscription = await seed(state);
    const book = testNovel({ id: link.localBookId });
    const db = await openReaderDb();
    const put = async () => {
      const tx = db.transaction('novels', 'readwrite');
      tx.objectStore('novels').put(book);
      await transactionDone(tx);
    };
    await put();
    const reconcile = async () =>
      reconcilePendingExternalSourceLinks(
        state,
        await state.listLinks(),
        await getNovels({ includeTrash: true }),
        Date.now(),
        { catalogIncludesTrash: true },
      );
    await moveNovelToTrash(book.id);
    expect(await getNovels()).toEqual([]);
    expect(await reconcile()).toEqual([link]);
    expect(await state.listSubscriptions()).toEqual([subscription]);
    await restoreNovelFromTrash(book.id);
    expect(await reconcile()).toEqual([link]);
    await moveNovelToTrash(book.id);
    await purgeNovel(book.id);
    expect(await reconcile()).toEqual([]);
    expect(await new ExternalSourceLocalStateStore().listSubscriptions()).toEqual([]);
    await put();
    await seed(state);
    expect(await reconcile()).toEqual([link]);
  });

  it('does not use an active-only catalog to delete links or subscription-only works', async () => {
    const state = new ExternalSourceLocalStateStore();
    const subscription = await seed(state);
    const remoteOnly = { ...subscription, id: 'subscription-only', collectionRemoteId: 'other-series' };
    await state.saveSubscription(remoteOnly);
    await reconcilePendingExternalSourceLinks(state, [link], []);
    expect(await state.listLinks()).toEqual([link]);
    await reconcilePendingExternalSourceLinks(state, [link], [], Date.now(), { catalogIncludesTrash: true });
    expect(await state.listSubscriptions()).toEqual([remoteOnly]);
  });

  it('cannot erase a link changed by a new import or a subscription still backed by another book', async () => {
    const state = new ExternalSourceLocalStateStore();
    const subscription = await seed(state);
    const newer = { ...link, activeContentRevisionId: 'revision-new' };
    await state.saveLink(newer);
    await state.removeMissingBookLinks([link]);
    expect(await state.listLinks()).toEqual([newer]);
    const other = {
      ...link,
      id: 'second-link',
      localBookId: 'book-2',
      source: { ...link.source, remoteId: 'chapter-2' },
    };
    await state.saveLink(other);
    await state.removeMissingBookLinks([newer]);
    expect(await state.listLinks()).toEqual([other]);
    expect(await state.listSubscriptions()).toEqual([subscription]);
  });

  it('preserves a live import lease, then removes an expired missing-book association on refresh', async () => {
    const state = new ExternalSourceLocalStateStore();
    await seed(state);
    const pending = {
      ...link,
      pendingImport: {
        operationId: 'pending-1',
        stagedAt: new Date().toISOString(),
        hadExistingLink: true,
        expectedActiveSourceContentHash: 'new-bytes',
      },
    };
    await state.saveLink(pending);
    expect(
      await reconcilePendingExternalSourceLinks(state, [pending], [], Date.now(), { catalogIncludesTrash: true }),
    ).toEqual([pending]);
    expect(
      await reconcilePendingExternalSourceLinks(
        state,
        [pending],
        [],
        Date.now() + EXTERNAL_SOURCE_PENDING_INTENT_LEASE_MS + 1,
        { catalogIncludesTrash: true },
      ),
    ).toEqual([]);
  });

  it('retains links if the target exists, including in trash, regardless of body loading availability', async () => {
    const state = new ExternalSourceLocalStateStore();
    await seed(state);
    const trash = { id: link.localBookId, deletedAt: '2026-08-31' } as Novel;
    expect(
      await reconcilePendingExternalSourceLinks(state, [link], [trash], Date.now(), { catalogIncludesTrash: true }),
    ).toEqual([link]);
  });
});
