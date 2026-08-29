import type { CloudVaultSyncScope } from './contracts';

export const CLOUD_VAULT_MUTATION_KINDS = [
  'library',
  'content',
  'progress',
  'annotations',
  'statistics',
  'aiTts',
  'settings',
] as const;

export type CloudVaultMutationKind = (typeof CLOUD_VAULT_MUTATION_KINDS)[number];
export type CloudVaultMutationRevisions = Readonly<Record<CloudVaultMutationKind, number>>;

export function initialCloudVaultMutationRevisions(): CloudVaultMutationRevisions {
  return Object.fromEntries(
    CLOUD_VAULT_MUTATION_KINDS.map((kind) => [kind, 0]),
  ) as unknown as CloudVaultMutationRevisions;
}

export function cloudVaultMutationEnabled(kind: CloudVaultMutationKind, scope: CloudVaultSyncScope): boolean {
  if (kind === 'annotations') return scope.annotations;
  if (kind === 'statistics') return scope.statistics;
  if (kind === 'aiTts') return scope.aiTtsArtifacts;
  if (kind === 'settings') return scope.readerSettings;
  if (kind === 'content') return scope.library || scope.sourceFiles;
  return scope.library;
}

/** Statistics ride along with another sync instead of causing network traffic alone. */
export function cloudVaultMutationDelay(
  kinds: ReadonlySet<CloudVaultMutationKind>,
  dirtyForMs: number,
): number | undefined {
  if (kinds.has('library') || kinds.has('content') || kinds.has('annotations')) return 5_000;
  if (kinds.has('settings')) return 10_000;
  if (kinds.has('progress')) return Math.max(0, Math.min(60_000, 180_000 - dirtyForMs));
  if (kinds.has('aiTts')) return Math.max(0, Math.min(60_000, 180_000 - dirtyForMs));
  return undefined;
}
