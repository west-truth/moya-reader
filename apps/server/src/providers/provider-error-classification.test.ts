import { describe, expect, it } from 'vitest';
import { classifyProviderError } from './provider-error-classification.js';

describe('provider error classification', () => {
  it('classifies missing provider configuration without exposing raw details', () => {
    expect(classifyProviderError(new Error('OPENAI_API_KEY is required for openai provider'))).toMatchObject({
      category: 'missing_config',
      errorCode: 'provider_error_missing_config',
      retryable: false,
    });
  });

  it('classifies auth, quota, retryable, schema, and content-size failures', () => {
    expect(classifyProviderError(new Error('OpenAI request failed (401): token=secret'))).toMatchObject({
      category: 'auth',
    });
    expect(classifyProviderError(new Error('Provider quota exceeded for this project'))).toMatchObject({
      category: 'quota',
    });
    expect(classifyProviderError(new Error('Local TTS endpoint request failed with 503: retry later'))).toMatchObject({
      category: 'retryable_network',
      retryable: true,
    });
    expect(classifyProviderError(new Error('Chapter labeling validation failed: segment mismatch'))).toMatchObject({
      category: 'schema',
    });
    expect(
      classifyProviderError(new Error('Chapter labeling quality failed: unknown_speaker_ratio_high')),
    ).toMatchObject({ category: 'schema' });
    expect(classifyProviderError(new Error('TTS synthesis character budget exceeded: 2000 > 1000'))).toMatchObject({
      category: 'content_too_large',
    });
  });

  it('suppresses provider response text in safe messages', () => {
    const classified = classifyProviderError(new Error('request failed with 500: apiKey=secret audioBase64=abc'));

    expect(classified).toMatchObject({ category: 'retryable_network' });
    expect(classified.safeMessage).not.toMatch(/secret|audioBase64|abc/i);
  });
});
