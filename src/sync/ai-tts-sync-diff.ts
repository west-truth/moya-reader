import type { JsonValue, SyncEventType, SyncOutboxItem } from './types';
import { formatCount } from '../utils/format';

export type AiTtsSyncDiffEventType = Extract<
  SyncEventType,
  'voice_profiles_updated' | 'user_correction_created' | 'user_correction_deleted' | 'character_graph_updated' | 'chapter_segments_updated'
>;

type JsonRecord = Record<string, JsonValue>;

export interface AiTtsSyncRemoteSnapshot {
  voiceProfiles?: JsonRecord[];
  corrections?: JsonRecord[];
  characters?: JsonRecord[];
  relations?: JsonRecord[];
  segments?: JsonRecord[];
}

export interface AiTtsSyncSnapshotItem {
  id: string;
  label: string;
  fields: Record<string, string>;
}

export interface AiTtsSyncFieldDiff {
  itemId: string;
  itemLabel: string;
  field: string;
  localValue?: string;
  remoteValue?: string;
  changeType: 'added' | 'removed' | 'changed';
}

export interface AiTtsSyncSnapshotPreview {
  eventType: AiTtsSyncDiffEventType;
  entityId: string;
  novelId?: string;
  localCount: number;
  remoteCount?: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
  fieldDiffs: AiTtsSyncFieldDiff[];
  hasRemoteSnapshot: boolean;
  summary: string;
}

const eventLabels: Record<AiTtsSyncDiffEventType, string> = {
  voice_profiles_updated: '음성 프로필',
  user_correction_created: '라벨 교정',
  user_correction_deleted: '라벨 교정 삭제',
  character_graph_updated: '인물 그래프',
  chapter_segments_updated: '화자 라벨',
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arrayValue(value: JsonValue | undefined): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function booleanString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'boolean' ? String(value) : undefined;
}

function stableValue(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => stableValue(item) ?? '').sort());
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => [key, stableValue(entryValue as JsonValue)] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

function definedFields(fields: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string>;
}

function itemId(record: JsonRecord, fallback: string): string {
  return stringValue(record.id) ?? fallback;
}

function voiceProfileItem(record: JsonRecord, index: number): AiTtsSyncSnapshotItem {
  const id = itemId(record, `voice_profile_${index}`);
  return {
    id,
    label: stringValue(record.label) ?? id,
    fields: definedFields({
      role: stringValue(record.role),
      characterId: stringValue(record.characterId),
      providerId: stringValue(record.providerId),
      providerVoiceId: stringValue(record.providerVoiceId),
      providerModel: stringValue(record.providerModel),
      language: stringValue(record.language),
      tone: stringValue(record.tone),
      speed: numberString(record.speed),
      pitch: numberString(record.pitch),
      emotionPolicy: stringValue(record.emotionPolicy),
      isUserSelected: booleanString(record.isUserSelected),
      providerOptions: stableValue(record.providerOptions),
    }),
  };
}

function correctionItem(record: JsonRecord, index: number): AiTtsSyncSnapshotItem {
  const id = itemId(record, `correction_${index}`);
  return {
    id,
    label: `${stringValue(record.correctionType) ?? 'correction'} ${stringValue(record.segmentId) ?? stringValue(record.paragraphId) ?? id}`,
    fields: definedFields({
      chapterId: stringValue(record.chapterId),
      paragraphId: stringValue(record.paragraphId),
      segmentId: stringValue(record.segmentId),
      correctionType: stringValue(record.correctionType),
      beforeJson: stableValue(record.beforeJson),
      afterJson: stableValue(record.afterJson),
      applyScope: stringValue(record.applyScope),
      createdAt: stringValue(record.createdAt),
    }),
  };
}

function characterItem(record: JsonRecord, index: number): AiTtsSyncSnapshotItem {
  const rawId = itemId(record, `character_${index}`);
  return {
    id: `character:${rawId}`,
    label: stringValue(record.canonicalName) ?? rawId,
    fields: definedFields({
      canonicalName: stringValue(record.canonicalName),
      aliases: stableValue(record.aliases),
      color: stringValue(record.color),
      description: stringValue(record.description),
      confidence: numberString(record.confidence),
      isUserConfirmed: booleanString(record.isUserConfirmed),
    }),
  };
}

