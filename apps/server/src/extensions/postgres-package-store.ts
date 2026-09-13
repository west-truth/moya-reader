import type pg from 'pg';
import type { RepositoryRecord } from '../../../../src/extensions/packages/repository-contract.js';
import {
  mergeSourceState,
  sourceStateScope,
  sourceStateView,
  type SourceStateChanges,
  type SourceStateValues,
} from '../../../../src/extensions/packages/source-state.js';
import type {
  InstalledPackageRecord,
  InstalledPackageSummary,
  InstalledPackageVersion,
  PackageInstallStore,
} from '../../../../src/extensions/packages/package-install-store.js';

type StoredMetadata = Omit<InstalledPackageRecord, 'active' | 'previous'> & {
  active?: Omit<InstalledPackageVersion, 'archive'>;
  previous?: Omit<InstalledPackageVersion, 'archive'>;
};

/** User scope is fixed by the authenticated host, never taken from package or request JSON. */
export class PostgresPackageInstallStore implements PackageInstallStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly userId: string,
  ) {}
  async listRepositories(): Promise<readonly RepositoryRecord[]> {
    return (
      await this.pool.query<{ metadata: RepositoryRecord }>(
        'select metadata from extension_repositories where user_id = $1 order by repository_url',
        [this.userId],
      )
    ).rows.map((row) => row.metadata);
  }
  async saveRepository(record: RepositoryRecord, expectedRevision: number): Promise<boolean> {
    if (record.revision !== expectedRevision + 1) throw new Error('package_repository_conflict');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Serializes adds across URLs as well, keeping the owner repository limit atomic.
      await client.query('select id from users where id = $1 for update', [this.userId]);
      const all = (
        await client.query<{ metadata: RepositoryRecord }>(
          'select metadata from extension_repositories where user_id = $1',
          [this.userId],
        )
      ).rows.map((row) => row.metadata);
      const previous = all.find((item) => item.url === record.url);
      if (
        (previous?.revision ?? 0) !== expectedRevision ||
        (record.index && !previous?.index && all.filter((item) => item.index).length >= 16)
      ) {
        await client.query('rollback');
        return false;
      }
      await client.query(
        'insert into extension_repositories(user_id, repository_url, revision, metadata) values($1,$2,$3,$4::jsonb) on conflict(user_id, repository_url) do update set revision=excluded.revision, metadata=excluded.metadata',
        [this.userId, record.url, record.revision, JSON.stringify(record)],
      );
      await client.query('commit');
      return true;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<readonly InstalledPackageSummary[]> {
    const result = await this.pool.query<{ metadata: InstalledPackageSummary }>(
      `select (metadata #- '{active,settings}' #- '{previous,settings}') as metadata
         from extension_packages where user_id = $1 order by package_id`,
      [this.userId],
    );
    return result.rows.map((row) => row.metadata);
  }

  async read(id: string): Promise<InstalledPackageRecord | undefined> {
    const result = await this.pool.query<{
      metadata: StoredMetadata;
      active_archive: Buffer | null;
      previous_archive: Buffer | null;
    }>(
      'select metadata, active_archive, previous_archive from extension_packages where user_id = $1 and package_id = $2',
      [this.userId, id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const version = (metadata: StoredMetadata['active'], bytes: Buffer | null): InstalledPackageVersion | undefined => {
      if (!metadata) {
        if (bytes) throw new Error('package_storage_integrity');
        return undefined;
      }
      if (!bytes) throw new Error('package_storage_integrity');
      return { ...metadata, archive: new Blob([Uint8Array.from(bytes)]) };
    };
    return {
      ...row.metadata,
      active: version(row.metadata.active, row.active_archive),
      previous: version(row.metadata.previous, row.previous_archive),
    };
  }

  async compareAndSwap(id: string, expectedRevision: number, record: InstalledPackageRecord): Promise<boolean> {
    if (
      record.id !== id ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      record.revision !== expectedRevision + 1 ||
      !Number.isSafeInteger(record.revision)
    )
      throw new Error('invalid_package_revision');
    const version = (entry: InstalledPackageVersion | undefined) =>
      entry
        ? {
            digest: entry.digest,
            manifest: entry.manifest,
            settings: entry.settings,
            publisherFingerprint: entry.publisherFingerprint,
          }
        : undefined;
    const bytes = async (entry: InstalledPackageVersion | undefined) => {
      if (!entry) return null;
      if (entry.archive.size > 10 * 1024 * 1024) throw new Error('package_limit');
      return Buffer.from(await entry.archive.arrayBuffer());
    };
    const metadata: StoredMetadata = { ...record, active: version(record.active), previous: version(record.previous) };
    // One statement commits archive + settings + revision. Tombstones remain to fence stale clients and publisher trust.
    const result = await this.pool.query(
      `insert into extension_packages(user_id, package_id, revision, metadata, active_archive, previous_archive)
       select $1, $2, $3, $4::jsonb, $5::bytea, $6::bytea
        where $7::bigint = 0 or exists (
          select 1 from extension_packages where user_id = $1 and package_id = $2 and revision = $7)
       on conflict (user_id, package_id) do update set revision = excluded.revision, metadata = excluded.metadata,
         active_archive = excluded.active_archive, previous_archive = excluded.previous_archive,
         source_state = case when excluded.active_archive is null
             or extension_packages.metadata->>'publisherPin' is distinct from excluded.metadata->>'publisherPin'
           then '{}'::jsonb else extension_packages.source_state end
        where extension_packages.revision = $7
       returning revision`,
      [
        this.userId,
        id,
        record.revision,
        JSON.stringify(metadata),
        await bytes(record.active),
        await bytes(record.previous),
        expectedRevision,
      ],
    );
    return result.rows.length === 1;
  }

  async readSourceState(id: string, sourceId: string, revision: number): Promise<SourceStateValues> {
    const result = await this.pool.query<{ metadata: InstalledPackageRecord; source_state: SourceStateValues }>(
      'select metadata, source_state from extension_packages where user_id = $1 and package_id = $2',
      [this.userId, id],
    );
    sourceStateScope(result.rows[0]?.metadata, revision, sourceId);
    return sourceStateView(result.rows[0].source_state, sourceId);
  }

  async commitSourceState(
    id: string,
    sourceId: string,
    revision: number,
    base: SourceStateValues,
    changes: SourceStateChanges,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ metadata: InstalledPackageRecord; source_state: SourceStateValues }>(
        'select metadata, source_state from extension_packages where user_id = $1 and package_id = $2 for update',
        [this.userId, id],
      );
      const quota = sourceStateScope(result.rows[0]?.metadata, revision, sourceId);
      signal?.throwIfAborted();
      const values = mergeSourceState(result.rows[0].source_state, sourceId, base, changes, quota);
      await client.query(
        'update extension_packages set source_state = $3::jsonb where user_id = $1 and package_id = $2',
        [this.userId, id, JSON.stringify(values)],
      );
      signal?.throwIfAborted();
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
