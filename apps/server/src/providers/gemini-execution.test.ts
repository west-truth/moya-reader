import { describe, expect, it } from 'vitest';
import {
  ProviderOutputIncompleteError,
  providerPartialOutputFromError,
} from '../../../../src/providers/provider-execution';
import { resolveLLMGenerationPolicy } from '../../../../src/providers/provider-generation-policy';
import { estimateSpeakerOutputBudget } from '../../../../src/providers/speaker-attribution/output-budget';
import { geminiStructuredJsonResult } from './gemini-execution.js';

describe('Gemini execution metadata', () => {
  it('returns sanitized finish and usage metadata for complete JSON output', () => {
    const result = geminiStructuredJsonResult({
      providerId: 'gemini-ai-studio',
      requestedModelId: 'gemini-flash',
      prompt: 'label',
      schemaVersion: 'chapter-labeling-result-v1',
      responseSchema: { type: 'OBJECT' },
      response: {
        responseId: 'gemini_request_1',
        modelVersion: 'gemini-flash-2026-07-11',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
      },
      text: '{"ok":true}',
      latencyMs: 12,
    });

    expect(result.executionMetadata).toMatchObject({
      providerId: 'gemini-ai-studio',
      finishReason: 'STOP',
      inputTokens: 7,
      outputTokens: 5,
      reasoningTokens: 2,
      latencyMs: 12,
    });
  });

  it.each(['MAX_TOKENS', 'SAFETY'])('rejects %s before JSON parsing', (finishReason) => {
    expect(() =>
      geminiStructuredJsonResult({
        providerId: 'gemini-vertex',
        requestedModelId: 'gemini-flash',
        prompt: 'label',
        responseSchema: { type: 'OBJECT' },
        response: { candidates: [{ finishReason }] },
        text: '{"partial":true',
        latencyMs: 4,
      }),
    ).toThrow('Provider output was incomplete');
  });

  it('records bounded diagnostics for a five-span truncated request without retaining source text', () => {
    const budget = estimateSpeakerOutputBudget({ targetSpanCount: 5, ambiguousEstimate: 2, reasoningP99: 64 });
    const generationPolicy = resolveLLMGenerationPolicy({
      providerId: 'gemini-ai-studio',
      modelId: 'gemini-3.1-flash-lite',
      taskKind: 'speaker_attribution',
      requestedOutputCap: budget.requestedOutputCap,
      visibleOutputEstimate: budget.visibleOutputEstimate,
    });
    const partial = `${'{"s":1,"q":0,"c":[1,2],"r":[]},'.repeat(60)}`;

    let error: unknown;
    try {
      geminiStructuredJsonResult({
        providerId: 'gemini-ai-studio',
        requestedModelId: 'gemini-3.1-flash-lite',
        prompt: 'private five-span source',
        responseSchema: { type: 'OBJECT' },
        response: {
          candidates: [{ finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500, thoughtsTokenCount: 12 },
        },
        text: partial,
        latencyMs: 8,
        generationPolicy,
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ProviderOutputIncompleteError);
    const metadata = (error as ProviderOutputIncompleteError).executionMetadata;
    expect(metadata).toMatchObject({
      generationPolicyId: generationPolicy.id,
      requestedOutputCap: budget.requestedOutputCap,
      visibleOutputEstimate: budget.visibleOutputEstimate,
      reasoningTokens: 12,
      failureClass: 'decoding_loop',
    });
    expect(metadata.repetitionScore).toBeGreaterThan(0.45);
    expect(JSON.stringify(metadata)).not.toContain('private five-span source');
    expect(JSON.stringify(metadata)).not.toContain(partial.slice(0, 30));
    expect(providerPartialOutputFromError(error)).toBe(partial);
  });
});
