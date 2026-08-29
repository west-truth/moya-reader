import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOK_ENRICHMENT_STORES, upgradeBookEnrichmentStores } from './book-enrichment-schema';

const DATABASE_NAME = 'book-enrichment-schema-test';

function openDatabase(version: number, upgrade: (request: IDBOpenDBRequest) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, version);
    request.onupgradeneeded = () => upgrade(request);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

describe('book enrichment schema', () => {
  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DATABASE_NAME);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      }),
  );

  it('migrates the legacy unique candidate receipt index for linked undo receipts', async () => {
    const legacy = await openDatabase(1, (request) => {
      const candidates = request.result.createObjectStore(BOOK_ENRICHMENT_STORES.candidates, { keyPath: 'id' });
      candidates.createIndex('bookId', 'bookId');
      candidates.createIndex('bookId_status', ['bookId', 'status']);
      candidates.createIndex('contributionId', 'provenance.contributionId');
      candidates.createIndex('createdAt', 'createdAt');
      const receipts = request.result.createObjectStore(BOOK_ENRICHMENT_STORES.receipts, { keyPath: 'id' });
      receipts.createIndex('bookId', 'bookId');
      receipts.createIndex('candidateId', 'candidateId', { unique: true });
      receipts.createIndex('appliedAt', 'appliedAt');
    });
    legacy.close();

    const migrated = await openDatabase(2, (request) => {
      if (!request.transaction) throw new Error('upgrade transaction missing');
      upgradeBookEnrichmentStores(request.result, request.transaction);
    });
    const tx = migrated.transaction(BOOK_ENRICHMENT_STORES.receipts, 'readonly');

    expect(tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).index('candidateId').unique).toBe(false);
    migrated.close();
  });
});
