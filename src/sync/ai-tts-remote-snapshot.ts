import type { Character, LabeledSegment, UserCorrection, VoiceProfile } from '../domain/types';
import type { CharacterGraph } from '../providers/ai';
import type { JsonValue } from './types';
import type { AiTtsSyncRemoteSnapshot } from './ai-tts-sync-diff';
import type { AiTtsSyncConflictGroup } from './sync-ui';

export interface AiTtsRemoteSnapshotClient {
  listVoiceProfiles(bookId: string): Promise<{ voiceProfiles: VoiceProfile[] }>;
  listCharacters(bookId: string): Promise<{ characters: Character[] }>;
  listCharacterGraph(bookId: string): Promise<{ graph: CharacterGraph }>;
  listSegments(chapterId: string): Promise<{ segments: LabeledSegment[] }>;
  listCorrections(bookId: string, input?: { chapterId?: string }): Promise<{ corrections: UserCorrection[] }>;
}

type JsonRecord = Record<string, JsonValue>;

function toJsonRecord(value: unknown): JsonRecord {
  const cloned = JSON.parse(JSON.stringify(value ?? {})) as unknown;
  return cloned && typeof cloned === 'object' && !Array.isArray(cloned)
    ? cloned as JsonRecord
    : {};
}

function payloadRecord(group: AiTtsSyncConflictGroup): JsonRecord {
  const payload = group.items[0]?.event.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as JsonRecord
    : {};
}

function payloadString(group: AiTtsSyncConflictGroup, key: string): string | undefined {
  const value = payloadRecord(group)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function correctionChapterId(group: AiTtsSyncConflictGroup): string | undefined {
  const correction = payloadRecord(group).correction;
  if (!correction || typeof correction !== 'object' || Array.isArray(correction)) return undefined;
  const value = correction.chapterId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function aiTtsRemoteSnapshotAvailable(group: AiTtsSyncConflictGroup): boolean {
  if (!group.novelId) return false;
  if (group.eventType === 'chapter_segments_updated') return Boolean(payloadString(group, 'chapterId'));
  return true;
}

export async function loadAiTtsRemoteSnapshot(
  client: AiTtsRemoteSnapshotClient,
  group: AiTtsSyncConflictGroup,
): Promise<AiTtsSyncRemoteSnapshot> {
  if (!group.novelId) throw new Error('AI/TTS sync group is missing a book id');

  if (group.eventType === 'voice_profiles_updated') {
    const { voiceProfiles } = await client.listVoiceProfiles(group.novelId);
    return { voiceProfiles: voiceProfiles.map(toJsonRecord) };
  }

  if (group.eventType === 'user_correction_created') {
    const { corrections } = await client.listCorrections(group.novelId, { chapterId: correctionChapterId(group) });
    return { corrections: corrections.map(toJsonRecord) };
  }

  if (group.eventType === 'user_correction_deleted') {
    const { corrections } = await client.listCorrections(group.novelId);
    return { corrections: corrections.filter((correction) => correction.id === group.entityId).map(toJsonRecord) };
  }

  if (group.eventType === 'character_graph_updated') {
    const { graph } = await client.listCharacterGraph(group.novelId);
    return {
      characters: graph.characters.map(toJsonRecord),
      relations: graph.relations.map(toJsonRecord),
    };
  }

  const chapterId = payloadString(group, 'chapterId');
  if (!chapterId) throw new Error('chapter_segments_updated group is missing a chapter id');
  const { segments } = await client.listSegments(chapterId);
  return { segments: segments.map(toJsonRecord) };
}