function relationItem(record: JsonRecord, index: number): AiTtsSyncSnapshotItem {
  const sourceId = stringValue(record.sourceCharacterId) ?? stringValue(record.sourceId) ?? stringValue(record.source_character_id) ?? stringValue(record.source_id) ?? '';
  const targetId = stringValue(record.targetCharacterId) ?? stringValue(record.targetId) ?? stringValue(record.target_character_id) ?? stringValue(record.target_id) ?? '';
  const relationType = stringValue(record.relationLabel) ?? stringValue(record.type) ?? stringValue(record.relationType) ?? stringValue(record.relation_label) ?? stringValue(record.relation_type) ?? 'relation';
  const derivedId = `${sourceId}:${relationType}:${targetId}`;
  const rawId = stringValue(record.id) ?? (derivedId.trim() ? derivedId : `relation_${index}`);
  return {
    id: `relation:${rawId}`,
    label: `${sourceId || '?'} ${relationType} ${targetId || '?'}`,
    fields: definedFields({
      sourceCharacterId: sourceId,
      targetCharacterId: targetId,
      relationLabel: relationType,
      termsUsedBySource: stableValue(record.termsUsedBySource) ?? stableValue(record.terms_used_by_source),
      termsUsedByTarget: stableValue(record.termsUsedByTarget) ?? stableValue(record.terms_used_by_target),
      description: stringValue(record.description),
      evidence: stableValue(record.evidence),
      confidence: numberString(record.confidence),
    }),
  };
}

function segmentItem(record: JsonRecord, index: number): AiTtsSyncSnapshotItem {
  const id = itemId(record, `segment_${index}`);
  return {
    id,
    label: `${stringValue(record.speakerId) ?? 'unknown'} #${numberString(record.segmentIndex) ?? index}`,
    fields: definedFields({
      chapterId: stringValue(record.chapterId),
      paragraphId: stringValue(record.paragraphId),
      segmentIndex: numberString(record.segmentIndex),
      startOffset: numberString(record.startOffset),
      endOffset: numberString(record.endOffset),
      segmentTextHash: stringValue(record.segmentTextHash),
      type: stringValue(record.type),
      speakerId: stringValue(record.speakerId),
      candidateSpeakers: stableValue(record.candidateSpeakers),
      listenerIds: stableValue(record.listenerIds),
      emotion: stringValue(record.emotion),
      confidence: numberString(record.confidence),
      voiceProfileId: stringValue(record.voiceProfileId),
      isUserCorrected: booleanString(record.isUserCorrected),
    }),
  };
}

function latestPayload(items: SyncOutboxItem[]): JsonRecord {
  const latest = [...items].sort((a, b) => b.localSequence - a.localSequence)[0];
  return isRecord(latest?.event.payload) ? latest.event.payload : {};
}

function localRecords(eventType: AiTtsSyncDiffEventType, items: SyncOutboxItem[]): JsonRecord[] {
  if (eventType === 'user_correction_created') {
    return items
      .map((item) => isRecord(item.event.payload) ? item.event.payload.correction : undefined)
      .filter(isRecord);
  }
  if (eventType === 'user_correction_deleted') return [];
  const payload = latestPayload(items);
  if (eventType === 'voice_profiles_updated') return arrayValue(payload.voiceProfiles);
  if (eventType === 'character_graph_updated') return [
    ...arrayValue(payload.characters),
    ...arrayValue(payload.relations),
  ];
  return arrayValue(payload.segments);
}

function remoteRecords(eventType: AiTtsSyncDiffEventType, remote?: AiTtsSyncRemoteSnapshot): JsonRecord[] | undefined {
  if (!remote) return undefined;
  if (eventType === 'voice_profiles_updated') return remote.voiceProfiles ?? [];
  if (eventType === 'user_correction_created' || eventType === 'user_correction_deleted') return remote.corrections ?? [];
  if (eventType === 'character_graph_updated') return [
    ...(remote.characters ?? []),
    ...(remote.relations ?? []),
  ];
  return remote.segments ?? [];
}

function normalizeItems(eventType: AiTtsSyncDiffEventType, records: JsonRecord[]): AiTtsSyncSnapshotItem[] {
  if (eventType === 'voice_profiles_updated') return records.map(voiceProfileItem);
  if (eventType === 'user_correction_created' || eventType === 'user_correction_deleted') return records.map(correctionItem);
  if (eventType === 'character_graph_updated') {
    return records.map((record, index) => {
      const hasRelationShape = stringValue(record.sourceCharacterId) ||
        stringValue(record.sourceId) ||
        stringValue(record.source_character_id) ||
        stringValue(record.source_id) ||
        stringValue(record.targetCharacterId) ||
        stringValue(record.targetId) ||
        stringValue(record.target_character_id) ||
        stringValue(record.target_id) ||
        stringValue(record.relationLabel) ||
        stringValue(record.relation_label);
      return hasRelationShape ? relationItem(record, index) : characterItem(record, index);
    });
  }
  return records.map(segmentItem);
}

