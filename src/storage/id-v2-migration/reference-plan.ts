import type {
  Bookmark,
  Character,
  LabeledSegment,
  ReaderHighlight,
  ReaderNote,
  ReadingPosition,
  UserCorrection,
  VoiceProfile,
} from '../../domain/types';
import type { CharacterRelation } from '../../providers/ai';
import type { SyncEntityRevision, SyncEvent, SyncOutboxItem } from '../../sync/types';
import type { IdV2BookSource, IdV2EntityType } from './contracts';
import { canonicalPayloadHash } from './content-plan';
import { IdV2MigrationValidationError } from './errors';
import { canonicalStoredHash } from './hashes';
import { remapCorrectionJson, remapJsonIds, syncEventEntityType, syncRevisionEntityType } from './json-remap';
import { IdV2MappingRegistry, migrationEntityId } from './mapping-registry';
import { IdV2PlanAccumulator } from './plan-accumulator';

const CHARACTER_SENTINELS = new Set(['narrator', 'system', 'unknown']);

function values<T>(source: IdV2BookSource, storeName: string): T[] {
  return source.records.filter((record) => record.storeName === storeName).map((record) => record.value as T);
}

function addEntityMappings<T extends { id: string }>(
  rows: T[],
  entityType: Exclude<IdV2EntityType, 'novel' | 'chapter' | 'paragraph' | 'page' | 'search_row'>,
  newNovelId: string,
  registry: IdV2MappingRegistry,
): void {
  rows.forEach((row) => registry.add(entityType, row.id, migrationEntityId(entityType, newNovelId, row.id)));
}

function remapOptional(
  registry: IdV2MappingRegistry,
  entityType: IdV2EntityType,
  oldId: string | undefined,
): string | undefined {
  return oldId ? registry.require(entityType, oldId) : undefined;
}

function remapCharacter(registry: IdV2MappingRegistry, oldId: string): string {
  return CHARACTER_SENTINELS.has(oldId) ? oldId : registry.require('character', oldId);
}

function ensureMissingEntityMapping(
  registry: IdV2MappingRegistry,
  entityType: IdV2EntityType,
  oldId: string,
  newNovelId: string,
): void {
  if (registry.get(entityType, oldId)) return;
  if (entityType === 'reading_position') {
    registry.add(entityType, oldId, `reading_position_${newNovelId}`);
    return;
  }
  if (entityType === 'novel') return;
  if (entityType === 'chapter' || entityType === 'paragraph' || entityType === 'page') {
    throw new IdV2MigrationValidationError(
      'missing_anchor_mapping',
      `Cannot derive ${entityType} ${oldId} without source content`,
      entityType,
      oldId,
    );
  }
  if (entityType === 'search_row') return;
  registry.add(entityType, oldId, migrationEntityId(entityType, newNovelId, oldId));
}

function tombstoneEntityType(value: string): IdV2EntityType | undefined {
  if (value === 'bookmark' || value === 'highlight' || value === 'note') return value;
  if (value === 'reading_position') return 'reading_position';
  if (value === 'user_correction') return 'correction';
  return undefined;
}

function mapEventEntityId(event: SyncEvent, registry: IdV2MappingRegistry, newNovelId: string): string | undefined {
  if (!event.entityId) return undefined;
  const directType = syncEventEntityType(event.type);
  if (directType) {
    ensureMissingEntityMapping(registry, directType, event.entityId, newNovelId);
    return registry.require(directType, event.entityId);
  }
  if (event.type === 'character_graph_updated') return `character_graph_${newNovelId}`;
  if (event.type === 'voice_profiles_updated') return `voice_profiles_${newNovelId}`;
  if (event.type === 'chapter_segments_updated') {
    const payload = event.payload as Record<string, unknown>;
    const chapterId = typeof payload.chapterId === 'string' ? payload.chapterId : '';
    return chapterId ? `chapter_segments_${registry.require('chapter', chapterId)}` : event.entityId;
  }
  return event.entityId;
}

function mapRevision(
  revision: SyncEntityRevision | undefined,
  registry: IdV2MappingRegistry,
  newNovelId: string,
  nextPayload: unknown,
): SyncEntityRevision | undefined {
  if (!revision) return undefined;
  const entityType = syncRevisionEntityType(revision.entityType);
  let entityId = revision.entityId;
  if (entityType) {
    ensureMissingEntityMapping(registry, entityType, revision.entityId, newNovelId);
    entityId = registry.require(entityType, revision.entityId);
  } else if (revision.entityType === 'character_graph') {
    entityId = `character_graph_${newNovelId}`;
  } else if (revision.entityType === 'voice_profiles') {
    entityId = `voice_profiles_${newNovelId}`;
  } else if (revision.entityType === 'chapter_segments') {
    const oldChapterId = entityId.startsWith('chapter_segments_') ? entityId.slice('chapter_segments_'.length) : '';
    const newChapterId = oldChapterId ? registry.get('chapter', oldChapterId) : undefined;
    if (newChapterId) entityId = `chapter_segments_${newChapterId}`;
  }
  return {
    ...revision,
    entityId,
    novelId: revision.novelId ? newNovelId : undefined,
    payloadHash: canonicalPayloadHash(nextPayload),
  };
}

