import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openReaderDb, READER_DB_NAME, resetReaderDbForTests } from './reader-database';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { ExternalSourceLocalStateStore, resetExternalSourceLocalStateForTests } from '../external-sources/local-state';

describe('rollback browser database compatibility', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
    await resetExternalSourceLocalStateForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reopens a v39 database left by the reverted release without resetting its data', async () => {
    const baseline = await openReaderDb();
    const chapter = {
      id: 'existing-page',
      novelId: 'existing-book',
      documentSectionId: 'chapter:6',
      documentSectionReadAt: '2026-08-30T00:00:00.000Z',
    };
    const seed = baseline.transaction(['chapters', 'settings', 'book_assets'], 'readwrite');
    seed.objectStore('chapters').put(chapter);
    seed.objectStore('settings').put({ id: 'global', fontSize: 25 });
    seed
      .objectStore('book_assets')
      .put({ id: 'old-source', bookId: 'existing-book', blob: new Blob(['existing bytes']) });
    await transactionDone(seed);
    baseline.close();

    // Explicitly simulate the version left behind by #21, independently of the current constant.
    const shipped = await requestToPromise(indexedDB.open(READER_DB_NAME, 39));
    shipped.close();
    vi.resetModules();
    const reopenedModule = await import('./reader-database');
    const reopened = await reopenedModule.openReaderDb();
    expect(reopened.version).toBe(39);
    const tx = reopened.transaction(['chapters', 'settings', 'book_assets'], 'readonly');
    expect(await requestToPromise(tx.objectStore('chapters').get(chapter.id))).toEqual(chapter);
    expect(await requestToPromise(tx.objectStore('settings').get('global'))).toEqual({ id: 'global', fontSize: 25 });
    const asset = await requestToPromise(tx.objectStore('book_assets').get('old-source'));
    expect(await asset.blob.text()).toBe('existing bytes');
    await reopenedModule.resetReaderDbForTests();
  });

  it.each([5, 6])('keeps source credentials and links in an existing v%s database', async (version) => {
    const request = indexedDB.open('noveldesk-external-sources', version);
    request.onupgradeneeded = () => {
      const credentials = request.result.createObjectStore('credentials', { keyPath: 'id' });
      credentials.createIndex('connectorId', 'connectorId');
      const links = request.result.createObjectStore('links', { keyPath: 'id' });
      links.createIndex('connectorId', 'source.connectorId');
      links.createIndex('localBookId', 'localBookId');
      if (version === 6) request.result.createObjectStore('associationPurgeIntents', { keyPath: 'id' });
    };
    const oldDb = await requestToPromise(request);
    const credential = {
      id: 'source-login',
      connectorId: 'moya.external.suwayomi',
      credentialEnvelope: 'encrypted-test-value',
      createdAt: '2026-08-30',
      updatedAt: '2026-08-30',
    };
    const link = {
      id: 'source-link',
      source: { connectorId: credential.connectorId, remoteId: 'chapter:6' },
      localBookId: 'existing-book',
      linkedAt: '2026-08-30',
    };
    const tx = oldDb.transaction(['credentials', 'links'], 'readwrite');
    tx.objectStore('credentials').put(credential);
    tx.objectStore('links').put(link);
    await transactionDone(tx);
    oldDb.close();
    const store = new ExternalSourceLocalStateStore();
    expect(await store.getCredential(credential.connectorId)).toEqual(credential);
    expect(await store.listLinks()).toEqual([link]);
    await resetExternalSourceLocalStateForTests();
  });
});
