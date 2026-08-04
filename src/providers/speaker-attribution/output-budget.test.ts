import { describe, expect, it } from 'vitest';
import { estimateSpeakerOutputBudget } from './output-budget';

describe('speaker output budget', () => {
  it.each([1, 5, 20, 40])('keeps a %i-span request inside the visible-output guard', (targetSpanCount) => {
    const budget = estimateSpeakerOutputBudget({
      targetSpanCount,
      ambiguousEstimate: Math.ceil(targetSpanCount / 4),
      totalAlternativeCandidateEstimate: targetSpanCount,
      newMentionEstimate: Math.ceil(targetSpanCount / 5),
      reasoningP99: 128,
    });

    expect(budget.decision).toBe('accepted');
    expect(budget.requestedOutputCap).toBeLessThanOrEqual(budget.guardLimit);
    expect(budget.requestedOutputCap).toBeLessThanOrEqual(4_096);
  });

  it('rejects a provider cap that cannot hold the visible response and reserve', () => {
    expect(
      estimateSpeakerOutputBudget({ targetSpanCount: 40, ambiguousEstimate: 40, modelMaxOutputTokens: 256 }),
    ).toMatchObject({
      decision: 'rejected',
      requestedOutputCap: 256,
      reason: 'model_cap_below_visible_reserve',
    });
  });

  it('does not truncate an explicit reasoning reserve with the visible-output guard', () => {
    const budget = estimateSpeakerOutputBudget({
      targetSpanCount: 12,
      ambiguousEstimate: 12,
      totalAlternativeCandidateEstimate: 24,
      reasoningP99: 1_536,
    });

    expect(budget.requestedOutputCap).toBe(
      budget.visibleOutputEstimate + budget.reasoningReserve + budget.structuralReserve,
    );
    expect(budget.guardLimit).toBeGreaterThanOrEqual(budget.requestedOutputCap);
  });

  it('rejects invalid counts before provider dispatch', () => {
    expect(() => estimateSpeakerOutputBudget({ targetSpanCount: 0 })).toThrow('at least 1');
    expect(() => estimateSpeakerOutputBudget({ targetSpanCount: 5, ambiguousEstimate: -1 })).toThrow(
      'non-negative integer',
    );
  });
});
