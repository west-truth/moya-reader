import { describe, expect, it } from 'vitest';
import { planSpeakerPacketBatches } from './packet-planner';

function candidates(entries: Readonly<Record<string, readonly string[]>>) {
  return entries;
}

describe('speaker packet planner', () => {
  it('covers every target exactly once in source order while applying the target budget', () => {
    const targetIds = Array.from({ length: 22 }, (_, index) => `span_${index}`);
    const units = planSpeakerPacketBatches({
      bursts: targetIds.map((spanId, index) => ({ id: `burst_${index}`, spanIds: [spanId] })),
      providerTargetSpanIds: new Set(targetIds),
      selectedCandidateIdsBySpan: candidates(
        Object.fromEntries(targetIds.map((spanId) => [spanId, ['speaker_a', 'speaker_b']])),
      ),
      maxTargets: 5,
      candidateHardCap: 24,
    });

    expect(units.map((unit) => unit.targetSpanIds.length)).toEqual([5, 5, 5, 5, 2]);
    expect(units.flatMap((unit) => unit.targetSpanIds)).toEqual(targetIds);
    expect(new Set(units.flatMap((unit) => unit.targetSpanIds))).toHaveLength(22);
    expect(units.slice(0, -1).every((unit) => unit.splitReason === 'target_budget')).toBe(true);
  });

  it('splits before a burst that would add a twenty-fifth candidate without losing targets', () => {
    const firstCandidates = Array.from({ length: 24 }, (_, index) => `speaker_${index}`);
    const units = planSpeakerPacketBatches({
      bursts: [
        { id: 'burst_1', spanIds: ['span_1'] },
        { id: 'burst_2', spanIds: ['span_2'] },
      ],
      providerTargetSpanIds: new Set(['span_1', 'span_2']),
      selectedCandidateIdsBySpan: candidates({
        span_1: firstCandidates,
        span_2: ['speaker_24'],
      }),
      maxTargets: 40,
      candidateHardCap: 24,
    });

    expect(units.map((unit) => unit.targetSpanIds)).toEqual([['span_1'], ['span_2']]);
    expect(units[0]?.splitReason).toBe('candidate_hard_cap');
  });

  it('rejects an indivisible burst that already exceeds a hard limit', () => {
    expect(() =>
      planSpeakerPacketBatches({
        bursts: [{ id: 'burst_1', spanIds: ['span_1', 'span_2'] }],
        providerTargetSpanIds: new Set(['span_1', 'span_2']),
        selectedCandidateIdsBySpan: candidates({ span_1: ['a'], span_2: ['b'] }),
        maxTargets: 1,
        candidateHardCap: 24,
      }),
    ).toThrow(/burst exceeds target budget/);
  });

  it('rejects duplicate target coverage across bursts', () => {
    expect(() =>
      planSpeakerPacketBatches({
        bursts: [
          { id: 'burst_1', spanIds: ['span_1'] },
          { id: 'burst_2', spanIds: ['span_1'] },
        ],
        providerTargetSpanIds: new Set(['span_1']),
        selectedCandidateIdsBySpan: candidates({ span_1: ['speaker_a'] }),
        maxTargets: 40,
        candidateHardCap: 24,
      }),
    ).toThrow(/multiple bursts/);
  });

  it('rejects a provider target that is absent from every burst', () => {
    expect(() =>
      planSpeakerPacketBatches({
        bursts: [{ id: 'burst_1', spanIds: ['span_1'] }],
        providerTargetSpanIds: new Set(['span_1', 'span_2']),
        selectedCandidateIdsBySpan: candidates({ span_1: ['speaker_a'], span_2: ['speaker_b'] }),
        maxTargets: 40,
        candidateHardCap: 24,
      }),
    ).toThrow(/missing from dialogue bursts.*span_2/);
  });
});
