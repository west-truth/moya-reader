import type { ReadingSessionEvent, UserFontAsset } from '../domain/types';
import { BOOK_ASSET_STORES, type StoredBookAssetBlob } from '../storage/book-asset-schema';
import { READER_PERSONALIZATION_STORES } from '../storage/reader-personalization-schema';
import { openReaderDb } from '../storage/reader-database';
import { requestToPromise, transactionDone } from '../storage/indexeddb-transaction';
import type { InstallUserFontInput, ReaderPersonalizationRepository } from './reader-personalization-repository';

export class IndexedDbReaderPersonalizationRepository implements ReaderPersonalizationRepository {
  async listUserFonts(): Promise<UserFontAsset[]> {
    const db = await openReaderDb();
    const tx = db.transaction(READER_PERSONALIZATION_STORES.fonts, 'readonly');
    const rows = await requestToPromise<UserFontAsset[]>(tx.objectStore(READER_PERSONALIZATION_STORES.fonts).getAll());
    return rows.sort((left, right) => left.familyLabel.localeCompare(right.familyLabel));
  }

  async getUserFontContent(id: string): Promise<Blob | undefined> {
    const db = await openReaderDb();
    const tx = db.transaction([READER_PERSONALIZATION_STORES.fonts, BOOK_ASSET_STORES.blobs], 'readonly');
    const asset = await requestToPromise<UserFontAsset | undefined>(
      tx.objectStore(READER_PERSONALIZATION_STORES.fonts).get(id),
    );
    if (!asset) return undefined;
    const stored = await requestToPromise<StoredBookAssetBlob | undefined>(
      tx.objectStore(BOOK_ASSET_STORES.blobs).get(asset.storageKey),
    );
    return stored?.blob;
  }

  async installUserFont(input: InstallUserFontInput): Promise<UserFontAsset> {
    const db = await openReaderDb();
    const tx = db.transaction([READER_PERSONALIZATION_STORES.fonts, BOOK_ASSET_STORES.blobs], 'readwrite');
    tx.objectStore(BOOK_ASSET_STORES.blobs).put({
      id: input.asset.storageKey,
      contentHash: input.asset.contentHash,
      contentType: input.asset.contentType,
      byteLength: input.asset.byteLength,
      blob: input.blob,
      createdAt: input.asset.createdAt,
    } satisfies StoredBookAssetBlob);
    tx.objectStore(READER_PERSONALIZATION_STORES.fonts).put(input.asset);
    await transactionDone(tx);
    return input.asset;
  }

  async updateUserFont(id: string, patch: Pick<UserFontAsset, 'familyLabel' | 'licenseNote'>): Promise<UserFontAsset> {
    const db = await openReaderDb();
    const tx = db.transaction(READER_PERSONALIZATION_STORES.fonts, 'readwrite');
    const store = tx.objectStore(READER_PERSONALIZATION_STORES.fonts);
    const existing = await requestToPromise<UserFontAsset | undefined>(store.get(id));
    if (!existing) throw new Error('font_not_found');
    const updated = {
      ...existing,
      ...patch,
      familyLabel: patch.familyLabel.trim(),
      updatedAt: new Date().toISOString(),
    };
    store.put(updated);
    await transactionDone(tx);
    return updated;
  }

  async deleteUserFont(id: string): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction([READER_PERSONALIZATION_STORES.fonts, BOOK_ASSET_STORES.blobs], 'readwrite');
    const store = tx.objectStore(READER_PERSONALIZATION_STORES.fonts);
    const existing = await requestToPromise<UserFontAsset | undefined>(store.get(id));
    store.delete(id);
    if (existing) tx.objectStore(BOOK_ASSET_STORES.blobs).delete(existing.storageKey);
    await transactionDone(tx);
  }

  async appendReadingSession(event: ReadingSessionEvent): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(READER_PERSONALIZATION_STORES.sessions, 'readwrite');
    tx.objectStore(READER_PERSONALIZATION_STORES.sessions).put(event);
    await transactionDone(tx);
  }

  async listReadingSessions(
    options: { bookId?: string; from?: string; to?: string } = {},
  ): Promise<ReadingSessionEvent[]> {
    const db = await openReaderDb();
    const tx = db.transaction(READER_PERSONALIZATION_STORES.sessions, 'readonly');
    const rows = await requestToPromise<ReadingSessionEvent[]>(
      tx.objectStore(READER_PERSONALIZATION_STORES.sessions).getAll(),
    );
    return rows
      .filter(
        (row) =>
          (!options.bookId || row.bookId === options.bookId) &&
          (!options.from || row.endedAt >= options.from) &&
          (!options.to || row.startedAt <= options.to),
      )
      .sort((left, right) => right.endedAt.localeCompare(left.endedAt));
  }

  async deleteReadingSessions(options: { bookId?: string; before?: string } = {}): Promise<number> {
    const db = await openReaderDb();
    const tx = db.transaction(READER_PERSONALIZATION_STORES.sessions, 'readwrite');
    const store = tx.objectStore(READER_PERSONALIZATION_STORES.sessions);
    const rows = await requestToPromise<ReadingSessionEvent[]>(store.getAll());
    const targets = rows.filter(
      (row) => (!options.bookId || row.bookId === options.bookId) && (!options.before || row.endedAt < options.before),
    );
    targets.forEach((row) => store.delete(row.id));
    await transactionDone(tx);
    return targets.length;
  }
}
