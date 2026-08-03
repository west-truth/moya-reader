import { structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
  SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { CandidateMemoryViewV2 } from './candidate-memory';
import type { CandidateSelectionDecisionV1 } from './candidate-selector';
import { CandidateEvidenceBits } from './evidence-miner';
import type { SourceMentionInventoryV1 } from './mention-inventory';

export const DETERMINISTIC_SPEAKER_SIEVE_VERSION = 'deterministic-speaker-sieve-v2' as const;

export interface SpeakerRuleCalibrationV1 {
  readonly ruleId: 'speech_verb_subject';
  readonly sampleSize: number;
  readonly precisionLowerBound: number;
  readonly fingerprint: string;
}

export interface DeterministicSpeakerDecisionV1 {
  readonly spanId: string;
  readonly spanIndex: number;
  readonly outcome: 'accepted' | 'provider_target' | 'boundary_review' | 'window_split';
  readonly speakerEntityId?: string;
  readonly evidenceBits: number;
  readonly confidence: number;
  readonly ruleCode: string;
  readonly candidateEntityIds: readonly string[];
  readonly fingerprint: string;
}

export interface DeterministicSpeakerSieveResultV1 {
  readonly version: typeof DETERMINISTIC_SPEAKER_SIEVE_VERSION;
  readonly decisions: readonly DeterministicSpeakerDecisionV1[];
  readonly acceptedSpanIds: readonly string[];
  readonly providerTargetSpanIds: readonly string[];
  readonly boundaryReviewSpanIds: readonly string[];
  readonly windowSplitSpanIds: readonly string[];
  readonly calibrationFingerprint: string;
  readonly fingerprint: string;
}

function materializeSpan(span: SpeakerSpanV1, paragraphById: ReadonlyMap<string, SpeakerSourceParagraphInput>): string {
  const paragraph = paragraphById.get(span.paragraphId);
  if (!paragraph) throw new Error(`Speaker span ${span.id} has no source paragraph`);
  const text = paragraph.text.slice(span.startOffset, span.endOffset);
  if (textIntegrityHash(text) !== span.textHash) throw new Error(`Speaker span ${span.id} source hash is stale`);
  return text;
}

function calibratedSpeechSubject(input: {
  readonly span: SpeakerSpanV1;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly memory?: CandidateMemoryViewV2;
  readonly calibration?: SpeakerRuleCalibrationV1;
}): { readonly entityId: string; readonly precision: number } | undefined {
  const calibration = input.calibration;
  if (!calibration || calibration.sampleSize < 200 || calibration.precisionLowerBound < 0.995) return undefined;
  const mentions = input.mentionInventory.mentions.filter(
    (mention) =>
      mention.spanId === input.span.id && mention.extractionCode === 'speech_verb_subject' && mention.characterId,
  );
  const entityIds = [
    ...new Set(
      mentions.flatMap(
        (mention) =>
          input.memory?.entities
            .filter((entity) => entity.characterId === mention.characterId)
            .map((entity) => entity.entityId) ?? [],
      ),
    ),
  ];
  return entityIds.length === 1 ? { entityId: entityIds[0]!, precision: calibration.precisionLowerBound } : undefined;
}

export function runDeterministicSpeakerSieve(input: {
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly candidateSelections: Readonly<Record<string, CandidateSelectionDecisionV1>>;
  readonly candidateMemories: Readonly<Record<string, CandidateMemoryViewV2>>;
  readonly lockedSpeakerEntityIdByCorrectionId?: Readonly<Record<string, string>>;
  readonly speechSubjectCalibration?: SpeakerRuleCalibrationV1;
}): DeterministicSpeakerSieveResultV1 {
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  const decisions = input.spanInventory.spans.map((span): DeterministicSpeakerDecisionV1 => {
    materializeSpan(span, paragraphById);
    const selection = input.candidateSelections[span.id];
    const accepted = (
      speakerEntityId: string,
      evidenceBits: number,
      confidence: number,
      ruleCode: string,
    ): DeterministicSpeakerDecisionV1 => {
      const core = {
        spanId: span.id,
        spanIndex: span.spanIndex,
        outcome: 'accepted' as const,
        speakerEntityId,
        evidenceBits,
        confidence,
        ruleCode,
        candidateEntityIds: selection?.selectedEntityIds ?? [],
      };
      return { ...core, fingerprint: structuredIntegrityHash(core) };
    };
    if (span.deterministicSpeaker) return accepted(span.deterministicSpeaker, 0, 1, 'source_deterministic');
    if (span.lockedCorrectionId) {
      const speaker = input.lockedSpeakerEntityIdByCorrectionId?.[span.lockedCorrectionId];
      if (speaker) return accepted(speaker, CandidateEvidenceBits.userCorrection, 1, 'user_lock');
    }
    if (span.boundaryReview) {
      const core = {
        spanId: span.id,
        spanIndex: span.spanIndex,
        outcome: 'boundary_review' as const,
        evidenceBits: 0,
        confidence: 0,
        ruleCode: 'boundary_review_required',
        candidateEntityIds: selection?.selectedEntityIds ?? [],
      };
      return { ...core, fingerprint: structuredIntegrityHash(core) };
    }
    if (selection?.requiresWindowSplit) {
      const core = {
        spanId: span.id,
        spanIndex: span.spanIndex,
        outcome: 'window_split' as const,
        evidenceBits: 0,
        confidence: 0,
        ruleCode: 'candidate_hard_cap_exceeded',
        candidateEntityIds: selection.hardIncludeEntityIds,
      };
      return { ...core, fingerprint: structuredIntegrityHash(core) };
    }
    if (!selection || selection.candidateSufficiency === 'insufficient') {
      const core = {
        spanId: span.id,
        spanIndex: span.spanIndex,
        outcome: 'boundary_review' as const,
        evidenceBits: 0,
        confidence: 0,
        ruleCode: 'candidate_insufficient',
        candidateEntityIds: selection?.selectedEntityIds ?? [],
      };
      return { ...core, fingerprint: structuredIntegrityHash(core) };
    }
    const explicitSender = selection?.evidence.filter((evidence) =>
      evidence.hardReasons.includes('explicit_message_sender'),
    );
    if (span.type === 'message' && explicitSender?.length === 1) {
      return accepted(explicitSender[0]!.entityId, explicitSender[0]!.bits, 0.999, 'explicit_message_sender');
    }
    const correction = selection?.evidence.filter((evidence) => evidence.hardReasons.includes('user_correction'));
    if (correction?.length === 1) {
      return accepted(correction[0]!.entityId, correction[0]!.bits, 1, 'user_correction_evidence');
    }
    const speechSubject = calibratedSpeechSubject({
      span,
      mentionInventory: input.mentionInventory,
      memory: input.candidateMemories[span.sceneId],
      calibration: input.speechSubjectCalibration,
    });
    if (speechSubject) {
      return accepted(
        speechSubject.entityId,
        CandidateEvidenceBits.exactMention,
        speechSubject.precision,
        'calibrated_speech_subject',
      );
    }
    const core = {
      spanId: span.id,
      spanIndex: span.spanIndex,
      outcome: 'provider_target' as const,
      evidenceBits: 0,
      confidence: 0,
      ruleCode: selection?.issueCodes.includes('candidate_missing') ? 'candidate_missing' : 'provider_required',
      candidateEntityIds: selection?.selectedEntityIds ?? [],
    };
    return { ...core, fingerprint: structuredIntegrityHash(core) };
  });
  const calibrationFingerprint = input.speechSubjectCalibration?.fingerprint ?? 'disabled';
  const core = {
    version: DETERMINISTIC_SPEAKER_SIEVE_VERSION,
    decisions,
    acceptedSpanIds: decisions.filter((decision) => decision.outcome === 'accepted').map((decision) => decision.spanId),
    providerTargetSpanIds: decisions
      .filter((decision) => decision.outcome === 'provider_target')
      .map((decision) => decision.spanId),
    boundaryReviewSpanIds: decisions
      .filter((decision) => decision.outcome === 'boundary_review')
      .map((decision) => decision.spanId),
    windowSplitSpanIds: decisions
      .filter((decision) => decision.outcome === 'window_split')
      .map((decision) => decision.spanId),
    calibrationFingerprint,
  };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}
