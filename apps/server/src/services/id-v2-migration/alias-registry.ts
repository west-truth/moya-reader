import { IdV2MigrationError, type BookEntityType, type EntityAlias } from './contracts.js';

const preservedSentinels = new Set(['narrator', 'system', 'unknown']);

export class AliasRegistry {
  private readonly byType = new Map<BookEntityType, Map<string, string>>();
  private readonly reverseByType = new Map<BookEntityType, Map<string, string>>();

  add(entityType: BookEntityType, sourceId: string, canonicalId: string): void {
    if (preservedSentinels.has(sourceId)) return;
    const forward = this.byType.get(entityType) ?? new Map<string, string>();
    const reverse = this.reverseByType.get(entityType) ?? new Map<string, string>();
    const existingCanonical = forward.get(sourceId);
    const existingSource = reverse.get(canonicalId);
    if (existingCanonical && existingCanonical !== canonicalId) {
      throw new IdV2MigrationError('identity_source_collision', 'A source ID has conflicting canonical identities.', {
        entityType,
        sourceId,
      });
    }
    if (existingSource && existingSource !== sourceId) {
      throw new IdV2MigrationError(
        'identity_semantic_collision',
        'Two source rows resolve to one canonical identity.',
        {
          entityType,
          sourceId,
        },
      );
    }
    forward.set(sourceId, canonicalId);
    reverse.set(canonicalId, sourceId);
    this.byType.set(entityType, forward);
    this.reverseByType.set(entityType, reverse);
  }

  resolve(entityType: BookEntityType, sourceId: string | undefined): string | undefined {
    if (!sourceId || preservedSentinels.has(sourceId)) return sourceId;
    return this.byType.get(entityType)?.get(sourceId);
  }

  require(entityType: BookEntityType, sourceId: string | undefined): string {
    if (!sourceId) {
      throw new IdV2MigrationError('identity_reference_missing', 'A required identity reference is missing.', {
        entityType,
      });
    }
    const resolved = this.resolve(entityType, sourceId);
    if (!resolved) {
      throw new IdV2MigrationError('identity_alias_missing', 'A child identity has no canonical alias.', {
        entityType,
        sourceId,
      });
    }
    return resolved;
  }

  resolveUnique(sourceId: string): string | undefined {
    if (preservedSentinels.has(sourceId)) return sourceId;
    const candidates = new Set<string>();
    for (const aliases of this.byType.values()) {
      const candidate = aliases.get(sourceId);
      if (candidate) candidates.add(candidate);
    }
    if (candidates.size > 1) {
      throw new IdV2MigrationError('identity_reference_ambiguous', 'A nested identity reference is ambiguous.', {
        sourceId,
      });
    }
    return candidates.values().next().value;
  }

  entries(): EntityAlias[] {
    const result: EntityAlias[] = [];
    for (const [entityType, aliases] of this.byType) {
      for (const [sourceId, canonicalId] of aliases) {
        result.push({ entityType, sourceId, canonicalId });
      }
    }
    return result.sort(
      (left, right) => left.entityType.localeCompare(right.entityType) || left.sourceId.localeCompare(right.sourceId),
    );
  }
}
