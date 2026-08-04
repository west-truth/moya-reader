import { describe, expect, it } from 'vitest';
import { sanitizeProviderJobProgress } from '../../apps/server/src/routes/ai/provider-job-contract';
import {
  attachProviderExecutionMetadata,
  normalizeProviderExecutionMetadata,
  providerExecutionMetadataFromError,
} from '../providers/provider-execution';

describe('provider execution metadata boundary', () => {
  it('keeps only documented bounded metadata fields', () => {
    const metadata = normalizeProviderExecutionMetadata({
      providerId: 'openai',
      requestedModelId: 'gpt-labeler',
      latencyMs: 14,
      retryCount: 0,
      finishReason: 'stop',
      inputTokens: 12,
      generationPolicyId: 'policy_1',
      generationPolicyHash: 'sha256:policy',
      requestedOutputCap: 1024,
      repetitionScore: 0.75,
      failureClass: 'decoding_loop',
      apiKey: 'sk-must-not-survive',
      rawOutput: 'private provider output',
      nested: { authorization: 'Bearer secret' },
    });

    expect(metadata).toEqual({
      providerId: 'openai',
      requestedModelId: 'gpt-labeler',
      latencyMs: 14,
      retryCount: 0,
      finishReason: 'stop',
      inputTokens: 12,
      generationPolicyId: 'policy_1',
      generationPolicyHash: 'sha256:policy',
      requestedOutputCap: 1024,
      repetitionScore: 0.75,
      failureClass: 'decoding_loop',
    });
  });

  it('drops unknown failure classes and out-of-range repetition scores', () => {
    expect(
      normalizeProviderExecutionMetadata({
        providerId: 'gemini-ai-studio',
        requestedModelId: 'gemini-3.1-flash-lite',
        latencyMs: 10,
        retryCount: 0,
        failureClass: 'provider raw error body',
        repetitionScore: 4,
      }),
    ).toEqual({
      providerId: 'gemini-ai-studio',
      requestedModelId: 'gemini-3.1-flash-lite',
      latencyMs: 10,
      retryCount: 0,
    });
  });

  it('sanitizes provider metadata independently when exposing job progress', () => {
    expect(
      sanitizeProviderJobProgress({
        providerExecution: {
          providerId: 'anthropic',
          requestedModelId: 'claude-labeler',
          latencyMs: 9,
          retryCount: 0,
          rawOutput: 'must not cross API boundary',
          authorization: 'Bearer secret',
        },
      }),
    ).toEqual({
      providerExecution: {
        providerId: 'anthropic',
        requestedModelId: 'claude-labeler',
        latencyMs: 9,
        retryCount: 0,
      },
    });
  });

  it('rejects malformed error metadata instead of returning the original object', () => {
    expect(
      providerExecutionMetadataFromError({
        executionMetadata: {
          providerId: 'openai',
          requestedModelId: 'gpt-labeler',
          latencyMs: Number.NaN,
          retryCount: 0,
          apiKey: 'secret',
        },
      }),
    ).toBeUndefined();
  });

  it('classifies response parsing and validation failures without retaining their payload', () => {
    const error = attachProviderExecutionMetadata(new SyntaxError('private response body'), {
      providerId: 'gemini-ai-studio',
      requestedModelId: 'gemini-3.1-flash-lite',
      latencyMs: 10,
      retryCount: 0,
    });

    expect(providerExecutionMetadataFromError(error)).toMatchObject({ failureClass: 'contract_invalid' });
    expect(JSON.stringify(providerExecutionMetadataFromError(error))).not.toContain('private response body');
  });
});
