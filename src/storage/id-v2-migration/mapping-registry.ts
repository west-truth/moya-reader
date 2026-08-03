import { persistentId128 } from '../../domain/id-hash-contract';
import type { IdV2EntityType, IdV2MappingRecord } from './contracts';
import { ID_V2_MIGRATION_GENERATION } from './contracts';
import { IdV2MigrationValidationError } from './errors';

const PRESERVED_SENTINELS = new Set(['narrator', 'system', 'unknown']);

function lookupKey(entityType: IdV2EntityType, revisionScope: string, oldId: string): string {
  return JSON.stringify([entityType, revisionScope, oldId]);
}

function reverseKey(entityType: IdV2EntityType, revisionScope: string, newId: string): string {
  return JSON.stringify([entityType, revisionScope, newId]);
}

export function mappingRecordId(
  oldNovelId: string,
  entityType: IdV2EntityType,
  revisionScope: string,
  oldId: string,
): string {
  return JSON.stringify([oldNovelId, entityType, revisionScope, oldId]);
}

export function migrationEntityId(
  entityType: Exclude<IdV2EntityType, 'novel' | 'chapter' | 'paragraph' | 'page' | 'search_row'>,
  newNovelId: string,
  oldId: string,
  revisionScope = '',
): string {
  const namespace = entityType === 'character_relation' ? 'relation' : entityType;
  return persistentId128(namespace, [newNovelId, revisionScope, oldId]);
}

export class IdV2MappingRegistry {
  private readonly recordsByLookup = new Map<string, IdV2MappingRecord>();
  private readonly oldIdTargets = new Map<string, Set<string>>();
  private readonly oldIdRecords = new Map<string, IdV2MappingRecord[]>();
  private readonly reverse = new Map<string, string>();

  constructor(
    private readonly runId: string,
    private readonly oldNovelId: string,
    private readonly newNovelId: string,
    private readonly createdAt: string,
  ) {}

  add(
    entityType: IdV2EntityType,
    oldId: string,
    newId: string,
    revisionScope = '',
    identity?: Pick<IdV2MappingRecord, 'sourceFileName' | 'normalizedTextHash' | 'identityKey'>,
  ): IdV2MappingRecord {
    if (!oldId || !newId) {
      throw new IdV2MigrationValidationError('invalid_mapping', `Empty ${entityType} mapping`, entityType, oldId);
    }
    const key = lookupKey(entityType, revisionScope, oldId);
    const existing = this.recordsByLookup.get(key);
    if (existing) {
      if (existing.newId !== newId) {
        throw new IdV2MigrationValidationError(
          'semantic_id_collision',
          `${entityType} ${oldId} maps to multiple v2 IDs`,
          entityType,
          oldId,
        );
      }
      return existing;
    }
    const reverseLookup = reverseKey(entityType, revisionScope, newId);
    const previousOldId = this.reverse.get(reverseLookup);
    if (previousOldId && previousOldId !== oldId) {
      throw new IdV2MigrationValidationError(
        'semantic_id_collision',
        `${entityType} ${previousOldId} and ${oldId} map to ${newId}`,
        entityType,
        oldId,
      );
    }
    const record: IdV2MappingRecord = {
      id: mappingRecordId(this.oldNovelId, entityType, revisionScope, oldId),
      runId: this.runId,
      generation: ID_V2_MIGRATION_GENERATION,
      oldNovelId: this.oldNovelId,
      newNovelId: this.newNovelId,
      entityType,
      revisionScope,
      oldId,
      newId,
      ...identity,
      createdAt: this.createdAt,
    };
    this.recordsByLookup.set(key, record);
    this.reverse.set(reverseLookup, oldId);
    const targets = this.oldIdTargets.get(oldId) ?? new Set<string>();
    targets.add(newId);
    this.oldIdTargets.set(oldId, targets);
    const byOldId = this.oldIdRecords.get(oldId) ?? [];
    byOldId.push(record);
    this.oldIdRecords.set(oldId, byOldId);
    return record;
  }

  get(entityType: IdV2EntityType, oldId: string | undefined, revisionScope = ''): string | undefined {
    if (!oldId) return undefined;
    if (PRESERVED_SENTINELS.has(oldId)) return oldId;
    const mapped =
      this.recordsByLookup.get(lookupKey(entityType, revisionScope, oldId))?.newId ??
      this.recordsByLookup.get(lookupKey(entityType, '', oldId))?.newId;
    if (mapped) return mapped;

    const isCanonicalTarget =
      this.reverse.has(reverseKey(entityType, revisionScope, oldId)) ||
      this.reverse.has(reverseKey(entityType, '', oldId));
    return isCanonicalTarget ? oldId : undefined;
  }

  require(entityType: IdV2EntityType, oldId: string | undefined, revisionScope = ''): string {
    const mapped = this.get(entityType, oldId, revisionScope);
    if (!mapped) {
      throw new IdV2MigrationValidationError(
        'missing_mapping',
        `No ${entityType} mapping for ${oldId ?? '<missing>'}`,
        entityType,
        oldId,
      );
    }
    return mapped;
  }

  unique(oldId: string): string | undefined {
    if (PRESERVED_SENTINELS.has(oldId)) return oldId;
    const targets = this.oldIdTargets.get(oldId);
    return targets?.size === 1 ? Array.from(targets)[0] : undefined;
  }

  recordsForOldId(oldId: string): IdV2MappingRecord[] {
    return this.oldIdRecords.get(oldId) ?? [];
  }

  records(): IdV2MappingRecord[] {
    return Array.from(this.recordsByLookup.values()).sort((left, right) => left.id.localeCompare(right.id));
  }
}
