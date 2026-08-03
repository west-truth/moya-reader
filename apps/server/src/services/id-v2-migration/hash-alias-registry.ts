import { IdV2MigrationError } from './contracts.js';

export class HashAliasRegistry {
  private readonly aliases = new Map<string, Set<string>>();

  add(sourceHash: string, canonicalHash: string): void {
    const targets = this.aliases.get(sourceHash) ?? new Set<string>();
    targets.add(canonicalHash);
    this.aliases.set(sourceHash, targets);
  }

  resolve(sourceHash: string): string | undefined {
    const targets = this.aliases.get(sourceHash);
    if (!targets || targets.size === 0) return undefined;
    if (targets.size > 1) {
      throw new IdV2MigrationError(
        'hash_reference_ambiguous',
        'A legacy hash reference resolves to multiple canonical hashes.',
        { entityType: 'hash', sourceId: sourceHash },
      );
    }
    return targets.values().next().value;
  }
}
