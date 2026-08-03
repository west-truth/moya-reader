import { persistentId128 } from '../../domain/id-hash-contract';
import { parsedNovelId } from '../../domain/parser/entity-identities';
import type { IdV2BookSource, IdV2MigrationPlan, IdV2MigrationRun } from './contracts';
import { ID_V2_MIGRATION_GENERATION } from './contracts';
import { addContentPlan, canonicalBookHashes, migrationIdentityKey } from './content-plan';
import { IdV2MigrationValidationError } from './errors';
import { IdV2MappingRegistry } from './mapping-registry';
import { IdV2PlanAccumulator } from './plan-accumulator';
import { addReferencePlan } from './reference-plan';
import { idV2SourceFingerprint } from './source-loader';

export function idV2MigrationRunId(oldNovelId: string, newNovelId: string): string {
  return persistentId128('id_migration_run', [String(ID_V2_MIGRATION_GENERATION), oldNovelId, newNovelId]);
}

export async function buildIdV2MigrationPlan(
  source: IdV2BookSource,
  existingRun?: IdV2MigrationRun,
  options: { yieldControl?: () => Promise<void> } = {},
): Promise<IdV2MigrationPlan> {
  const { normalizedHash, rawHash } = canonicalBookHashes(source.novel);
  const newNovelId = parsedNovelId(source.novel.sourceFileName, normalizedHash);
  const identityKey = migrationIdentityKey(source.novel.sourceFileName, normalizedHash);
  const runId = idV2MigrationRunId(source.novel.id, newNovelId);
  if (existingRun && (existingRun.id !== runId || existingRun.newNovelId !== newNovelId)) {
    throw new IdV2MigrationValidationError(
      'source_identity_changed',
      `Book ${source.novel.id} changed identity while migration was staged`,
    );
  }
  const now = new Date().toISOString();
  const sourceFingerprint = idV2SourceFingerprint(source);
  const registry = new IdV2MappingRegistry(runId, source.novel.id, newNovelId, now);
  registry.add('novel', source.novel.id, newNovelId, '', {
    sourceFileName: source.novel.sourceFileName,
    normalizedTextHash: normalizedHash,
    identityKey,
  });
  const accumulator = new IdV2PlanAccumulator(runId, source.records);
  await options.yieldControl?.();
  await addContentPlan({
    source,
    newNovelId,
    normalizedHash,
    rawHash,
    registry,
    accumulator,
    yieldControl: options.yieldControl,
  });
  await options.yieldControl?.();
  addReferencePlan({ source, newNovelId, registry, accumulator });

  const mappings = registry.records();
  const targets = accumulator.targets();
  const backups = await accumulator.rollbackRecords(options.yieldControl);
  const run: IdV2MigrationRun = {
    id: runId,
    generation: ID_V2_MIGRATION_GENERATION,
    oldNovelId: source.novel.id,
    newNovelId,
    sourceFileName: source.novel.sourceFileName,
    normalizedTextHash: normalizedHash,
    identityKey,
    status: existingRun?.status === 'ready' ? 'ready' : 'staging',
    sourceFingerprint,
    stagedRecordCount: targets.length,
    backupRecordCount: backups.length,
    mappingCount: mappings.length,
    checkpoint: existingRun?.sourceFingerprint === sourceFingerprint ? existingRun.checkpoint : 0,
    totalRecords: mappings.length + targets.length + backups.length,
    createdAt: existingRun?.createdAt ?? now,
    updatedAt: now,
    rollbackSafe: existingRun?.rollbackSafe ?? true,
  };
  return { run, mappings, targets, backups };
}
