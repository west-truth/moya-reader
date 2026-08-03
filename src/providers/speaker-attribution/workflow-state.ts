import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { DialogueSequenceDecisionV1 } from './contracts';

export interface SpeakerSequenceDecisionRecordV1 {
  readonly version: 'speaker-sequence-decision-record-v1';
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly packetFingerprint: string;
  readonly decision: DialogueSequenceDecisionV1;
  readonly fingerprint: string;
}

export function createSpeakerSequenceDecisionRecord(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly packetFingerprint: string;
  readonly decision: DialogueSequenceDecisionV1;
}): SpeakerSequenceDecisionRecordV1 {
  const core = { version: 'speaker-sequence-decision-record-v1' as const, ...input };
  return { ...core, id: input.decision.id, fingerprint: structuredIntegrityHash(core) };
}
