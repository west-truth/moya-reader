import type { SyncEntityType, SyncEventType } from '../../sync/types';
import type { IdV2EntityType } from './contracts';
import { IdV2MigrationValidationError } from './errors';
import { IdV2MappingRegistry } from './mapping-registry';

const FIELD_ENTITY_TYPES: Record<string, IdV2EntityType> = {
  novelId: 'novel',
  bookId: 'novel',
  chapterId: 'chapter',
  paragraphId: 'paragraph',
  pageId: 'page',
  segmentId: 'segment',
  characterId: 'character',
  sourceCharacterId: 'character',
  targetCharacterId: 'character',
  speakerId: 'character',
  voiceProfileId: 'voice_profile',
};

const ARRAY_ENTITY_TYPES: Record<string, IdV2EntityType> = {
  chapterIds: 'chapter',
  paragraphIds: 'paragraph',
  segmentIds: 'segment',
  characterIds: 'character',
  activeCharacterIds: 'character',
  candidateSpeakers: 'character',
  listenerIds: 'character',
  voiceProfileIds: 'voice_profile',
};

const NESTED_ENTITY_TYPES: Record<string, IdV2EntityType> = {
  novel: 'novel',
  book: 'novel',
  position: 'reading_position',
  readingPosition: 'reading_position',
  bookmark: 'bookmark',
  highlight: 'highlight',
  note: 'note',
  character: 'character',
  relation: 'character_relation',
  segment: 'segment',
  correction: 'correction',
  voiceProfile: 'voice_profile',
};

const NESTED_ARRAY_ENTITY_TYPES: Record<string, IdV2EntityType> = {
  bookmarks: 'bookmark',
  highlights: 'highlight',
  notes: 'note',
  characters: 'character',
  relations: 'character_relation',
  segments: 'segment',
  corrections: 'correction',
  voiceProfiles: 'voice_profile',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mappedString(
  value: string,
  registry: IdV2MappingRegistry,
  entityType?: IdV2EntityType,
  revisionScope = '',
): string {
  return (entityType ? registry.get(entityType, value, revisionScope) : undefined) ?? registry.unique(value) ?? value;
}

export function remapJsonIds(
  value: unknown,
  registry: IdV2MappingRegistry,
  entityHint?: IdV2EntityType,
  revisionScope = '',
): unknown {
  if (typeof value === 'string') return mappedString(value, registry, entityHint, revisionScope);
  if (Array.isArray(value)) {
    return value.map((item) => remapJsonIds(item, registry, entityHint, revisionScope));
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'id' && typeof item === 'string' && entityHint) {
      result[key] = mappedString(item, registry, entityHint, revisionScope);
      continue;
    }
    const fieldType = FIELD_ENTITY_TYPES[key];
    if (fieldType && typeof item === 'string') {
      result[key] = mappedString(item, registry, fieldType, revisionScope);
      continue;
    }
    const arrayType = ARRAY_ENTITY_TYPES[key];
    if (arrayType && Array.isArray(item)) {
      result[key] = item.map((entry) =>
        typeof entry === 'string' ? mappedString(entry, registry, arrayType, revisionScope) : entry,
      );
      continue;
    }
    const nestedType = NESTED_ENTITY_TYPES[key];
    if (nestedType) {
      result[key] = remapJsonIds(item, registry, nestedType, revisionScope);
      continue;
    }
    const nestedArrayType = NESTED_ARRAY_ENTITY_TYPES[key];
    if (nestedArrayType && Array.isArray(item)) {
      result[key] = item.map((entry) => remapJsonIds(entry, registry, nestedArrayType, revisionScope));
      continue;
    }
    result[key] = remapJsonIds(item, registry, undefined, revisionScope);
  }
  return result;
}

export function syncEventEntityType(type: SyncEventType): IdV2EntityType | undefined {
  if (type === 'book_imported' || type === 'book_updated' || type === 'book_deleted') return 'novel';
  if (type === 'reading_position_updated' || type === 'reading_position_deleted') return 'reading_position';
  if (type === 'bookmark_created' || type === 'bookmark_deleted') return 'bookmark';
  if (type === 'highlight_created' || type === 'highlight_deleted') return 'highlight';
  if (type === 'note_created' || type === 'note_updated' || type === 'note_deleted') return 'note';
  if (type === 'user_correction_created' || type === 'user_correction_deleted') return 'correction';
  return undefined;
}

export function syncRevisionEntityType(type: SyncEntityType): IdV2EntityType | undefined {
  if (type === 'book') return 'novel';
  if (type === 'reading_position') return 'reading_position';
  if (type === 'bookmark') return 'bookmark';
  if (type === 'highlight') return 'highlight';
  if (type === 'note') return 'note';
  if (type === 'user_correction') return 'correction';
  return undefined;
}

export function remapCorrectionJson(value: unknown, registry: IdV2MappingRegistry): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.stringify(remapJsonIds(JSON.parse(value), registry));
  } catch {
    throw new IdV2MigrationValidationError(
      'invalid_correction_json',
      'Correction JSON cannot be remapped',
      'correction',
    );
  }
}
