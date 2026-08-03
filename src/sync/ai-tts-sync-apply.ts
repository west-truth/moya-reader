import { aggregateSyncEntityId, syncEventId } from '../domain/identity/sync-identities';
import { SYNC_CONTRACT_V2 } from './contract';
import { canonicalizeV2PayloadHashes } from './event-contract-validation';
import type { JsonValue, SyncEvent } from './types';
import type { AiTtsSyncFieldDiff, AiTtsSyncRemoteSnapshot } from './ai-tts-sync-diff';
import type { AiTtsSyncConflictGroup } from './sync-ui';

type JsonRecord = Record<string, JsonValue>;

export type AiTtsRemoteSnapshotApplyEventType =
  'voice_profiles_updated' | 'character_graph_updated' | 'chapter_segments_updated';

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return null;
}

function recordString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arrayValue(value: JsonValue | undefined): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function latestGroupPayload(group: AiTtsSyncConflictGroup): JsonRecord {
  const latest = [...group.items].sort((a, b) => b.localSequence - a.localSequence)[0];
  return isRecord(latest?.event.payload) ? latest.event.payload : {};
}

function groupPayload(group: AiTtsSyncConflictGroup): JsonRecord | undefined {
  const payload = group.items[0]?.event.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as JsonRecord) : undefined;
}

function groupPayloadString(group: AiTtsSyncConflictGroup, key: string): string | undefined {
  return recordString(groupPayload(group), key);
}

function eventForGroup(
  group: AiTtsSyncConflictGroup,
  type: AiTtsRemoteSnapshotApplyEventType,
  payload: JsonValue,
  now: string,
  entityId = group.entityId,
): SyncEvent {
  const canonicalPayload = canonicalizeV2PayloadHashes(payload);
  const chapterId = isRecord(canonicalPayload) ? recordString(canonicalPayload, 'chapterId') : undefined;
  const canonicalEntityId = group.novelId
    ? aggregateSyncEntityId({
        entityType:
          type === 'voice_profiles_updated'
            ? 'voice_profiles'
            : type === 'character_graph_updated'
              ? 'character_graph'
              : 'chapter_segments',
        novelId: group.novelId,
        chapterId,
      })
    : entityId;
  return {
    id: syncEventId({
      userId: 'local',
      deviceId: 'server_snapshot_resolution',
      type,
      novelId: group.novelId,
      entityId: canonicalEntityId,
      seed: `remote_snapshot_apply:${now}`,
    }),
    ...SYNC_CONTRACT_V2,
    type,
    deviceId: 'server_snapshot_resolution',
    novelId: group.novelId,
    entityId: canonicalEntityId,
    payload: canonicalPayload,
    createdAt: now,
  };
}

export function aiTtsRemoteSnapshotApplyAvailable(
  group: AiTtsSyncConflictGroup,
): group is AiTtsSyncConflictGroup & { eventType: AiTtsRemoteSnapshotApplyEventType } {
  return (
    group.eventType === 'voice_profiles_updated' ||
    group.eventType === 'character_graph_updated' ||
    group.eventType === 'chapter_segments_updated'
  );
}

export function aiTtsFieldDiffKey(diff: Pick<AiTtsSyncFieldDiff, 'itemId' | 'field'>): string {
  return JSON.stringify([diff.itemId, diff.field]);
}

function selectedDiffHas(selectedLocalDiffKeys: Set<string>, itemId: string, field: string): boolean {
  return selectedLocalDiffKeys.has(aiTtsFieldDiffKey({ itemId, field }));
}

function cloneRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, jsonValue(value)])) as JsonRecord;
}

function voiceProfileItemId(record: JsonRecord, index: number): string {
  return recordString(record, 'id') ?? `voice_profile_${index}`;
}

function characterItemId(record: JsonRecord, index: number): string {
  return `character:${recordString(record, 'id') ?? `character_${index}`}`;
}

function relationItemId(record: JsonRecord, index: number): string {
  const sourceId =
    recordString(record, 'sourceCharacterId') ??
    recordString(record, 'sourceId') ??
    recordString(record, 'source_character_id') ??
    recordString(record, 'source_id') ??
    '';
  const targetId =
    recordString(record, 'targetCharacterId') ??
    recordString(record, 'targetId') ??
    recordString(record, 'target_character_id') ??
    recordString(record, 'target_id') ??
    '';
  const relationType =
    recordString(record, 'relationLabel') ??
    recordString(record, 'type') ??
    recordString(record, 'relationType') ??
    recordString(record, 'relation_label') ??
    recordString(record, 'relation_type') ??
    'relation';
  const derivedId = `${sourceId}:${relationType}:${targetId}`;
  return `relation:${recordString(record, 'id') ?? (derivedId.trim() ? derivedId : `relation_${index}`)}`;
}

function isRelationRecord(record: JsonRecord): boolean {
  return Boolean(
    recordString(record, 'sourceCharacterId') ||
    recordString(record, 'sourceId') ||
    recordString(record, 'source_character_id') ||
    recordString(record, 'source_id') ||
    recordString(record, 'targetCharacterId') ||
    recordString(record, 'targetId') ||
    recordString(record, 'target_character_id') ||
    recordString(record, 'target_id') ||
    recordString(record, 'relationLabel') ||
    recordString(record, 'relation_label'),
  );
}

function graphItemId(record: JsonRecord, index: number): string {
  return isRelationRecord(record) ? relationItemId(record, index) : characterItemId(record, index);
}

function segmentItemId(record: JsonRecord, index: number): string {
  return recordString(record, 'id') ?? `segment_${index}`;
}

