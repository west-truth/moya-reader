import type { Character, LabeledSegment, SegmentType, UserCorrection, VoiceProfile } from '@noveldesk/contracts';
import type { CharacterRelation } from '../../../../../src/providers/ai';
import { isoString } from './database-row-contract.js';

export function mapCharacter(row: Record<string, unknown>): Character {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    canonicalName: String(row.canonical_name),
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter((alias): alias is string => typeof alias === 'string')
      : [],
    color: String(row.color),
    description: typeof row.description === 'string' ? row.description : undefined,
    confidence: Number(row.confidence),
    isUserConfirmed: Boolean(row.is_user_confirmed),
  };
}

export function stringArrayFromRow(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function mapCharacterRelation(row: Record<string, unknown>): CharacterRelation {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    sourceCharacterId: String(row.source_character_id),
    targetCharacterId: String(row.target_character_id),
    relationLabel: String(row.relation_label),
    termsUsedBySource: stringArrayFromRow(row.terms_used_by_source),
    termsUsedByTarget: stringArrayFromRow(row.terms_used_by_target),
    confidence: Number(row.confidence),
    evidence: stringArrayFromRow(row.evidence),
  };
}

export function mapSegment(row: Record<string, unknown>): LabeledSegment {
  const prosody = row.prosody_intent;
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    chapterId: String(row.chapter_id),
    paragraphId: String(row.paragraph_id),
    segmentIndex: Number(row.segment_index),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    segmentTextHash: String(row.segment_text_hash),
    type: String(row.segment_type) as SegmentType,
    speakerId: String(row.speaker_id),
    candidateSpeakers: Array.isArray(row.candidate_speakers)
      ? row.candidate_speakers.filter((speaker): speaker is string => typeof speaker === 'string')
      : [],
    listenerIds: Array.isArray(row.listener_ids)
      ? row.listener_ids.filter((listener): listener is string => typeof listener === 'string')
      : [],
    emotion: String(row.emotion),
    prosodyIntent:
      prosody && typeof prosody === 'object' && !Array.isArray(prosody)
        ? {
            pace:
              typeof (prosody as Record<string, unknown>).pace === 'string'
                ? String((prosody as Record<string, unknown>).pace)
                : undefined,
            intensity:
              typeof (prosody as Record<string, unknown>).intensity === 'string'
                ? String((prosody as Record<string, unknown>).intensity)
                : undefined,
            delivery:
              typeof (prosody as Record<string, unknown>).delivery === 'string'
                ? String((prosody as Record<string, unknown>).delivery)
                : undefined,
          }
        : undefined,
    confidence: Number(row.confidence),
    evidence: typeof row.evidence === 'string' ? row.evidence : undefined,
    voiceProfileId: typeof row.voice_profile_id === 'string' ? row.voice_profile_id : undefined,
    isUserCorrected: Boolean(row.is_user_corrected),
  };
}

export function mapCorrection(row: Record<string, unknown>): UserCorrection {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    chapterId: typeof row.chapter_id === 'string' ? row.chapter_id : '',
    paragraphId: typeof row.paragraph_id === 'string' ? row.paragraph_id : undefined,
    segmentId: typeof row.segment_id === 'string' ? row.segment_id : undefined,
    correctionType: String(row.correction_type) as UserCorrection['correctionType'],
    beforeJson: row.before_json === null || row.before_json === undefined ? undefined : JSON.stringify(row.before_json),
    afterJson: JSON.stringify(row.after_json) ?? '{}',
    applyScope: String(row.apply_scope) as UserCorrection['applyScope'],
    operationId: typeof row.operation_id === 'string' ? row.operation_id : undefined,
    intentKind: typeof row.intent_kind === 'string' ? (row.intent_kind as UserCorrection['intentKind']) : undefined,
    intentJson: row.intent_json === null || row.intent_json === undefined ? undefined : JSON.stringify(row.intent_json),
    provenanceKind:
      row.provenance_kind === 'user_label_mutation' || row.provenance_kind === 'review_approved_generated'
        ? row.provenance_kind
        : undefined,
    sourceReviewArtifactId:
      typeof row.source_review_artifact_id === 'string' ? row.source_review_artifact_id : undefined,
    createdAt: String(row.created_at),
  };
}

export function mapVoiceProfile(row: Record<string, unknown>): VoiceProfile {
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  return {
    id: String(row.id),
    novelId: String(row.book_id),
    characterId: typeof row.character_id === 'string' ? row.character_id : undefined,
    role: String(row.role) as VoiceProfile['role'],
    providerId: String(row.provider_id),
    providerVoiceId: String(row.provider_voice_id),
    providerModel: typeof row.provider_model === 'string' ? row.provider_model : undefined,
    label: String(row.label),
    language: typeof row.language === 'string' ? row.language : undefined,
    tone: typeof row.tone === 'string' ? row.tone : undefined,
    speed: Number(row.speed),
    pitch: row.pitch === null || row.pitch === undefined ? undefined : Number(row.pitch),
    emotionPolicy: typeof row.emotion_policy === 'string' ? row.emotion_policy : undefined,
    providerOptions:
      row.provider_options && typeof row.provider_options === 'object' && !Array.isArray(row.provider_options)
        ? (row.provider_options as Record<string, unknown>)
        : {},
    isUserSelected: Boolean(row.is_user_selected),
    createdAt: typeof createdAt === 'string' || createdAt instanceof Date ? isoString(createdAt) : undefined,
    updatedAt: typeof updatedAt === 'string' || updatedAt instanceof Date ? isoString(updatedAt) : undefined,
  };
}