function paragraphTextById(source: IdV2BookSource): Map<string, string> {
  const result = new Map<string, string>();
  for (const page of [
    ...values<Record<string, unknown>>(source, 'paragraph_pages'),
    ...values<Record<string, unknown>>(source, 'book_content_paragraph_pages'),
  ]) {
    const paragraphs = Array.isArray(page.paragraphs) ? page.paragraphs : [];
    paragraphs.forEach((paragraph) => {
      if (!paragraph || typeof paragraph !== 'object') return;
      const row = paragraph as Record<string, unknown>;
      if (typeof row.id === 'string' && typeof row.text === 'string' && !result.has(row.id)) {
        result.set(row.id, row.text);
      }
    });
  }
  return result;
}

export function addReferencePlan(input: {
  source: IdV2BookSource;
  newNovelId: string;
  registry: IdV2MappingRegistry;
  accumulator: IdV2PlanAccumulator;
}): void {
  const { source, newNovelId, registry, accumulator } = input;
  const readingPositions = values<ReadingPosition>(source, 'reading_positions');
  const bookmarks = values<Bookmark>(source, 'bookmarks');
  const highlights = values<ReaderHighlight>(source, 'highlights');
  const notes = values<ReaderNote>(source, 'notes');
  const characters = values<Character>(source, 'characters');
  const relations = values<CharacterRelation>(source, 'character_relations');
  const segments = values<LabeledSegment>(source, 'segments');
  const corrections = values<UserCorrection>(source, 'corrections');
  const voiceProfiles = values<VoiceProfile>(source, 'voice_profiles');
  const tombstones = values<Record<string, unknown>>(source, 'sync_tombstones');
  const outbox = values<SyncOutboxItem>(source, 'sync_outbox');

  readingPositions.forEach((row) => registry.add('reading_position', row.id, `reading_position_${newNovelId}`));
  addEntityMappings(bookmarks, 'bookmark', newNovelId, registry);
  addEntityMappings(highlights, 'highlight', newNovelId, registry);
  addEntityMappings(notes, 'note', newNovelId, registry);
  addEntityMappings(characters, 'character', newNovelId, registry);
  addEntityMappings(relations, 'character_relation', newNovelId, registry);
  addEntityMappings(segments, 'segment', newNovelId, registry);
  addEntityMappings(corrections, 'correction', newNovelId, registry);
  addEntityMappings(voiceProfiles, 'voice_profile', newNovelId, registry);
  outbox.forEach((item) => {
    registry.add('sync_event', item.event.id, migrationEntityId('sync_event', newNovelId, item.event.id));
    registry.add('sync_outbox', item.id, migrationEntityId('sync_outbox', newNovelId, item.id));
    const entityType = syncEventEntityType(item.event.type);
    if (entityType && item.event.entityId) {
      ensureMissingEntityMapping(registry, entityType, item.event.entityId, newNovelId);
    }
  });
  tombstones.forEach((row) => {
    const entityType = tombstoneEntityType(String(row.entityType ?? ''));
    const entityId = typeof row.entityId === 'string' ? row.entityId : '';
    if (entityType && entityId) ensureMissingEntityMapping(registry, entityType, entityId, newNovelId);
    const oldId = typeof row.id === 'string' ? row.id : `${row.entityType}:${entityId}`;
    const newEntityId = entityType && entityId ? registry.require(entityType, entityId) : entityId;
    registry.add('sync_tombstone', oldId, `${String(row.entityType)}:${newEntityId}`);
  });

  readingPositions.forEach((row) => {
    const next: ReadingPosition = {
      ...row,
      id: registry.require('reading_position', row.id),
      novelId: newNovelId,
      chapterId: registry.require('chapter', row.chapterId),
      paragraphId: remapOptional(registry, 'paragraph', row.paragraphId),
    };
    accumulator.target('reading_positions', next.id, next as unknown as Record<string, unknown>);
  });
  bookmarks.forEach((row) => {
    const next: Bookmark = {
      ...row,
      id: registry.require('bookmark', row.id),
      novelId: newNovelId,
      chapterId: registry.require('chapter', row.chapterId),
      paragraphId: remapOptional(registry, 'paragraph', row.paragraphId),
    };
    accumulator.target('bookmarks', next.id, next as unknown as Record<string, unknown>);
  });
  highlights.forEach((row) => {
    const next: ReaderHighlight = {
      ...row,
      id: registry.require('highlight', row.id),
      novelId: newNovelId,
      chapterId: registry.require('chapter', row.chapterId),
      paragraphId: registry.require('paragraph', row.paragraphId),
    };
    accumulator.target('highlights', next.id, next as unknown as Record<string, unknown>);
  });
  notes.forEach((row) => {
    const next: ReaderNote = {
      ...row,
      id: registry.require('note', row.id),
      novelId: newNovelId,
      chapterId: registry.require('chapter', row.chapterId),
      paragraphId: remapOptional(registry, 'paragraph', row.paragraphId),
    };
    accumulator.target('notes', next.id, next as unknown as Record<string, unknown>);
  });
  characters.forEach((row) => {
    const next: Character = { ...row, id: registry.require('character', row.id), novelId: newNovelId };
    accumulator.target('characters', next.id, next as unknown as Record<string, unknown>);
  });
  relations.forEach((row) => {
    const next: CharacterRelation = {
      ...row,
      id: registry.require('character_relation', row.id),
      novelId: newNovelId,
      sourceCharacterId: registry.require('character', row.sourceCharacterId),
      targetCharacterId: registry.require('character', row.targetCharacterId),
    };
    accumulator.target('character_relations', next.id, next as unknown as Record<string, unknown>);
  });
  voiceProfiles.forEach((row) => {
    const next: VoiceProfile = {
      ...row,
      id: registry.require('voice_profile', row.id),
      novelId: newNovelId,
      characterId: remapOptional(registry, 'character', row.characterId),
    };
    accumulator.target('voice_profiles', next.id, next as unknown as Record<string, unknown>);
  });

  const paragraphTexts = paragraphTextById(source);
  segments.forEach((row) => {
    const paragraphText = paragraphTexts.get(row.paragraphId);
    if (paragraphText === undefined || row.startOffset < 0 || row.endOffset > paragraphText.length) {
      throw new IdV2MigrationValidationError(
        'segment_source_missing',
        `Segment ${row.id} source text is unavailable`,
        'segment',
        row.id,
      );
    }
    const next: LabeledSegment = {
      ...row,
      id: registry.require('segment', row.id),
      novelId: newNovelId,
      chapterId: registry.require('chapter', row.chapterId),
      paragraphId: registry.require('paragraph', row.paragraphId),
      segmentTextHash: canonicalStoredHash(
        row.segmentTextHash,
        paragraphText.slice(row.startOffset, row.endOffset),
        `Segment ${row.id}`,
        'paragraph',
        row.paragraphId,
      ),
      speakerId: remapCharacter(registry, row.speakerId),
      candidateSpeakers: row.candidateSpeakers.map((id) => remapCharacter(registry, id)),
      listenerIds: row.listenerIds.map((id) => remapCharacter(registry, id)),
      voiceProfileId: remapOptional(registry, 'voice_profile', row.voiceProfileId),
    };
    accumulator.target('segments', next.id, next as unknown as Record<string, unknown>);
  });
  corrections.forEach((row) => {
    const next: UserCorrection = {
      ...row,
      id: registry.require('correction', row.id),
      novelId: newNovelId,
      chapterId: registry.require('chapter', row.chapterId),
      paragraphId: remapOptional(registry, 'paragraph', row.paragraphId),
      segmentId: remapOptional(registry, 'segment', row.segmentId),
      beforeJson: remapCorrectionJson(row.beforeJson, registry) as string | undefined,
      afterJson: remapCorrectionJson(row.afterJson, registry) as string,
    };
    accumulator.target('corrections', next.id, next as unknown as Record<string, unknown>);
  });

  tombstones.forEach((row) => {
    const entityType = tombstoneEntityType(String(row.entityType ?? ''));
    const oldEntityId = typeof row.entityId === 'string' ? row.entityId : '';
    const newEntityId = entityType && oldEntityId ? registry.require(entityType, oldEntityId) : oldEntityId;
    const oldId = typeof row.id === 'string' ? row.id : `${String(row.entityType)}:${oldEntityId}`;
    const key = registry.require('sync_tombstone', oldId);
    const next = {
      ...row,
      id: key,
      entityId: newEntityId,
      novelId: row.novelId ? newNovelId : undefined,
    };
    accumulator.target('sync_tombstones', key, next);
  });

  outbox.forEach((item) => {
    const payload = remapJsonIds(item.event.payload, registry);
    const event: SyncEvent = {
      ...item.event,
      id: registry.require('sync_event', item.event.id),
      novelId: item.event.novelId ? newNovelId : undefined,
      entityId: mapEventEntityId(item.event, registry, newNovelId),
      payload: payload as SyncEvent['payload'],
      revision: mapRevision(item.event.revision, registry, newNovelId, payload),
    };
    const next: SyncOutboxItem = {
      ...item,
      id: registry.require('sync_outbox', item.id),
      event,
      status: item.status === 'sending' ? 'pending' : item.status,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    };
    accumulator.target('sync_outbox', next.id, next as unknown as Record<string, unknown>);
  });
}