function localSnapshotRecords(
  group: AiTtsSyncConflictGroup,
  eventType: AiTtsRemoteSnapshotApplyEventType,
): { voiceProfiles?: JsonRecord[]; characters?: JsonRecord[]; relations?: JsonRecord[]; segments?: JsonRecord[] } {
  const payload = latestGroupPayload(group);
  if (eventType === 'voice_profiles_updated') return { voiceProfiles: arrayValue(payload.voiceProfiles) };
  if (eventType === 'character_graph_updated') {
    return {
      characters: arrayValue(payload.characters),
      relations: arrayValue(payload.relations),
    };
  }
  return { segments: arrayValue(payload.segments) };
}

function mergeRecordCollection(
  remoteRecords: JsonRecord[],
  localRecords: JsonRecord[],
  itemIdForRecord: (record: JsonRecord, index: number) => string,
  selectedLocalDiffKeys: Set<string>,
): JsonRecord[] {
  const localById = new Map(localRecords.map((record, index) => [itemIdForRecord(record, index), record] as const));
  const remoteIds = new Set<string>();
  const merged: JsonRecord[] = [];

  remoteRecords.forEach((remoteRecord, index) => {
    const itemId = itemIdForRecord(remoteRecord, index);
    remoteIds.add(itemId);
    const localRecord = localById.get(itemId);
    if (!localRecord) {
      if (!selectedDiffHas(selectedLocalDiffKeys, itemId, 'item')) merged.push(cloneRecord(remoteRecord));
      return;
    }

    const next = cloneRecord(remoteRecord);
    const fieldNames = Array.from(new Set([...Object.keys(remoteRecord), ...Object.keys(localRecord)])).sort();
    for (const field of fieldNames) {
      if (!selectedDiffHas(selectedLocalDiffKeys, itemId, field)) continue;
      if (Object.prototype.hasOwnProperty.call(localRecord, field)) {
        next[field] = jsonValue(localRecord[field]);
      } else {
        delete next[field];
      }
    }
    merged.push(next);
  });

  localRecords.forEach((localRecord, index) => {
    const itemId = itemIdForRecord(localRecord, index);
    if (remoteIds.has(itemId) || !selectedDiffHas(selectedLocalDiffKeys, itemId, 'item')) return;
    merged.push(cloneRecord(localRecord));
  });

  return merged;
}

export function buildAiTtsMergedSnapshotFromSelections(
  group: AiTtsSyncConflictGroup,
  remoteSnapshot: AiTtsSyncRemoteSnapshot,
  selectedLocalDiffKeys: Iterable<string>,
): AiTtsSyncRemoteSnapshot {
  if (!aiTtsRemoteSnapshotApplyAvailable(group)) {
    throw new Error(`AI/TTS selected field merge is not supported for ${group.eventType}`);
  }
  if (!group.novelId) throw new Error('AI/TTS sync group is missing a book id');

  const selected = new Set(selectedLocalDiffKeys);
  const local = localSnapshotRecords(group, group.eventType);

  if (group.eventType === 'voice_profiles_updated') {
    if (!remoteSnapshot.voiceProfiles) throw new Error('Remote voice profile snapshot is not loaded');
    return {
      voiceProfiles: mergeRecordCollection(
        remoteSnapshot.voiceProfiles,
        local.voiceProfiles ?? [],
        voiceProfileItemId,
        selected,
      ),
    };
  }

  if (group.eventType === 'character_graph_updated') {
    if (!remoteSnapshot.characters || !remoteSnapshot.relations)
      throw new Error('Remote Character Graph snapshot is not loaded');
    return {
      characters: mergeRecordCollection(remoteSnapshot.characters, local.characters ?? [], graphItemId, selected),
      relations: mergeRecordCollection(remoteSnapshot.relations, local.relations ?? [], graphItemId, selected),
    };
  }

  if (!remoteSnapshot.segments) throw new Error('Remote chapter segment snapshot is not loaded');
  return {
    segments: mergeRecordCollection(remoteSnapshot.segments, local.segments ?? [], segmentItemId, selected),
  };
}

export function buildAiTtsRemoteSnapshotApplyEvents(
  group: AiTtsSyncConflictGroup,
  remoteSnapshot: AiTtsSyncRemoteSnapshot,
  now = new Date().toISOString(),
): SyncEvent[] {
  if (!aiTtsRemoteSnapshotApplyAvailable(group)) {
    throw new Error(`AI/TTS remote snapshot apply is not supported for ${group.eventType}`);
  }
  if (!group.novelId) throw new Error('AI/TTS sync group is missing a book id');

  if (group.eventType === 'voice_profiles_updated') {
    if (!remoteSnapshot.voiceProfiles) throw new Error('Remote voice profile snapshot is not loaded');
    return [eventForGroup(group, group.eventType, jsonValue({ voiceProfiles: remoteSnapshot.voiceProfiles }), now)];
  }

  if (group.eventType === 'character_graph_updated') {
    if (!remoteSnapshot.characters || !remoteSnapshot.relations)
      throw new Error('Remote Character Graph snapshot is not loaded');
    return [
      eventForGroup(
        group,
        group.eventType,
        jsonValue({
          mode: 'replace',
          characters: remoteSnapshot.characters,
          relations: remoteSnapshot.relations,
        }),
        now,
      ),
    ];
  }

  if (!remoteSnapshot.segments) throw new Error('Remote chapter segment snapshot is not loaded');
  const chapterId = groupPayloadString(group, 'chapterId') ?? recordString(remoteSnapshot.segments[0], 'chapterId');
  if (!chapterId) throw new Error('Remote chapter segment snapshot is missing a chapter id');
  return [
    eventForGroup(
      group,
      group.eventType,
      jsonValue({
        chapterId,
        segments: remoteSnapshot.segments,
      }),
      now,
      `chapter_segments_${chapterId}`,
    ),
  ];
}
