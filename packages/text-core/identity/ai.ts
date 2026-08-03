import { persistentId128 } from '../id-hash-contract';
import { structuredIntegrityHash, textIntegrityHash } from './structured-integrity';

export const RESERVED_SPEAKER_IDS = ['narrator', 'system', 'unknown'] as const;
export type ReservedSpeakerId = (typeof RESERVED_SPEAKER_IDS)[number];

export function isReservedSpeakerId(value: string): value is ReservedSpeakerId {
  return RESERVED_SPEAKER_IDS.includes(value as ReservedSpeakerId);
}

export function labeledSegmentId(input: {
  novelId: string;
  chapterId: string;
  paragraphId: string;
  startOffset: number;
  endOffset: number;
  segmentTextHash: string;
}): string {
  return persistentId128('segment', [
    input.novelId,
    input.chapterId,
    input.paragraphId,
    String(input.startOffset),
    String(input.endOffset),
    input.segmentTextHash,
  ]);
}

export function segmentTextIntegrityHash(text: string): string {
  return textIntegrityHash(text);
}

export function candidateCharacterId(novelId: string, bundleId: string, temporaryId: string): string {
  return persistentId128('candidate_character', [novelId, bundleId, temporaryId]);
}

export function characterAnalysisBundleId(novelId: string, chapterIds: readonly string[]): string {
  return persistentId128('character_bundle', [novelId, 'chapters', ...chapterIds]);
}

export function providerJobCharacterBundleId(novelId: string, providerJobId: string): string {
  return persistentId128('character_bundle', [novelId, 'provider_job', providerJobId]);
}

export function workflowCharacterBundleId(novelId: string, workflowId: string): string {
  return persistentId128('character_bundle', [novelId, 'workflow', workflowId]);
}

export function candidateRelationId(input: {
  novelId: string;
  bundleId: string;
  sourceCharacterId: string;
  targetCharacterId: string;
  relationLabel: string;
}): string {
  return persistentId128('candidate_relation', [
    input.novelId,
    input.bundleId,
    input.sourceCharacterId,
    input.targetCharacterId,
    input.relationLabel.trim().toLowerCase(),
  ]);
}

export function characterRelationId(input: {
  novelId: string;
  sourceCharacterId: string;
  targetCharacterId: string;
  relationLabel: string;
}): string {
  return persistentId128('character_relation', [
    input.novelId,
    input.sourceCharacterId,
    input.targetCharacterId,
    input.relationLabel.trim().toLowerCase(),
  ]);
}

export function characterAliasId(novelId: string, characterId: string, alias: string): string {
  return persistentId128('character_alias', [novelId, characterId, alias.normalize('NFKC').trim().toLowerCase()]);
}

export function chapterContextId(novelId: string, chapterId: string): string {
  return persistentId128('chapter_context', [novelId, chapterId]);
}

export function voiceProfileId(input: {
  novelId: string;
  role: string;
  characterId?: string;
  providerId: string;
}): string {
  return persistentId128('voice_profile', [
    input.novelId,
    input.role,
    input.characterId ?? 'default',
    input.providerId,
  ]);
}

export function userCorrectionId(input: {
  novelId: string;
  segmentId: string;
  field: string;
  createdAt: string;
}): string {
  return persistentId128('correction', [input.novelId, input.segmentId, input.field, input.createdAt]);
}

export function analysisOutputIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function segmentCollectionIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function characterGraphIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function correctionCollectionIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function analysisRunId(input: {
  novelId: string;
  providerJobId: string;
  inputHash: string;
  outputHash: string;
}): string {
  return persistentId128('analysis_run', [input.novelId, input.providerJobId, input.inputHash, input.outputHash]);
}
