import { persistentId128 } from '../id-hash-contract';
import { structuredIntegrityHash } from './structured-integrity';

export function syncPayloadIntegrityHash(payload: unknown): string {
  return structuredIntegrityHash(payload);
}

interface ResourceRevisionItem {
  readonly id: string;
}

function sortedResourceItems<T extends ResourceRevisionItem>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

export function resourceCollectionRevision<T extends ResourceRevisionItem>(
  resourceKind: string,
  items: readonly T[],
): string {
  return structuredIntegrityHash({ resourceKind, items: sortedResourceItems(items) });
}

export function resourceGraphRevision<C extends ResourceRevisionItem, R extends ResourceRevisionItem>(
  resourceKind: string,
  characters: readonly C[],
  relations: readonly R[],
): string {
  return structuredIntegrityHash({
    resourceKind,
    characters: sortedResourceItems(characters),
    relations: sortedResourceItems(relations),
  });
}

export function resourceEntityRevision<T extends ResourceRevisionItem>(
  resourceKind: string,
  value: T | undefined,
): string {
  return structuredIntegrityHash(value ? { resourceKind, state: 'present', value } : { resourceKind, state: 'absent' });
}

interface VoiceProfileRevisionItem extends ResourceRevisionItem {
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export function voiceProfilesResourceRevision<T extends VoiceProfileRevisionItem>(items: readonly T[]): string {
  return resourceCollectionRevision(
    'voice_profiles',
    items.map((item) => {
      const value = { ...item } as { id: string; createdAt?: unknown; updatedAt?: unknown };
      delete value.createdAt;
      delete value.updatedAt;
      return value;
    }),
  );
}

interface UserCorrectionRevisionItem extends ResourceRevisionItem {
  readonly beforeJson?: unknown;
  readonly afterJson: unknown;
}

function parsedJsonRevisionValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function userCorrectionResourceRevision<T extends UserCorrectionRevisionItem>(value: T | undefined): string {
  return resourceEntityRevision(
    'user_correction',
    value
      ? {
          ...value,
          beforeJson: parsedJsonRevisionValue(value.beforeJson),
          afterJson: parsedJsonRevisionValue(value.afterJson),
        }
      : undefined,
  );
}

export type AggregateSyncEntityType = 'voice_profiles' | 'voice_casting' | 'character_graph' | 'chapter_segments';

export function aggregateSyncEntityId(input: {
  entityType: AggregateSyncEntityType;
  novelId: string;
  chapterId?: string;
}): string {
  return persistentId128('sync_entity', [input.entityType, input.novelId, input.chapterId ?? '']);
}

export function syncEventId(input: {
  userId: string;
  deviceId?: string;
  type: string;
  novelId?: string;
  entityId?: string;
  seed: string;
}): string {
  return persistentId128('sync_event', [
    input.userId,
    input.deviceId ?? '',
    input.type,
    input.novelId ?? '',
    input.entityId ?? '',
    input.seed,
  ]);
}
