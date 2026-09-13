import type { MoyaPackageManifestV1 } from '@noveldesk/extension-contracts/package';
import type { RepositoryRecord } from './repository-contract';
import {
  mergeSourceState,
  sourceStateScope,
  sourceStateView,
  type SourceStateChanges,
  type SourceStateValues,
} from './source-state';

export interface InstalledPackageVersion {
  readonly digest: string;
  readonly manifest: MoyaPackageManifestV1;
  readonly publisherFingerprint?: string;
  readonly archive: Blob;
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface InstalledPackageRecord {
  readonly credentialEpoch?: string;
  readonly id: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly publisherPin: string;
  readonly active?: InstalledPackageVersion;
  readonly previous?: InstalledPackageVersion;
  readonly updatedAt: string;
}

export interface PackageInstallStore {
  listRepositories?(): Promise<readonly RepositoryRecord[]>;
  saveRepository?(record: RepositoryRecord, expectedRevision: number): Promise<boolean>;
  readSourceState?(id: string, sourceId: string, revision: number): Promise<SourceStateValues>;
  commitSourceState?(
    id: string,
    sourceId: string,
    revision: number,
    base: SourceStateValues,
    changes: SourceStateChanges,
    signal?: AbortSignal,
  ): Promise<void>;
  list(): Promise<readonly InstalledPackageSummary[]>;
  read(id: string): Promise<InstalledPackageRecord | undefined>;
  /** Whole activation is atomic. Implementations retain tombstone revisions after removal. */
  compareAndSwap(id: string, expectedRevision: number, record: InstalledPackageRecord): Promise<boolean>;
}

/** Inventory reads never require downloading code archives. */
export type InstalledPackageSummary = Omit<InstalledPackageRecord, 'active' | 'previous'> & {
  readonly active?: Omit<InstalledPackageVersion, 'archive' | 'settings'>;
  readonly previous?: Omit<InstalledPackageVersion, 'archive' | 'settings'>;
};

export function packageSummary(record: InstalledPackageRecord): InstalledPackageSummary {
  const version = (entry: InstalledPackageVersion | undefined) =>
    entry
      ? {
          digest: entry.digest,
          manifest: entry.manifest,
          publisherFingerprint: entry.publisherFingerprint,
        }
      : undefined;
  return {
    credentialEpoch: record.credentialEpoch,
    id: record.id,
    revision: record.revision,
    enabled: record.enabled,
    publisherPin: record.publisherPin,
    updatedAt: record.updatedAt,
    active: version(record.active),
    previous: version(record.previous),
  };
}

/** A separate host-owned DB; package code never receives this object or the browser IndexedDB API. */
export class IndexedDbPackageInstallStore implements PackageInstallStore {
  private database?: Promise<IDBDatabase>;
  constructor(
    private readonly name = 'moya.extension-packages.v1',
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.database)
      this.database = new Promise((resolve, reject) => {
        const request = this.factory.open(this.name, 3);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('packages'))
            request.result.createObjectStore('packages', { keyPath: 'id' });
          if (!request.result.objectStoreNames.contains('source-state'))
            request.result.createObjectStore('source-state');
          if (!request.result.objectStoreNames.contains('repositories'))
            request.result.createObjectStore('repositories', { keyPath: 'url' });
        };
        request.onerror = () => {
          this.database = undefined;
          reject(new Error('package_storage_unavailable'));
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            database.close();
            this.database = undefined;
          };
          resolve(database);
        };
      });
    return this.database;
  }

  async list(): Promise<readonly InstalledPackageSummary[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('packages').objectStore('packages').getAll();
      request.onsuccess = () => resolve((request.result as InstalledPackageRecord[]).map(packageSummary));
      request.onerror = () => reject(new Error('package_storage_unavailable'));
    });
  }
  async listRepositories(): Promise<readonly RepositoryRecord[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('repositories').objectStore('repositories').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('package_storage_unavailable'));
    });
  }
  async saveRepository(record: RepositoryRecord, expectedRevision: number): Promise<boolean> {
    if (record.revision !== expectedRevision + 1) throw new Error('package_repository_conflict');
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('repositories', 'readwrite');
      const store = transaction.objectStore('repositories');
      const request = store.getAll();
      let written = false;
      request.onsuccess = () => {
        const all = request.result as RepositoryRecord[];
        const previous = all.find((item) => item.url === record.url);
        if (
          (previous?.revision ?? 0) !== expectedRevision ||
          (record.index && !previous?.index && all.filter((item) => item.index).length >= 16)
        )
          return;
        store.put(record);
        written = true;
      };
      transaction.oncomplete = () => resolve(written);
      transaction.onerror = transaction.onabort = () => reject(new Error('package_storage_unavailable'));
    });
  }

  async read(id: string): Promise<InstalledPackageRecord | undefined> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('packages').objectStore('packages').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('package_storage_unavailable'));
    });
  }

  async compareAndSwap(id: string, expectedRevision: number, record: InstalledPackageRecord): Promise<boolean> {
    if (record.id !== id || record.revision !== expectedRevision + 1) throw new Error('invalid_package_revision');
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['packages', 'source-state'], 'readwrite');
      const store = transaction.objectStore('packages');
      const request = store.get(id);
      let written = false;
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== expectedRevision) return;
        if (!record.active || request.result?.publisherPin !== record.publisherPin)
          transaction.objectStore('source-state').delete(id);
        store.put(record);
        written = true;
      };
      transaction.oncomplete = () => resolve(written);
      transaction.onerror = transaction.onabort = () => reject(new Error('package_storage_unavailable'));
    });
  }

  async close(): Promise<void> {
    const database = await this.database;
    database?.close();
    this.database = undefined;
  }

  private async sourceState<T>(
    id: string,
    sourceId: string,
    revision: number,
    action: (all: SourceStateValues, quota: number, store: IDBObjectStore) => T,
    write: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    const database = await this.open();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['packages', 'source-state'], write ? 'readwrite' : 'readonly');
      const cancel = () => {
        try {
          transaction.abort();
        } catch {
          /* Already committed. */
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      let result: T;
      let failure: unknown;
      const request = transaction.objectStore('packages').get(id);
      request.onsuccess = () => {
        try {
          const quota = sourceStateScope(request.result, revision, sourceId);
          const store = transaction.objectStore('source-state');
          const values = store.get(id);
          values.onsuccess = () => {
            try {
              result = action(values.result ?? {}, quota, store);
            } catch (error) {
              failure = error;
              transaction.abort();
            }
          };
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      transaction.onerror = transaction.onabort = () => {
        signal?.removeEventListener('abort', cancel);
        reject(failure ?? (signal?.aborted ? signal.reason : new Error('package_storage_unavailable')));
      };
    });
  }

  readSourceState(id: string, sourceId: string, revision: number): Promise<SourceStateValues> {
    return this.sourceState(id, sourceId, revision, (all) => sourceStateView(all, sourceId), false);
  }

  commitSourceState(
    id: string,
    sourceId: string,
    revision: number,
    base: SourceStateValues,
    changes: SourceStateChanges,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.sourceState(
      id,
      sourceId,
      revision,
      (all, quota, store) => {
        store.put(mergeSourceState(all, sourceId, base, changes, quota), id);
      },
      true,
      signal,
    );
  }
}
