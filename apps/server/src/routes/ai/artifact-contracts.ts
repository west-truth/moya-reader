import type { Character, LabeledSegment, SegmentType, UserCorrection, VoiceProfile } from '@noveldesk/contracts';
import type { CharacterRelation } from '../../../../../src/providers/ai';
import { hasSecretLikeKey } from '../../providers/server-provider-settings.js';
import {
  arrayOfStrings,
  booleanField,
  numberField,
  optionalStringField,
  recordBody,
  segmentTypes,
  stringField,
  validConfidence,
  validOffset,
  voiceProfileRoles,
} from './request-contracts.js';

export function validateCharacter(
  value: unknown,
  bookId: string,
): { ok: true; character: Character } | { ok: false; error: string } {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'character must be an object' };
  const id = stringField(body, 'id');
  const canonicalName = stringField(body, 'canonicalName');
  const aliases = arrayOfStrings(body.aliases);
  const color = stringField(body, 'color');
  const confidence = numberField(body, 'confidence');
  const isUserConfirmed = booleanField(body, 'isUserConfirmed');
  if (!id) return { ok: false, error: 'character.id is required' };
  if (!canonicalName) return { ok: false, error: 'character.canonicalName is required' };
  if (!aliases) return { ok: false, error: 'character.aliases must be a string array' };
  if (!color) return { ok: false, error: 'character.color is required' };
  if (!validConfidence(confidence)) return { ok: false, error: 'character.confidence must be between 0 and 1' };
  if (isUserConfirmed === undefined) return { ok: false, error: 'character.isUserConfirmed must be boolean' };
  return {
    ok: true,
    character: {
      id,
      novelId: bookId,
      canonicalName,
      aliases,
      color,
      description: optionalStringField(body, 'description'),
      confidence,
      isUserConfirmed,
    },
  };
}

export function validateCharacterRelation(
  value: unknown,
  bookId: string,
  characterIds: Set<string>,
): { ok: true; relation: CharacterRelation } | { ok: false; error: string } {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'relation must be an object' };
  const id = stringField(body, 'id');
  const sourceCharacterId = stringField(body, 'sourceCharacterId');
  const targetCharacterId = stringField(body, 'targetCharacterId');
  const relationLabel = stringField(body, 'relationLabel');
  const termsUsedBySource = arrayOfStrings(body.termsUsedBySource);
  const termsUsedByTarget = arrayOfStrings(body.termsUsedByTarget);
  const evidence = body.evidence === undefined ? [] : arrayOfStrings(body.evidence);
  const confidence = numberField(body, 'confidence');
  if (!id) return { ok: false, error: 'relation.id is required' };
  if (!sourceCharacterId || !characterIds.has(sourceCharacterId))
    return { ok: false, error: 'relation.sourceCharacterId is invalid' };
  if (!targetCharacterId || !characterIds.has(targetCharacterId))
    return { ok: false, error: 'relation.targetCharacterId is invalid' };
  if (!relationLabel) return { ok: false, error: 'relation.relationLabel is required' };
  if (!termsUsedBySource) return { ok: false, error: 'relation.termsUsedBySource must be a string array' };
  if (!termsUsedByTarget) return { ok: false, error: 'relation.termsUsedByTarget must be a string array' };
  if (!evidence) return { ok: false, error: 'relation.evidence must be a string array' };
  if (!validConfidence(confidence)) return { ok: false, error: 'relation.confidence must be between 0 and 1' };
  return {
    ok: true,
    relation: {
      id,
      novelId: bookId,
      sourceCharacterId,
      targetCharacterId,
      relationLabel,
      termsUsedBySource,
      termsUsedByTarget,
      confidence,
      evidence,
    },
  };
}

export function validateSegment(
  value: unknown,
  bookId: string,
  chapterId: string,
): { ok: true; segment: LabeledSegment } | { ok: false; error: string } {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'segment must be an object' };
  const id = stringField(body, 'id');
  const paragraphId = stringField(body, 'paragraphId');
  const segmentIndex = numberField(body, 'segmentIndex');
  const startOffset = numberField(body, 'startOffset');
  const endOffset = numberField(body, 'endOffset');
  const segmentTextHash = stringField(body, 'segmentTextHash');
  const type = stringField(body, 'type') as SegmentType | undefined;
  const speakerId = stringField(body, 'speakerId');
  const candidateSpeakers = arrayOfStrings(body.candidateSpeakers);
  const listenerIds = arrayOfStrings(body.listenerIds);
  const emotion = stringField(body, 'emotion') ?? 'neutral';
  const prosodyBody = recordBody(body.prosodyIntent);
  const prosodyIntent = prosodyBody
    ? {
        pace: optionalStringField(prosodyBody, 'pace'),
        intensity: optionalStringField(prosodyBody, 'intensity'),
        delivery: optionalStringField(prosodyBody, 'delivery'),
      }
    : undefined;
  const confidence = numberField(body, 'confidence');
  const isUserCorrected = booleanField(body, 'isUserCorrected');
  if (!id) return { ok: false, error: 'segment.id is required' };
  if (!paragraphId) return { ok: false, error: 'segment.paragraphId is required' };
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0)
    return { ok: false, error: 'segment.segmentIndex must be a non-negative integer' };
  if (!validOffset(startOffset) || !validOffset(endOffset) || startOffset >= endOffset) {
    return { ok: false, error: 'segment offsets are invalid' };
  }
  if (!segmentTextHash) return { ok: false, error: 'segment.segmentTextHash is required' };
  if (!type || !segmentTypes.includes(type)) return { ok: false, error: 'segment.type is invalid' };
  if (!speakerId) return { ok: false, error: 'segment.speakerId is required' };
  if (!candidateSpeakers) return { ok: false, error: 'segment.candidateSpeakers must be a string array' };
  if (!listenerIds) return { ok: false, error: 'segment.listenerIds must be a string array' };
  if (!validConfidence(confidence)) return { ok: false, error: 'segment.confidence must be between 0 and 1' };
  if (isUserCorrected === undefined) return { ok: false, error: 'segment.isUserCorrected must be boolean' };
  return {
    ok: true,
    segment: {
      id,
      novelId: bookId,
      chapterId,
      paragraphId,
      segmentIndex,
      startOffset,
      endOffset,
      segmentTextHash,
      type,
      speakerId,
      candidateSpeakers,
      listenerIds,
      emotion,
      prosodyIntent,
      confidence,
      evidence: optionalStringField(body, 'evidence'),
      voiceProfileId: optionalStringField(body, 'voiceProfileId'),
      isUserCorrected,
    },
  };
}