function diffItems(
  localItems: AiTtsSyncSnapshotItem[],
  remoteItems: AiTtsSyncSnapshotItem[] | undefined,
  maxFieldDiffs: number,
): Pick<AiTtsSyncSnapshotPreview, 'addedCount' | 'removedCount' | 'changedCount' | 'unchangedCount' | 'fieldDiffs'> {
  if (!remoteItems) {
    return { addedCount: 0, removedCount: 0, changedCount: 0, unchangedCount: 0, fieldDiffs: [] };
  }

  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const fieldDiffs: AiTtsSyncFieldDiff[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;

  for (const localItem of localItems) {
    const remoteItem = remoteById.get(localItem.id);
    if (!remoteItem) {
      addedCount += 1;
      if (fieldDiffs.length < maxFieldDiffs) {
        fieldDiffs.push({ itemId: localItem.id, itemLabel: localItem.label, field: 'item', localValue: localItem.label, changeType: 'added' });
      }
      continue;
    }

    let itemChanged = false;
    const fieldNames = Array.from(new Set([...Object.keys(localItem.fields), ...Object.keys(remoteItem.fields)])).sort();
    for (const field of fieldNames) {
      const localValue = localItem.fields[field];
      const remoteValue = remoteItem.fields[field];
      if (localValue === remoteValue) continue;
      itemChanged = true;
      if (fieldDiffs.length < maxFieldDiffs) {
        fieldDiffs.push({ itemId: localItem.id, itemLabel: localItem.label, field, localValue, remoteValue, changeType: 'changed' });
      }
    }
    if (itemChanged) changedCount += 1;
    else unchangedCount += 1;
  }

  for (const remoteItem of remoteItems) {
    if (localById.has(remoteItem.id)) continue;
    removedCount += 1;
    if (fieldDiffs.length < maxFieldDiffs) {
      fieldDiffs.push({ itemId: remoteItem.id, itemLabel: remoteItem.label, field: 'item', remoteValue: remoteItem.label, changeType: 'removed' });
    }
  }

  return { addedCount, removedCount, changedCount, unchangedCount, fieldDiffs };
}

function previewSummary(input: {
  eventType: AiTtsSyncDiffEventType;
  localCount: number;
  remoteCount?: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
}): string {
  const label = eventLabels[input.eventType];
  if (input.remoteCount === undefined) {
    return `${label} 로컬 snapshot ${formatCount(input.localCount)}개가 대기 중입니다. 서버 snapshot이 연결되면 field diff를 표시합니다.`;
  }
  return `${label} 비교: 로컬 ${formatCount(input.localCount)}개, 서버 ${formatCount(input.remoteCount)}개, 추가 ${formatCount(input.addedCount)}개, 변경 ${formatCount(input.changedCount)}개, 삭제 후보 ${formatCount(input.removedCount)}개, 동일 ${formatCount(input.unchangedCount)}개.`;
}

export function buildAiTtsSyncSnapshotPreview(input: {
  eventType: AiTtsSyncDiffEventType;
  entityId: string;
  novelId?: string;
  items: SyncOutboxItem[];
  remoteSnapshot?: AiTtsSyncRemoteSnapshot;
  maxFieldDiffs?: number;
}): AiTtsSyncSnapshotPreview {
  const localItems = normalizeItems(input.eventType, localRecords(input.eventType, input.items));
  const remoteRaw = remoteRecords(input.eventType, input.remoteSnapshot);
  const remoteItems = remoteRaw ? normalizeItems(input.eventType, remoteRaw) : undefined;
  const diff = diffItems(localItems, remoteItems, input.maxFieldDiffs ?? 8);
  return {
    eventType: input.eventType,
    entityId: input.entityId,
    novelId: input.novelId,
    localCount: localItems.length,
    remoteCount: remoteItems?.length,
    hasRemoteSnapshot: Boolean(remoteItems),
    ...diff,
    summary: previewSummary({
      eventType: input.eventType,
      localCount: localItems.length,
      remoteCount: remoteItems?.length,
      ...diff,
    }),
  };
}
