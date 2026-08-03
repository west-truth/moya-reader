import { syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import type { BookEntityType } from './contracts.js';
import { AliasRegistry } from './alias-registry.js';
import { HashAliasRegistry } from './hash-alias-registry.js';

const singularHints: Readonly<Record<string, BookEntityType>> = {
  bookId: 'book',
  book_id: 'book',
  novelId: 'book',
  novel_id: 'book',
  objectId: 'object',
  object_id: 'object',
  chapterId: 'chapter',
  chapter_id: 'chapter',
  paragraphId: 'paragraph',
  paragraph_id: 'paragraph',
  pageId: 'page',
  page_id: 'page',
  bookmarkId: 'bookmark',
  highlightId: 'highlight',
  noteId: 'note',
  characterId: 'character',
  character_id: 'character',
  sourceCharacterId: 'character',
  source_character_id: 'character',
  targetCharacterId: 'character',
  target_character_id: 'character',
  speakerId: 'character',
  speaker_id: 'character',
  voiceProfileId: 'voice_profile',
  voice_profile_id: 'voice_profile',
  segmentId: 'labeled_segment',
  segment_id: 'labeled_segment',
  analysisRunId: 'analysis_run',
  analysis_run_id: 'analysis_run',
  workflowId: 'book_ai_workflow',
  workflow_id: 'book_ai_workflow',
  providerJobId: 'provider_job',
  provider_job_id: 'provider_job',
};

const arrayHints: Readonly<Record<string, BookEntityType>> = {
  bookIds: 'book',
  novelIds: 'book',
  chapterIds: 'chapter',
  chapter_ids: 'chapter',
  paragraphIds: 'paragraph',
  paragraph_ids: 'paragraph',
  characterIds: 'character',
  character_ids: 'character',
  activeCharacterIds: 'character',
  active_character_ids: 'character',
  candidateSpeakers: 'character',
  candidate_speakers: 'character',
  listenerIds: 'character',
  listener_ids: 'character',
  voiceProfileIds: 'voice_profile',
  segmentIds: 'labeled_segment',
  segment_ids: 'labeled_segment',
  providerJobIds: 'provider_job',
};

function remapString(
  value: string,
  hint: BookEntityType | undefined,
  aliases: AliasRegistry,
  hashes?: HashAliasRegistry,
): string {
  const identity = hint ? aliases.resolve(hint, value) : aliases.resolveUnique(value);
  return identity ?? hashes?.resolve(value) ?? value;
}

function remapValue(
  value: unknown,
  aliases: AliasRegistry,
  hashes?: HashAliasRegistry,
  hint?: BookEntityType,
  parentKey?: string,
): unknown {
  if (typeof value === 'string') return remapString(value, hint, aliases, hashes);
  if (Array.isArray(value)) {
    const itemHint = parentKey ? (arrayHints[parentKey] ?? hint) : hint;
    return value.map((item) => remapValue(item, aliases, hashes, itemHint));
  }
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childHint = singularHints[key] ?? arrayHints[key];
    const canonicalKey = remapString(key, undefined, aliases, hashes);
    result[canonicalKey] = remapValue(child, aliases, hashes, childHint, key);
  }
  return result;
}

export function remapNestedJson<T>(value: T, aliases: AliasRegistry, hashes?: HashAliasRegistry): T {
  return remapValue(value, aliases, hashes) as T;
}

export function remapSyncRevision(
  revision: unknown,
  payload: unknown,
  aliases: AliasRegistry,
  hashes?: HashAliasRegistry,
): Record<string, unknown> | null {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) return null;
  const remapped = remapNestedJson(revision as Record<string, unknown>, aliases, hashes);
  remapped.payloadHash = syncPayloadIntegrityHash(payload);
  return remapped;
}