export function validateCorrection(
  value: unknown,
  bookId: string,
): { ok: true; correction: UserCorrection } | { ok: false; error: string } {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'correction must be an object' };
  const id = stringField(body, 'id');
  const correctionType = stringField(body, 'correctionType') as UserCorrection['correctionType'] | undefined;
  const chapterId = stringField(body, 'chapterId');
  const afterJson = stringField(body, 'afterJson');
  const applyScope = stringField(body, 'applyScope') as UserCorrection['applyScope'] | undefined;
  const createdAt = stringField(body, 'createdAt');
  if (!id) return { ok: false, error: 'correction.id is required' };
  if (!chapterId) return { ok: false, error: 'correction.chapterId is required' };
  if (
    !correctionType ||
    !['speaker', 'listener', 'emotion', 'prosody', 'segment_type', 'voice', 'note'].includes(correctionType)
  ) {
    return { ok: false, error: 'correction.correctionType is invalid' };
  }
  if (!afterJson) return { ok: false, error: 'correction.afterJson is required' };
  if (!applyScope || !['segment', 'chapter', 'future_pattern', 'global'].includes(applyScope)) {
    return { ok: false, error: 'correction.applyScope is invalid' };
  }
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    return { ok: false, error: 'correction.createdAt must be an ISO date string' };
  }
  return {
    ok: true,
    correction: {
      id,
      novelId: bookId,
      chapterId,
      paragraphId: optionalStringField(body, 'paragraphId'),
      segmentId: optionalStringField(body, 'segmentId'),
      correctionType,
      beforeJson: optionalStringField(body, 'beforeJson'),
      afterJson: afterJson ?? '{}',
      applyScope,
      operationId: optionalStringField(body, 'operationId'),
      intentKind: optionalStringField(body, 'intentKind') as UserCorrection['intentKind'],
      intentJson: optionalStringField(body, 'intentJson'),
      provenanceKind: optionalStringField(body, 'provenanceKind') as UserCorrection['provenanceKind'],
      sourceReviewArtifactId: optionalStringField(body, 'sourceReviewArtifactId'),
      createdAt,
    },
  };
}

export function validateVoiceProfile(
  value: unknown,
  bookId: string,
): { ok: true; voiceProfile: VoiceProfile } | { ok: false; error: string } {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'voiceProfile must be an object' };
  const id = stringField(body, 'id');
  const role = stringField(body, 'role') as VoiceProfile['role'] | undefined;
  const providerId = stringField(body, 'providerId');
  const providerVoiceId = stringField(body, 'providerVoiceId');
  const label = stringField(body, 'label');
  const speed = numberField(body, 'speed', 1);
  const pitch = numberField(body, 'pitch', Number.NaN);
  const isUserSelected = booleanField(body, 'isUserSelected');
  const providerOptions = recordBody(body.providerOptions) ?? {};
  if (!id) return { ok: false, error: 'voiceProfile.id is required' };
  if (!role || !voiceProfileRoles.includes(role)) return { ok: false, error: 'voiceProfile.role is invalid' };
  if (!providerId) return { ok: false, error: 'voiceProfile.providerId is required' };
  if (!providerVoiceId) return { ok: false, error: 'voiceProfile.providerVoiceId is required' };
  if (!label) return { ok: false, error: 'voiceProfile.label is required' };
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4)
    return { ok: false, error: 'voiceProfile.speed is invalid' };
  if (body.pitch !== undefined && body.pitch !== null && !Number.isFinite(pitch))
    return { ok: false, error: 'voiceProfile.pitch is invalid' };
  if (isUserSelected === undefined) return { ok: false, error: 'voiceProfile.isUserSelected must be boolean' };
  if (hasSecretLikeKey(providerOptions))
    return { ok: false, error: 'voiceProfile.providerOptions must not contain secret-like keys or values' };
  return {
    ok: true,
    voiceProfile: {
      id,
      novelId: bookId,
      characterId: optionalStringField(body, 'characterId'),
      role,
      providerId,
      providerVoiceId,
      providerModel: optionalStringField(body, 'providerModel'),
      label,
      language: optionalStringField(body, 'language'),
      tone: optionalStringField(body, 'tone'),
      speed,
      pitch: Number.isFinite(pitch) ? pitch : undefined,
      emotionPolicy: optionalStringField(body, 'emotionPolicy'),
      providerOptions,
      isUserSelected,
      createdAt: optionalStringField(body, 'createdAt'),
      updatedAt: optionalStringField(body, 'updatedAt'),
    },
  };
}
