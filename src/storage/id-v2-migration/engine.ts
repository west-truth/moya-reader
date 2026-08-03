import { persistentId128 } from '../../domain/id-hash-contract';
import type {
  IdV2MigrationProgress,
  IdV2MigrationRun,
  IdV2MigrationSummary,
  RunIdV2MigrationOptions,
} from './contracts';
import { ID_V2_MIGRATION_GENERATION } from './contracts';
import { IdV2MigrationValidationError, throwIfMigrationAborted } from './errors';
import { yieldToMainThread } from './indexeddb';
import { migrateBookScopedLocalStorageKeys } from './local-storage';
import { buildIdV2MigrationPlan } from './plan-builder';
import { publishIdV2MigrationProgress } from './progress';
import { listLegacyV1Novels, loadIdV2BookSource } from './source-loader';
import {
  acquireIdV2MigrationLease,
  activateIdV2Migration,
  cleanupOrphanedIdV2StageRows,
  findIdV2MigrationRun,
  listIdV2MigrationRuns,
  quarantineIdV2Migration,
  releaseIdV2MigrationLease,
  renewIdV2MigrationLease,
  rollbackIdV2MigrationInDatabase,
  stageIdV2MigrationPlan,
} from './stage-store';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_DURATION_MS = 120_000;

function ownerToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `id-v2-${globalThis.crypto.randomUUID()}`;
  return `id-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function unresolvedRun(oldNovelId: string, sourceFileName: string, existing?: IdV2MigrationRun): IdV2MigrationRun {
  const now = new Date().toISOString();
  const newNovelId = existing?.newNovelId ?? `unresolved_${oldNovelId}`;
  return {
    id:
      existing?.id ??
      persistentId128('id_migration_run', [String(ID_V2_MIGRATION_GENERATION), oldNovelId, 'unresolved']),
    generation: ID_V2_MIGRATION_GENERATION,
    oldNovelId,
    newNovelId,
    sourceFileName,
    normalizedTextHash: existing?.normalizedTextHash ?? '',
    identityKey: existing?.identityKey ?? JSON.stringify([sourceFileName, 'unresolved']),
    status: existing?.status ?? 'pending',
    stagedRecordCount: existing?.stagedRecordCount ?? 0,
    backupRecordCount: existing?.backupRecordCount ?? 0,
    mappingCount: existing?.mappingCount ?? 0,
    checkpoint: existing?.checkpoint ?? 0,
    totalRecords: existing?.totalRecords ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    rollbackSafe: false,
  };
}

async function report(callback: RunIdV2MigrationOptions['onProgress'], progress: IdV2MigrationProgress): Promise<void> {
  publishIdV2MigrationProgress(progress);
  try {
    await callback?.(progress);
  } catch {
    // A UI progress callback is not part of the migration transaction contract.
  }
}

export async function runIdV2MigrationsInDatabase(
  db: IDBDatabase,
  options: RunIdV2MigrationOptions = {},
): Promise<IdV2MigrationSummary> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const leaseDurationMs = Math.max(5_000, options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS);
  const owner = ownerToken();
  const acquired = await acquireIdV2MigrationLease(db, owner, new Date(), leaseDurationMs);
  if (!acquired) {
    await report(options.onProgress, {
      status: 'locked',
      completedRecords: 0,
      totalRecords: 0,
      migratedBooks: 0,
      quarantinedBooks: 0,
    });
    return { status: 'locked', migratedBooks: 0, quarantinedBooks: 0, skippedBooks: 0 };
  }

  let migratedBooks = 0;
  let quarantinedBooks = 0;
  let skippedBooks = 0;
  let deferred = false;
  const leaseRenewalIntervalMs = Math.max(1_000, Math.floor(leaseDurationMs / 3));
  let renewLeaseAfter = Date.now() + leaseRenewalIntervalMs;
  const renewLeaseIfNeeded = async (force = false): Promise<void> => {
    if (!force && Date.now() < renewLeaseAfter) return;
    await renewIdV2MigrationLease(db, owner, leaseDurationMs);
    renewLeaseAfter = Date.now() + leaseRenewalIntervalMs;
  };
  try {
    throwIfMigrationAborted(options.signal);
    await cleanupOrphanedIdV2StageRows(db);
    const existingRuns = await listIdV2MigrationRuns(db);
    for (const run of existingRuns) {
      if (run.status !== 'pending' && run.status !== 'staging' && run.status !== 'ready') continue;
      const source = await loadIdV2BookSource(db, run.oldNovelId);
      if (!source) {
        await quarantineIdV2Migration(db, run, {
          code: 'source_missing',
          message: `Migration source ${run.oldNovelId} no longer exists`,
        });
        quarantinedBooks += 1;
      }
    }
    const candidates = await listLegacyV1Novels(db);
    await report(options.onProgress, {
      status: 'scanning',
      completedRecords: 0,
      totalRecords: candidates.length,
      migratedBooks,
      quarantinedBooks,
    });
    for (const novel of candidates) {
      throwIfMigrationAborted(options.signal);
      const existing = await findIdV2MigrationRun(db, novel.id);
      if (
        existing?.status === 'completed' ||
        existing?.status === 'quarantined' ||
        existing?.status === 'rolled_back'
      ) {
        skippedBooks += 1;
        continue;
      }
      const source = await loadIdV2BookSource(db, novel.id);
      if (!source) {
        skippedBooks += 1;
        continue;
      }
      await renewLeaseIfNeeded(true);
      let run = unresolvedRun(novel.id, novel.sourceFileName, existing);
      try {
        const plan = await buildIdV2MigrationPlan(source, existing, {
          yieldControl: async () => {
            await renewLeaseIfNeeded();
            await yieldToMainThread();
          },
        });
        await renewLeaseIfNeeded(true);
        run = plan.run;
        await report(options.onProgress, {
          runId: run.id,
          oldNovelId: run.oldNovelId,
          newNovelId: run.newNovelId,
          status: run.status,
          completedRecords: run.checkpoint,
          totalRecords: run.totalRecords,
          migratedBooks,
          quarantinedBooks,
        });
        run = await stageIdV2MigrationPlan(db, plan, {
          batchSize,
          throwIfCancelled: () => throwIfMigrationAborted(options.signal),
          onBatch: async (nextRun) => {
            await renewLeaseIfNeeded();
            await report(options.onProgress, {
              runId: nextRun.id,
              oldNovelId: nextRun.oldNovelId,
              newNovelId: nextRun.newNovelId,
              status: nextRun.status,
              completedRecords: nextRun.checkpoint,
              totalRecords: nextRun.totalRecords,
              migratedBooks,
              quarantinedBooks,
            });
            await yieldToMainThread();
          },
        });
        throwIfMigrationAborted(options.signal);
        await renewLeaseIfNeeded(true);
        run = await activateIdV2Migration(db, run);
        migrateBookScopedLocalStorageKeys(run.oldNovelId, run.newNovelId);
        migratedBooks += 1;
        await report(options.onProgress, {
          runId: run.id,
          oldNovelId: run.oldNovelId,
          newNovelId: run.newNovelId,
          status: 'completed',
          completedRecords: run.totalRecords,
          totalRecords: run.totalRecords,
          migratedBooks,
          quarantinedBooks,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        const validation = error instanceof IdV2MigrationValidationError ? error : undefined;
        const constraintFailure = error instanceof Error && ['ConstraintError', 'DataError'].includes(error.name);
        if (validation || constraintFailure) {
          await quarantineIdV2Migration(db, run, {
            code: validation?.code ?? 'target_key_collision',
            message: error instanceof Error ? error.message : 'ID v2 migration failed',
            entityType: validation?.entityType,
            entityId: validation?.entityId,
          });
          quarantinedBooks += 1;
        } else {
          deferred = true;
          skippedBooks += 1;
          break;
        }
      }
      await renewLeaseIfNeeded();
      await yieldToMainThread();
    }
    const summary: IdV2MigrationSummary = {
      status: deferred ? 'deferred' : candidates.length ? 'completed' : 'idle',
      migratedBooks,
      quarantinedBooks,
      skippedBooks,
    };
    await report(options.onProgress, {
      status: summary.status,
      completedRecords: candidates.length,
      totalRecords: candidates.length,
      migratedBooks,
      quarantinedBooks,
    });
    return summary;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      await report(options.onProgress, {
        status: 'cancelled',
        completedRecords: 0,
        totalRecords: 0,
        migratedBooks,
        quarantinedBooks,
      });
      return { status: 'cancelled', migratedBooks, quarantinedBooks, skippedBooks };
    }
    throw error;
  } finally {
    await releaseIdV2MigrationLease(db, owner).catch(() => undefined);
  }
}

export async function getIdV2MigrationStatus(db: IDBDatabase): Promise<IdV2MigrationRun[]> {
  return listIdV2MigrationRuns(db);
}

export async function rollbackIdV2Migration(db: IDBDatabase, runId: string): Promise<IdV2MigrationRun> {
  const run = await rollbackIdV2MigrationInDatabase(db, runId);
  migrateBookScopedLocalStorageKeys(run.newNovelId, run.oldNovelId);
  return run;
}
