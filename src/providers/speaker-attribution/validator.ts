import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import {
  SpeakerOrdinal,
  SpeakerReviewBits,
  type SceneSpeakerPacketV3,
  type SpeakerWireV2,
  type SpeakerWireValidationIssueV1,
  type ValidatedSpeakerWireV2,
} from './contracts';
import { CandidateEvidenceBits } from './evidence-miner';

export function repairSafeSpeakerWireV2Structure(packet: SceneSpeakerPacketV3, wire: SpeakerWireV2): SpeakerWireV2 {
  if (wire.u.length !== wire.c.length || wire.u.length !== wire.r.length) return wire;
  const allowedMentionsByTarget = new Map(packet.newMentionOrdinalsByTarget);
  const newEntityMappings = wire.x.filter(([targetPosition, mentionOrdinal]) =>
    (allowedMentionsByTarget.get(targetPosition) ?? []).includes(mentionOrdinal),
  );
  const mappedNewEntityTargets = new Set(newEntityMappings.map(([targetPosition]) => targetPosition));
  const speakers = [...wire.s];
  const downgradedTargets = new Set<number>();
  const downgradedNewEntityTargets = new Set<number>();
  speakers.forEach((speaker, targetPosition) => {
    const allowed = new Set([
      SpeakerOrdinal.unknown,
      ...(mappedNewEntityTargets.has(targetPosition) ? [SpeakerOrdinal.newFromMention] : []),
      ...(packet.targets[targetPosition]?.[4] ?? []),
    ]);
    if (!allowed.has(speaker)) {
      speakers[targetPosition] = SpeakerOrdinal.unknown;
      downgradedTargets.add(targetPosition);
      if (speaker === SpeakerOrdinal.newFromMention) downgradedNewEntityTargets.add(targetPosition);
    }
  });

  const reviewOrder: number[] = [];
  const reviewByTarget = new Map<number, { alternatives: number[]; bits: number }>();
  wire.u.forEach((targetPosition, index) => {
    const allowed = new Set([
      SpeakerOrdinal.unknown,
      ...(mappedNewEntityTargets.has(targetPosition) ? [SpeakerOrdinal.newFromMention] : []),
      ...(packet.targets[targetPosition]?.[4] ?? []),
    ]);
    const alternatives = (wire.c[index] ?? []).filter((ordinal) => allowed.has(ordinal));
    const existing = reviewByTarget.get(targetPosition);
    if (!existing) reviewOrder.push(targetPosition);
    const combined = [...new Set([...(existing?.alternatives ?? []), ...alternatives])].slice(0, 3);
    reviewByTarget.set(targetPosition, {
      alternatives: combined.length > 0 ? combined : [SpeakerOrdinal.unknown],
      bits: (existing?.bits ?? 0) | (wire.r[index] ?? 0),
    });
  });
  downgradedTargets.forEach((targetPosition) => {
    const existing = reviewByTarget.get(targetPosition);
    if (!existing) reviewOrder.push(targetPosition);
    reviewByTarget.set(targetPosition, {
      alternatives: existing?.alternatives.length ? existing.alternatives : [SpeakerOrdinal.unknown],
      bits:
        (existing?.bits ?? 0) |
        SpeakerReviewBits.unknownSpeaker |
        (downgradedNewEntityTargets.has(targetPosition) ? SpeakerReviewBits.newEntity : 0),
    });
  });
  return {
    ...wire,
    s: speakers,
    u: reviewOrder,
    c: reviewOrder.map((targetPosition) => reviewByTarget.get(targetPosition)!.alternatives),
    r: reviewOrder.map((targetPosition) => reviewByTarget.get(targetPosition)!.bits),
    x: newEntityMappings,
  };
}

function uniqueIntegers(values: readonly number[]): boolean {
  return new Set(values).size === values.length;
}

