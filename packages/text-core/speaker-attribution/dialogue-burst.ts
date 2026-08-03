import { persistentId128, structuredIntegrityHash } from '../hash';
import {
  DIALOGUE_BURST_INVENTORY_VERSION,
  type DialogueBurstInventoryV1,
  type DialogueBurstV1,
  type SpeakerSpanInventoryV1,
  type SpeakerSpanV1,
} from './contracts';

export const DEFAULT_DIALOGUE_BURST_DETECTOR_VERSION = 'dialogue-burst-detector-v1';

function alternationMode(participants: readonly string[]): DialogueBurstV1['alternationMode'] {
  if (participants.length === 2) return 'two_party_soft';
  if (participants.length >= 3) return 'multi_party';
  return 'none';
}

export function buildDialogueBurstInventory(input: {
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly participantCandidateIdsBySpan?: Readonly<Record<string, readonly string[]>>;
  readonly maxTargetSpans?: number;
  readonly candidateHardCap?: number;
  readonly detectorVersion?: string;
}): DialogueBurstInventoryV1 {
  const detectorVersion = input.detectorVersion ?? DEFAULT_DIALOGUE_BURST_DETECTOR_VERSION;
  const maxTargetSpans = Math.max(1, Math.floor(input.maxTargetSpans ?? 20));
  const candidateHardCap = Math.max(1, Math.floor(input.candidateHardCap ?? 24));
  const bursts: DialogueBurstV1[] = [];
  let active: SpeakerSpanV1[] = [];
  let activeParticipants = new Set<string>();

  const flush = (splitReason?: DialogueBurstV1['splitReason']) => {
    if (active.length === 0) return;
    const participantCandidateIds = [...activeParticipants].sort();
    const core = {
      bookId: input.spanInventory.bookId,
      contentRevisionId: input.spanInventory.contentRevisionId,
      chapterId: input.spanInventory.chapterId,
      sceneId: active[0]!.sceneId,
      burstIndex: bursts.length,
      spanIds: active.map((span) => span.id),
      targetSpanIndexes: active.map((span) => span.spanIndex),
      participantCandidateIds,
      alternationMode: alternationMode(participantCandidateIds),
      splitReason,
      detectorVersion,
    };
    const fingerprint = structuredIntegrityHash(core);
    bursts.push({
      ...core,
      id: persistentId128('dialogue_burst', [
        input.spanInventory.contentRevisionId,
        core.sceneId,
        core.spanIds[0]!,
        core.spanIds.at(-1)!,
        detectorVersion,
      ]),
      fingerprint,
    });
    active = [];
    activeParticipants = new Set<string>();
  };

  for (const span of input.spanInventory.spans) {
    if (!span.voiceBearing || span.deterministicSpeaker === 'narrator') {
      flush();
      continue;
    }
    if (active.length > 0 && active[0]!.sceneId !== span.sceneId) flush();
    const incomingParticipants = input.participantCandidateIdsBySpan?.[span.id] ?? [];
    const combinedParticipants = new Set([...activeParticipants, ...incomingParticipants]);
    if (active.length >= maxTargetSpans) flush('target_budget');
    else if (active.length > 0 && combinedParticipants.size > candidateHardCap) flush('candidate_hard_cap');
    active.push(span);
    for (const participant of incomingParticipants) activeParticipants.add(participant);
  }
  flush();

  const core = {
    version: DIALOGUE_BURST_INVENTORY_VERSION,
    bookId: input.spanInventory.bookId,
    contentRevisionId: input.spanInventory.contentRevisionId,
    chapterId: input.spanInventory.chapterId,
    detectorVersion,
    bursts,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('dialogue_burst_inventory', [
      input.spanInventory.contentRevisionId,
      input.spanInventory.chapterId,
      fingerprint,
    ]),
    fingerprint,
  };
}
