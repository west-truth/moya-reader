import type { TTSOfflineCacheManifestEntry } from '../domain/types';
import type { TTSDownloadCacheEvidence } from '../repositories/tts-download-repository';
import { sha256 } from '../domain/hash';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

const MAX_AUDIO_ITEM_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_HIGH_WATER_BYTES = 512 * 1024 * 1024;
const DEFAULT_CACHE_LOW_WATER_BYTES = Math.floor(DEFAULT_CACHE_HIGH_WATER_BYTES * 0.9);

export interface HostedTTSOfflineBlobRecord {
  readonly id: string;
  readonly bookId: string;
  readonly cacheKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly audioHash: string;
  readonly blob: Blob;
}

export interface HostedTTSOfflineAudio {
  readonly cacheKey: string;
  readonly blob: Blob;
  readonly byteSize: number;
}

export interface HostedTTSOfflineCacheStatus {
  readonly itemCount: number;
  readonly byteSize: number;
  readonly staleItemCount: number;
  readonly staleByteSize: number;
  readonly protectedStaleItemCount: number;
  readonly originUsage?: number;
  readonly originQuota?: number;
  readonly persisted?: boolean;
  readonly persistenceSupported: boolean;
}

export interface HostedTTSOfflineCacheCleanupResult {
  readonly removedItems: number;
  readonly removedBytes: number;
  readonly protectedItems: number;
}

export interface StoreHostedTTSOfflineAudioInput {
  readonly bookId: string;
  readonly chapterId: string;
  readonly cacheKey: string;
  readonly renderSpecHash: string;
  readonly contentRevisionId: string;
  readonly blob: Blob;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function audioHash(blob: Blob): Promise<string> {
  return `sha256:${await sha256((await blob.arrayBuffer()) as ArrayBuffer)}`;
}

function validAudioBlob(blob: Blob): boolean {
  return (
    blob.size > 0 &&
    blob.size <= MAX_AUDIO_ITEM_BYTES &&
    (!blob.type || blob.type.startsWith('audio/') || blob.type === 'application/octet-stream')
  );
}

async function deleteEntry(cacheKey: string): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs],
    'readwrite',
  );
  tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).delete(cacheKey);
  tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs).delete(cacheKey);
  await transactionDone(tx);
}

