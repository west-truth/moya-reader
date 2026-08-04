import { describe, expect, it } from 'vitest';
import { classifySpeakerFailure, withProviderOutputDiagnostics } from './failure-classifier';
import { analyzeRepetitionEvidence } from './repetition-evidence';

describe('speaker provider failure evidence', () => {
  it('detects repeated structured output without retaining source text', () => {
    const row = '{"s":1,"q":0,"c":[1,2],"r":[]}';
    const evidence = analyzeRepetitionEvidence(`[${Array.from({ length: 80 }, () => row).join(',')}]`);

    expect(evidence.repetitionScore).toBeGreaterThan(0.45);
    expect(evidence.partialOutputHash).toMatch(/^(?:sha256|v2):/);
    expect(evidence).not.toHaveProperty('text');
  });

  it('separates decoding loops, thinking overruns, and ordinary truncation', () => {
    expect(classifySpeakerFailure({ incompleteReason: 'MAX_TOKENS', repetitionScore: 0.8 })).toBe('decoding_loop');
    expect(
      classifySpeakerFailure({
        incompleteReason: 'length',
        repetitionScore: 0.1,
        requestedOutputCap: 1_000,
        reasoningTokens: 700,
        outputTokens: 100,
      }),
    ).toBe('thinking_overrun');
    expect(classifySpeakerFailure({ incompleteReason: 'MAX_TOKENS', repetitionScore: 0.1 })).toBe('genuine_truncation');
  });

  it('adds hashes and bounded diagnostics but never the prompt or partial output', () => {
    const metadata = withProviderOutputDiagnostics(
      {
        providerId: 'gemini-ai-studio',
        requestedModelId: 'gemini-3.1-flash-lite',
        incompleteReason: 'MAX_TOKENS',
        finishReason: 'MAX_TOKENS',
        outputTokens: 500,
        reasoningTokens: 20,
        latencyMs: 10,
        retryCount: 0,
      },
      { prompt: 'private novel text', text: '{"partial":true' },
    );

    expect(metadata.promptHash).toBeTruthy();
    expect(metadata.partialOutputHash).toBeTruthy();
    expect(metadata.failureClass).toBe('genuine_truncation');
    expect(JSON.stringify(metadata)).not.toContain('private novel text');
    expect(JSON.stringify(metadata)).not.toContain('{"partial":true');
  });
});