export function validateSpeakerWireV2(packet: SceneSpeakerPacketV3, wire: SpeakerWireV2): ValidatedSpeakerWireV2 {
  const issues: SpeakerWireValidationIssueV1[] = [];
  const error = (code: string, detail: string, targetPosition?: number) =>
    issues.push({ severity: 'error', code, detail, targetPosition });
  const review = (code: string, detail: string, targetPosition?: number) =>
    issues.push({ severity: 'review', code, detail, targetPosition });
  const targetCount = packet.targets.length;
  if (wire.f !== packet.fingerprint) error('fingerprint_mismatch', 'Response fingerprint does not match request');
  for (const [field, values] of [
    ['s', wire.s],
    ['q', wire.q],
    ['e', wire.e],
  ] as const) {
    if (values.length !== targetCount)
      error('target_count_mismatch', `${field} must contain exactly ${targetCount} items`);
  }
  if (wire.u.length !== wire.c.length || wire.u.length !== wire.r.length) {
    error('sparse_alignment_mismatch', 'u, c, and r must have the same length');
  }
  if (wire.u.length > targetCount || wire.x.length > targetCount) {
    error('sparse_budget_exceeded', 'Sparse arrays cannot exceed target count');
  }
  if (!uniqueIntegers(wire.u)) error('duplicate_review_target', 'u target positions must be unique');
  const reviewPositionSet = new Set(wire.u);
  const newMentionByTarget = new Map(packet.newMentionOrdinalsByTarget);
  const firstEvidenceSpanByCandidate = new Map(
    packet.candidateSourceAnchors.map(([ordinal, , , , , , spanIndex]) => [ordinal, spanIndex]),
  );
  const newEntityTargetSet = new Set(wire.x.map(([targetPosition]) => targetPosition));
  const newEntityAlternativeTargetSet = new Set(
    wire.u.filter((_, index) => wire.c[index]?.includes(SpeakerOrdinal.newFromMention)),
  );
  if (newEntityTargetSet.size !== wire.x.length)
    error('duplicate_new_entity_target', 'x target positions must be unique');

  for (let position = 0; position < targetCount; position += 1) {
    const target = packet.targets[position];
    const speaker = wire.s[position];
    const confidence = wire.q[position];
    const evidence = wire.e[position];
    if (!target || speaker === undefined || confidence === undefined || evidence === undefined) continue;
    const allowedCandidates = new Set(target[4]);
    target[4].forEach((candidateOrdinal, candidateIndex) => {
      const firstEvidenceSpanIndex = firstEvidenceSpanByCandidate.get(candidateOrdinal);
      const candidateEvidence = target[5][candidateIndex] ?? 0;
      if (
        firstEvidenceSpanIndex !== undefined &&
        firstEvidenceSpanIndex > target[0] &&
        !(candidateEvidence & CandidateEvidenceBits.adjacentSpeechAttribution)
      ) {
        error(
          'candidate_before_first_evidence',
          `Candidate ordinal ${candidateOrdinal} first appears after the target`,
          position,
        );
      }
    });
    const allowed =
      speaker === SpeakerOrdinal.unknown || speaker === SpeakerOrdinal.newFromMention || allowedCandidates.has(speaker);
    if (!allowed)
      error('ungrounded_speaker_ordinal', `Speaker ordinal ${speaker} is not grounded for target`, position);
    if (confidence < 0 || confidence > 1_000) error('confidence_out_of_range', 'q must be in 0..1000', position);
    if (evidence < 0 || evidence > 65_535) error('evidence_bits_out_of_range', 'e must be in 0..65535', position);
    if (
      (speaker === SpeakerOrdinal.newFromMention || newEntityAlternativeTargetSet.has(position)) &&
      !newEntityTargetSet.has(position)
    ) {
      error('new_entity_mapping_missing', 's=3 and NEW_FROM_MENTION alternatives require an x mapping', position);
    }
    if (confidence < 650 && !reviewPositionSet.has(position)) {
      review('low_confidence_not_routed', 'Confidence below 650 should be routed to review', position);
    }
    if (speaker === SpeakerOrdinal.unknown && !reviewPositionSet.has(position)) {
      review('unknown_not_routed', 'Unknown speaker should be routed to review', position);
    }
  }
  wire.x.forEach(([targetPosition, mentionOrdinal]) => {
    if (targetPosition < 0 || targetPosition >= targetCount) {
      error('new_entity_target_out_of_range', 'x target position is outside the packet', targetPosition);
      return;
    }
    if (!(newMentionByTarget.get(targetPosition) ?? []).includes(mentionOrdinal)) {
      error('ungrounded_new_entity_mention', 'x mention is not source-grounded for the target', targetPosition);
    }
  });
  wire.u.forEach((targetPosition, sparseIndex) => {
    if (targetPosition < 0 || targetPosition >= targetCount) {
      error('review_target_out_of_range', 'u target position is outside the packet', targetPosition);
      return;
    }
    const alternatives = wire.c[sparseIndex] ?? [];
    const reviewBits = wire.r[sparseIndex] ?? 0;
    if (alternatives.length < 1 || alternatives.length > 3 || !uniqueIntegers(alternatives)) {
      error('invalid_alternatives', 'Each c row needs 1..3 unique ordinals', targetPosition);
    }
    const allowed = new Set([
      SpeakerOrdinal.unknown,
      ...(newMentionByTarget.has(targetPosition) ? [SpeakerOrdinal.newFromMention] : []),
      ...(packet.targets[targetPosition]?.[4] ?? []),
    ]);
    if (alternatives.some((ordinal) => !allowed.has(ordinal))) {
      error('ungrounded_alternative', 'Alternative speaker ordinal is not grounded for target', targetPosition);
    }
    if (reviewBits < 0 || reviewBits > 65_535) {
      error('review_bits_out_of_range', 'r must be in 0..65535', targetPosition);
    }
    if ((wire.q[targetPosition] ?? 1_000) < 650 && !(reviewBits & SpeakerReviewBits.lowConfidence)) {
      review(
        'low_confidence_review_bit_missing',
        'Low-confidence review row should set lowConfidence bit',
        targetPosition,
      );
    }
    if (wire.s[targetPosition] === SpeakerOrdinal.unknown && !(reviewBits & SpeakerReviewBits.unknownSpeaker)) {
      review('unknown_review_bit_missing', 'Unknown speaker review row should set unknownSpeaker bit', targetPosition);
    }
  });
  const hardErrors = issues.filter((issue) => issue.severity === 'error');
  if (hardErrors.length > 0) {
    throw new Error(`SpeakerWireV2 semantic validation failed: ${hardErrors.map((issue) => issue.code).join(', ')}`);
  }
  const reviewTargetPositions = [
    ...new Set([
      ...wire.u,
      ...issues.flatMap((issue) =>
        issue.severity === 'review' && issue.targetPosition !== undefined ? [issue.targetPosition] : [],
      ),
    ]),
  ].sort((left, right) => left - right);
  const core = { wire, issues, reviewTargetPositions, packetFingerprint: packet.fingerprint };
  return { wire, issues, reviewTargetPositions, fingerprint: structuredIntegrityHash(core) };
}
