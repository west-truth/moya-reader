import type {
  IdV2MappingRecord,
  IdV2MigrationLease,
  IdV2MigrationPlan,
  IdV2MigrationRun,
  IdV2MigrationRunStoreRecord,
  IdV2QuarantineRecord,
  IdV2StageRecord,
} from './contracts';
import { ID_V2_MIGRATION_STORES } from './contracts';
import { IdV2MigrationValidationError } from './errors';
import { recordValueHash } from './hashes';
import { readAll, readAllByIndex, readOne, requestToPromise, transactionDone } from './indexeddb';
import { loadIdV2BookSource } from './source-loader';

const LEASE_ID = '__id_v2_migration_lease__';

function isRun(value: IdV2MigrationRunStoreRecord): value is IdV2MigrationRun {
  return value.id !== LEASE_ID;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function deleteByRunId(tx: IDBTransaction, storeName: string, runId: string): void {
  const store = tx.objectStore(storeName);
  const request = store.index('runId').openKeyCursor(runId);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}

export async function acquireIdV2MigrationLease(
  db: IDBDatabase,
  owner: string,
  now: Date,
  leaseDurationMs: number,
): Promise<boolean> {
  const tx = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
  const store = tx.objectStore(ID_V2_MIGRATION_STORES.runs);
  const current = await requestToPromise<IdV2MigrationLease | undefined>(store.get(LEASE_ID));
  const currentExpiry = current ? Date.parse(current.leaseExpiresAt) : Number.NaN;
  if (current && current.owner !== owner && Number.isFinite(currentExpiry) && currentExpiry > now.getTime()) {
    tx.abort();
    await transactionDone(tx).catch(() => undefined);
    return false;
  }
  const next: IdV2MigrationLease = {
    id: LEASE_ID,
    status: 'lease',
    owner,
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    updatedAt: now.toISOString(),
  };
  store.put(next);
  await transactionDone(tx);
  return true;
}

export async function renewIdV2MigrationLease(db: IDBDatabase, owner: string, leaseDurationMs: number): Promise<void> {
  const now = new Date();
  const tx = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
  const store = tx.objectStore(ID_V2_MIGRATION_STORES.runs);
  const current = await requestToPromise<IdV2MigrationLease | undefined>(store.get(LEASE_ID));
  if (!current || current.owner !== owner) {
    tx.abort();
    await transactionDone(tx).catch(() => undefined);
    throw new Error('ID v2 migration lease was lost');
  }
  store.put({
    ...current,
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    updatedAt: now.toISOString(),
  });
  await transactionDone(tx);
}

export async function releaseIdV2MigrationLease(db: IDBDatabase, owner: string): Promise<void> {
  const tx = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
  const store = tx.objectStore(ID_V2_MIGRATION_STORES.runs);
  const current = await requestToPromise<IdV2MigrationLease | undefined>(store.get(LEASE_ID));
  if (current?.owner === owner) store.delete(LEASE_ID);
  await transactionDone(tx);
}

export async function listIdV2MigrationRuns(db: IDBDatabase): Promise<IdV2MigrationRun[]> {
  const records = await readAll<IdV2MigrationRunStoreRecord>(db, ID_V2_MIGRATION_STORES.runs);
  return records.filter(isRun).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function findIdV2MigrationRun(db: IDBDatabase, oldNovelId: string): Promise<IdV2MigrationRun | undefined> {
  const tx = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readonly');
  const done = transactionDone(tx);
  const value = await requestToPromise<IdV2MigrationRun | undefined>(
    tx.objectStore(ID_V2_MIGRATION_STORES.runs).index('oldNovelId').get(oldNovelId),
  );
  await done;
  return value;
}

export async function clearIdV2RunArtifacts(db: IDBDatabase, runId: string): Promise<void> {
  const tx = db.transaction(
    [ID_V2_MIGRATION_STORES.mappings, ID_V2_MIGRATION_STORES.stage, ID_V2_MIGRATION_STORES.quarantine],
    'readwrite',
  );
  deleteByRunId(tx, ID_V2_MIGRATION_STORES.mappings, runId);
  deleteByRunId(tx, ID_V2_MIGRATION_STORES.stage, runId);
  deleteByRunId(tx, ID_V2_MIGRATION_STORES.quarantine, runId);
  await transactionDone(tx);
}

export async function cleanupOrphanedIdV2StageRows(db: IDBDatabase): Promise<number> {
  const [runs, staged] = await Promise.all([
    listIdV2MigrationRuns(db),
    readAll<IdV2StageRecord>(db, ID_V2_MIGRATION_STORES.stage),
  ]);
  const runIds = new Set(runs.map((run) => run.id));
  const orphaned = staged.filter((record) => !runIds.has(record.runId));
  if (!orphaned.length) return 0;
  const tx = db.transaction(ID_V2_MIGRATION_STORES.stage, 'readwrite');
  orphaned.forEach((record) => tx.objectStore(ID_V2_MIGRATION_STORES.stage).delete(record.id));
  await transactionDone(tx);
  return orphaned.length;
}

type PlanItem = { kind: 'mapping'; value: IdV2MappingRecord } | { kind: 'stage'; value: IdV2StageRecord };

export async function stageIdV2MigrationPlan(
  db: IDBDatabase,
  plan: IdV2MigrationPlan,
  options: {
    batchSize: number;
    onBatch(run: IdV2MigrationRun): void | Promise<void>;
    throwIfCancelled(): void;
  },
): Promise<IdV2MigrationRun> {
  let run = plan.run;
  const existing = await findIdV2MigrationRun(db, run.oldNovelId);
  if (existing?.sourceFingerprint && existing.sourceFingerprint !== run.sourceFingerprint) {
    await clearIdV2RunArtifacts(db, existing.id);
    run = { ...run, checkpoint: 0, status: 'staging' };
  }
  const items: PlanItem[] = [
    ...plan.mappings.map((value): PlanItem => ({ kind: 'mapping', value })),
    ...plan.targets.map((value): PlanItem => ({ kind: 'stage', value })),
    ...plan.backups.map((value): PlanItem => ({ kind: 'stage', value })),
  ];
  const start = Math.min(run.checkpoint, items.length);
  if (start === 0) {
    const tx = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
    tx.objectStore(ID_V2_MIGRATION_STORES.runs).put(run);
    await transactionDone(tx);
  }

  for (let offset = start; offset < items.length; offset += options.batchSize) {
    options.throwIfCancelled();
    const batch = items.slice(offset, offset + options.batchSize);
    const tx = db.transaction(
      [ID_V2_MIGRATION_STORES.runs, ID_V2_MIGRATION_STORES.mappings, ID_V2_MIGRATION_STORES.stage],
      'readwrite',
    );
    const mappingStore = tx.objectStore(ID_V2_MIGRATION_STORES.mappings);
    const stageStore = tx.objectStore(ID_V2_MIGRATION_STORES.stage);
    batch.forEach((item) => {
      if (item.kind === 'mapping') mappingStore.put(item.value);
      else stageStore.put(item.value);
    });
    run = {
      ...run,
      status: 'staging',
      checkpoint: Math.min(items.length, offset + batch.length),
      updatedAt: new Date().toISOString(),
    };
    tx.objectStore(ID_V2_MIGRATION_STORES.runs).put(run);
    await transactionDone(tx);
    await options.onBatch(run);
  }

  run = { ...run, status: 'ready', checkpoint: items.length, updatedAt: new Date().toISOString() };
  const tx = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
  tx.objectStore(ID_V2_MIGRATION_STORES.runs).put(run);
  await transactionDone(tx);
  return run;
}

async function stageRows(db: IDBDatabase, runId: string, kind: IdV2StageRecord['kind']): Promise<IdV2StageRecord[]> {
  return readAllByIndex<IdV2StageRecord>(
    db,
    ID_V2_MIGRATION_STORES.stage,
    'runId_kind',
    IDBKeyRange.only([runId, kind]),
  );
}

type IdV2StageManifest = Omit<IdV2StageRecord, 'value'>;

async function stageManifests(
  db: IDBDatabase,
  runId: string,
  kind: IdV2StageRecord['kind'],
): Promise<IdV2StageManifest[]> {
  const tx = db.transaction(ID_V2_MIGRATION_STORES.stage, 'readonly');
  const done = transactionDone(tx);
  const result: IdV2StageManifest[] = [];
  const request = tx
    .objectStore(ID_V2_MIGRATION_STORES.stage)
    .index('runId_kind')
    .openCursor(IDBKeyRange.only([runId, kind]));
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const { value: _value, ...manifest } = cursor.value as IdV2StageRecord;
      result.push(manifest);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  await done;
  return result;
}

export async function activateIdV2Migration(db: IDBDatabase, run: IdV2MigrationRun): Promise<IdV2MigrationRun> {
  const [targets, backups] = await Promise.all([
    stageRows(db, run.id, 'target'),
    stageManifests(db, run.id, 'rollback'),
  ]);
  if (targets.length !== run.stagedRecordCount || backups.length !== run.backupRecordCount) {
    throw new Error(`Migration ${run.id} staging manifest is incomplete`);
  }
  const storeNames = unique([
    ID_V2_MIGRATION_STORES.runs,
    ID_V2_MIGRATION_STORES.stage,
    ...targets.map((record) => record.storeName),
    ...backups.map((record) => record.storeName),
  ]);
  const tx = db.transaction(storeNames, 'readwrite');
  const done = transactionDone(tx);
  try {
    const existingTargets = await Promise.all(
      targets.map((record) =>
        requestToPromise<Record<string, unknown> | undefined>(tx.objectStore(record.storeName).get(record.recordKey)),
      ),
    );
    const collisionIndex = existingTargets.findIndex(Boolean);
    if (collisionIndex >= 0) {
      const collision = targets[collisionIndex];
      throw new IdV2MigrationValidationError(
        'target_key_collision',
        `Target ${collision.storeName}:${collision.recordKey} already exists`,
      );
    }
    targets.forEach((record) => tx.objectStore(record.storeName).add(record.value));
    backups.forEach((record) => tx.objectStore(record.storeName).delete(record.recordKey));
    targets.forEach((record) =>
      tx.objectStore(ID_V2_MIGRATION_STORES.stage).put({ ...record, value: {} } satisfies IdV2StageRecord),
    );
    const completed: IdV2MigrationRun = {
      ...run,
      status: 'completed',
      activatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rollbackSafe: true,
    };
    tx.objectStore(ID_V2_MIGRATION_STORES.runs).put(completed);
    await done;
    return completed;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed add may already have aborted the transaction.
    }
    await done.catch(() => undefined);
    throw error;
  }
}

export async function quarantineIdV2Migration(
  db: IDBDatabase,
  run: IdV2MigrationRun,
  input: { code: string; message: string; entityType?: IdV2QuarantineRecord['entityType']; entityId?: string },
): Promise<IdV2MigrationRun> {
  await clearIdV2RunArtifacts(db, run.id);
  const now = new Date().toISOString();
  const quarantined: IdV2MigrationRun = {
    ...run,
    status: 'quarantined',
    errorCode: input.code,
    checkpoint: 0,
    updatedAt: now,
    rollbackSafe: false,
  };
  const record: IdV2QuarantineRecord = {
    id: JSON.stringify([run.id, input.entityType ?? 'book', input.entityId ?? '', input.code]),
    runId: run.id,
    oldNovelId: run.oldNovelId,
    entityType: input.entityType ?? 'book',
    entityId: input.entityId,
    code: input.code,
    message: input.message,
    createdAt: now,
  };
  const tx = db.transaction([ID_V2_MIGRATION_STORES.runs, ID_V2_MIGRATION_STORES.quarantine], 'readwrite');
  tx.objectStore(ID_V2_MIGRATION_STORES.runs).put(quarantined);
  tx.objectStore(ID_V2_MIGRATION_STORES.quarantine).put(record);
  await transactionDone(tx);
  return quarantined;
}

export async function rollbackIdV2MigrationInDatabase(db: IDBDatabase, runId: string): Promise<IdV2MigrationRun> {
  const run = await readOne<IdV2MigrationRun>(db, ID_V2_MIGRATION_STORES.runs, runId);
  if (!run || run.status !== 'completed') throw new Error(`Migration ${runId} is not completed`);
  const [targets, backups, mappings] = await Promise.all([
    stageManifests(db, runId, 'target'),
    stageRows(db, runId, 'rollback'),
    readAllByIndex<IdV2MappingRecord>(db, ID_V2_MIGRATION_STORES.mappings, 'runId', runId),
  ]);
  const currentSource = await loadIdV2BookSource(db, run.newNovelId);
  const targetHashes = new Map(
    targets.map((record) => [JSON.stringify([record.storeName, record.recordKey]), record.valueHash]),
  );
  const currentHashes = new Map(
    (currentSource?.records ?? []).map((record) => [
      JSON.stringify([record.storeName, record.recordKey]),
      recordValueHash(record.value),
    ]),
  );
  const manifestChanged =
    targetHashes.size !== currentHashes.size ||
    Array.from(targetHashes).some(([key, hash]) => currentHashes.get(key) !== hash);
  if (manifestChanged) {
    const unsafe: IdV2MigrationRun = {
      ...run,
      rollbackSafe: false,
      updatedAt: new Date().toISOString(),
      errorCode: 'post_cutover_writes',
    };
    const save = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
    save.objectStore(ID_V2_MIGRATION_STORES.runs).put(unsafe);
    await transactionDone(save);
    throw new Error(`Migration ${runId} cannot roll back after post-cutover writes`);
  }
  const storeNames = unique([
    ID_V2_MIGRATION_STORES.runs,
    ID_V2_MIGRATION_STORES.mappings,
    ID_V2_MIGRATION_STORES.stage,
    ...targets.map((record) => record.storeName),
    ...backups.map((record) => record.storeName),
  ]);
  const tx = db.transaction(storeNames, 'readwrite');
  const done = transactionDone(tx);
  try {
    const currentTargets = await Promise.all(
      targets.map((record) =>
        requestToPromise<Record<string, unknown> | undefined>(tx.objectStore(record.storeName).get(record.recordKey)),
      ),
    );
    const changed = currentTargets.some(
      (value, index) => !value || recordValueHash(value) !== targets[index].valueHash,
    );
    if (changed) {
      tx.abort();
      await done.catch(() => undefined);
      const unsafe: IdV2MigrationRun = {
        ...run,
        rollbackSafe: false,
        updatedAt: new Date().toISOString(),
        errorCode: 'post_cutover_writes',
      };
      const save = db.transaction(ID_V2_MIGRATION_STORES.runs, 'readwrite');
      save.objectStore(ID_V2_MIGRATION_STORES.runs).put(unsafe);
      await transactionDone(save);
      throw new Error(`Migration ${runId} cannot roll back after post-cutover writes`);
    }
    targets.forEach((record) => tx.objectStore(record.storeName).delete(record.recordKey));
    backups.forEach((record) => tx.objectStore(record.storeName).put(record.value));
    mappings.forEach((record) => tx.objectStore(ID_V2_MIGRATION_STORES.mappings).delete(record.id));
    [...targets, ...backups].forEach((record) => tx.objectStore(ID_V2_MIGRATION_STORES.stage).delete(record.id));
    const rolledBack: IdV2MigrationRun = {
      ...run,
      status: 'rolled_back',
      rolledBackAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rollbackSafe: false,
    };
    tx.objectStore(ID_V2_MIGRATION_STORES.runs).put(rolledBack);
    await done;
    return rolledBack;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already be complete or aborted.
    }
    await done.catch(() => undefined);
    throw error;
  }
}
