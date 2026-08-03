import { persistentId128 } from '../../domain/id-hash-contract';
import type { IdV2SourceRecord, IdV2StageRecord } from './contracts';
import { IdV2MigrationValidationError } from './errors';
import { recordValueHash } from './hashes';

function stageId(runId: string, kind: IdV2StageRecord['kind'], storeName: string, recordKey: string): string {
  return persistentId128('id_migration_stage', [runId, kind, storeName, recordKey]);
}

function stageRecord(
  runId: string,
  kind: IdV2StageRecord['kind'],
  storeName: string,
  recordKey: string,
  value: Record<string, unknown>,
): IdV2StageRecord {
  return {
    id: stageId(runId, kind, storeName, recordKey),
    runId,
    kind,
    storeName,
    recordKey,
    value,
    valueHash: recordValueHash(value),
  };
}

export class IdV2PlanAccumulator {
  private readonly targetByKey = new Map<string, IdV2StageRecord>();
  private readonly backupSources: IdV2SourceRecord[];

  constructor(
    private readonly runId: string,
    sourceRecords: IdV2SourceRecord[],
  ) {
    this.backupSources = sourceRecords;
  }

  target(storeName: string, recordKey: string, value: Record<string, unknown>): void {
    const key = JSON.stringify([storeName, recordKey]);
    const next = stageRecord(this.runId, 'target', storeName, recordKey, value);
    const existing = this.targetByKey.get(key);
    if (existing && existing.valueHash !== next.valueHash) {
      throw new IdV2MigrationValidationError(
        'target_key_collision',
        `Multiple migrated records target ${storeName}:${recordKey}`,
      );
    }
    this.targetByKey.set(key, next);
  }

  targets(): IdV2StageRecord[] {
    return Array.from(this.targetByKey.values()).sort(
      (left, right) => left.storeName.localeCompare(right.storeName) || left.recordKey.localeCompare(right.recordKey),
    );
  }

  async rollbackRecords(yieldControl?: () => Promise<void>, recordsPerYield = 32): Promise<IdV2StageRecord[]> {
    const backups: IdV2StageRecord[] = [];
    for (const [index, record] of this.backupSources.entries()) {
      backups.push(stageRecord(this.runId, 'rollback', record.storeName, record.recordKey, record.value));
      if (yieldControl && (index + 1) % recordsPerYield === 0) await yieldControl();
    }
    return backups.sort(
      (left, right) => left.storeName.localeCompare(right.storeName) || left.recordKey.localeCompare(right.recordKey),
    );
  }
}