export class IndexedDbHostedTTSOfflineCache {
  async status(bookId?: string, activeContentRevisionId?: string): Promise<HostedTTSOfflineCacheStatus> {
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readonly');
    const entries = (
      await requestToPromise<TTSOfflineCacheManifestEntry[]>(
        tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).getAll(),
      )
    ).filter((entry) => entry.storage === 'indexeddb' && (!bookId || entry.bookId === bookId));
    const storage = globalThis.navigator?.storage;
    const persistenceSupported = typeof storage?.persist === 'function';
    const [estimate, persisted] = await Promise.all([
      storage?.estimate?.().catch(() => undefined),
      storage?.persisted?.().catch(() => undefined),
    ]);
    const staleEntries = activeContentRevisionId
      ? entries.filter((entry) => entry.contentRevisionId !== activeContentRevisionId)
      : [];
    const removableStaleEntries = staleEntries.filter((entry) => entry.pinnedByJobIds.length === 0);
    return {
      itemCount: entries.length,
      byteSize: entries.reduce((sum, entry) => sum + Math.max(0, entry.byteSize), 0),
      staleItemCount: removableStaleEntries.length,
      staleByteSize: removableStaleEntries.reduce((sum, entry) => sum + Math.max(0, entry.byteSize), 0),
      protectedStaleItemCount: staleEntries.length - removableStaleEntries.length,
      originUsage: estimate?.usage,
      originQuota: estimate?.quota,
      persisted,
      persistenceSupported,
    };
  }

  async removeStaleForBook(
    bookId: string,
    activeContentRevisionId: string,
  ): Promise<HostedTTSOfflineCacheCleanupResult> {
    const db = await openReaderDb();
    const transaction = db.transaction(
      [DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs],
      'readwrite',
    );
    const done = transactionDone(transaction);
    const manifests = transaction.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest);
    const blobs = transaction.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs);
    const entries = await requestToPromise<TTSOfflineCacheManifestEntry[]>(manifests.index('bookId').getAll(bookId));
    const staleEntries = entries.filter(
      (entry) => entry.storage === 'indexeddb' && entry.contentRevisionId !== activeContentRevisionId,
    );
    const removable = staleEntries.filter((entry) => entry.pinnedByJobIds.length === 0);
    for (const entry of removable) {
      manifests.delete(entry.cacheKey);
      blobs.delete(entry.cacheKey);
    }
    await done;
    return {
      removedItems: removable.length,
      removedBytes: removable.reduce((sum, entry) => sum + Math.max(0, entry.byteSize), 0),
      protectedItems: staleEntries.length - removable.length,
    };
  }

  async requestPersistence(): Promise<boolean | undefined> {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.persist !== 'function') return undefined;
    return storage.persist();
  }

  async evidence(bookId: string, renderSpecHashes: readonly string[]): Promise<TTSDownloadCacheEvidence[]> {
    const evidence: TTSDownloadCacheEvidence[] = [];
    for (const renderSpecHash of [...new Set(renderSpecHashes)]) {
      const stored = await this.getByRenderSpecHash(bookId, renderSpecHash);
      if (stored) {
        evidence.push({
          renderSpecHash,
          cacheKey: stored.cacheKey,
          byteSize: stored.byteSize,
          storage: 'indexeddb',
        });
      }
    }
    return evidence;
  }

  async getByRenderSpecHash(bookId: string, renderSpecHash: string): Promise<HostedTTSOfflineAudio | undefined> {
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readonly');
    const manifest = await requestToPromise<TTSOfflineCacheManifestEntry | undefined>(
      tx
        .objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest)
        .index('bookId_renderSpecHash_storage')
        .get([bookId, renderSpecHash, 'indexeddb']),
    );
    return manifest ? this.getByCacheKey(bookId, manifest.cacheKey) : undefined;
  }

  async getByCacheKey(bookId: string, cacheKey: string): Promise<HostedTTSOfflineAudio | undefined> {
    const db = await openReaderDb();
    const tx = db.transaction(
      [DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs],
      'readonly',
    );
    const [manifest, record] = await Promise.all([
      requestToPromise<TTSOfflineCacheManifestEntry | undefined>(
        tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).get(cacheKey),
      ),
      requestToPromise<HostedTTSOfflineBlobRecord | undefined>(
        tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs).get(cacheKey),
      ),
    ]);
    if (!manifest) {
      if (record?.bookId === bookId) await deleteEntry(cacheKey);
      return undefined;
    }
    if (manifest.storage !== 'indexeddb' || manifest.bookId !== bookId) return undefined;
    if (!record) {
      await deleteEntry(cacheKey);
      return undefined;
    }
    const valid =
      record.bookId === bookId &&
      record.cacheKey === cacheKey &&
      record.byteSize === record.blob.size &&
      record.byteSize === manifest.byteSize &&
      validAudioBlob(record.blob) &&
      (await audioHash(record.blob)) === record.audioHash;
    if (!valid) {
      await deleteEntry(cacheKey);
      return undefined;
    }
    const touch = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readwrite');
    touch.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).put({
      ...manifest,
      lastAccessedAt: nowIso(),
    });
    await transactionDone(touch);
    return { cacheKey, blob: record.blob, byteSize: record.byteSize };
  }

  async put(input: StoreHostedTTSOfflineAudioInput): Promise<void> {
    if (!validAudioBlob(input.blob)) throw new Error('Hosted TTS offline audio is invalid or too large.');
    const timestamp = nowIso();
    const record: HostedTTSOfflineBlobRecord = {
      id: input.cacheKey,
      bookId: input.bookId,
      cacheKey: input.cacheKey,
      contentType: input.blob.type || 'application/octet-stream',
      byteSize: input.blob.size,
      audioHash: await audioHash(input.blob),
      blob: input.blob,
    };
    const manifest: TTSOfflineCacheManifestEntry = {
      id: input.cacheKey,
      bookId: input.bookId,
      chapterId: input.chapterId,
      cacheKey: input.cacheKey,
      renderSpecHash: input.renderSpecHash,
      contentRevisionId: input.contentRevisionId,
      byteSize: input.blob.size,
      storage: 'indexeddb',
      pinnedByJobIds: [],
      createdAt: timestamp,
      lastAccessedAt: timestamp,
    };
    const db = await openReaderDb();
    const tx = db.transaction(
      [DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs],
      'readwrite',
    );
    tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs).put(record);
    tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).put(manifest);
    await transactionDone(tx);
    await this.prune();
  }

  async prune(
    highWaterBytes = DEFAULT_CACHE_HIGH_WATER_BYTES,
    lowWaterBytes = DEFAULT_CACHE_LOW_WATER_BYTES,
  ): Promise<number> {
    const db = await openReaderDb();
    const read = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readonly');
    const entries = (
      await requestToPromise<TTSOfflineCacheManifestEntry[]>(
        read.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).getAll(),
      )
    ).filter((entry) => entry.storage === 'indexeddb');
    let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.byteSize), 0);
    if (total <= highWaterBytes) return 0;
    let removed = 0;
    for (const entry of entries
      .filter((candidate) => candidate.pinnedByJobIds.length === 0)
      .sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt))) {
      if (total <= Math.min(highWaterBytes, lowWaterBytes)) break;
      await deleteEntry(entry.cacheKey);
      total -= Math.max(0, entry.byteSize);
      removed += 1;
    }
    return removed;
  }
}
