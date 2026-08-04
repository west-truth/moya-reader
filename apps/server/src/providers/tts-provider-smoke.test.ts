import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTTSProviderSmokeError, parseTTSProviderSmokeArgs, runTTSProviderSmoke } from './tts-provider-smoke.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TTS provider smoke runner', () => {
  it('uses the catalog-declared WAV format for Gemini TTS', async () => {
    const summary = await runTTSProviderSmoke({
      providerId: 'gemini-tts',
      modelId: 'gemini-3.1-flash-tts-preview',
      live: false,
      env: {
        TTS_PROVIDER_ENABLED: 'gemini-tts',
        GEMINI_API_KEY: 'configured-test-key',
        TTS_GEMINI_MODEL_ID: 'gemini-3.1-flash-tts-preview',
      },
    });

    expect(summary.sample.format).toBe('wav');
  });

  it('reports sanitized dry-run readiness without exposing TTS secrets or endpoints', async () => {
    const summary = await runTTSProviderSmoke({
      providerId: 'elevenlabs',
      modelId: 'eleven_flash_v2_5',
      live: false,
      env: {
        TTS_PROVIDER_ENABLED: 'elevenlabs',
        ELEVENLABS_API_KEY: 'secret-elevenlabs-key',
        TTS_ELEVENLABS_BASE_URL: 'https://example.invalid/tts?token=secret-url-token',
      },
      cwd: process.cwd(),
    });

    expect(summary).toMatchObject({
      providerId: 'elevenlabs',
      modelId: 'eleven_flash_v2_5',
      live: false,
      ready: {
        enabled: true,
        implemented: true,
        secretConfigured: true,
        modelConfigured: true,
        voiceConfigured: false,
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret-elevenlabs-key|secret-url-token|example\.invalid/i);
  });

  it('can run a live smoke against a local endpoint fetch stub without leaking audio or metadata values', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          audioBase64: Buffer.from('abc').toString('base64'),
          contentType: 'audio/mpeg',
          durationMs: 123,
          requestId: 'req_123',
          metadata: {
            engine: 'mock-engine',
            secretValue: 'hidden-metadata-value',
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const summary = await runTTSProviderSmoke({
      providerId: 'local-endpoint',
      modelId: 'local-smoke-model',
      voiceId: 'local-voice-a',
      text: 'Ping.',
      format: 'wav',
      speed: 1.15,
      pitch: -0.2,
      tone: 'warm narration',
      emotion: 'relieved',
      providerOptions: {
        style: 'calm',
        stability: 0.7,
      },
      live: true,
      env: {
        TTS_PROVIDER_ENABLED: 'local-endpoint',
        TTS_LOCAL_ENDPOINT_URL: 'http://127.0.0.1:9999/tts?token=secret-url-token',
      },
      fetchImpl,
      cwd: process.cwd(),
    });

    expect(summary.ready).toEqual({
      enabled: true,
      implemented: true,
      secretConfigured: true,
      modelConfigured: true,
      voiceConfigured: true,
    });
    expect(summary.result).toEqual({
      audioBytes: 3,
      contentType: 'audio/mpeg',
      durationMs: 123,
      providerRequestIdPresent: true,
      providerMetadataKeys: ['engine'],
    });
    expect(summary.sample).toMatchObject({
      format: 'wav',
      speed: 1.15,
      pitch: -0.2,
      tonePresent: true,
      emotionPresent: true,
      providerOptionKeys: ['stability', 'style'],
    });
    expect(JSON.stringify(summary)).not.toMatch(/abc|hidden-metadata-value|secret-url-token/i);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      modelId: 'local-smoke-model',
      text: 'Ping.',
      voiceId: 'local-voice-a',
      format: 'wav',
      speed: 1.15,
      tone: 'warm narration',
      emotion: 'relieved',
      providerOptions: {
        style: 'calm',
        stability: 0.7,
      },
      voiceProfile: expect.objectContaining({
        speed: 1.15,
        pitch: -0.2,
        providerOptions: {
          style: 'calm',
          stability: 0.7,
        },
      }),
    });
  });

  it('rejects secret-like TTS smoke options before live synthesis', async () => {
    await expect(
      runTTSProviderSmoke({
        providerId: 'local-endpoint',
        providerOptions: {
          apiKey: 'sk-proj-secretvalue',
        },
        live: true,
        env: {
          TTS_PROVIDER_ENABLED: 'local-endpoint',
          TTS_LOCAL_ENDPOINT_URL: 'http://127.0.0.1:9999/tts',
        },
        cwd: process.cwd(),
      }),
    ).rejects.toThrow('TTS smoke options must not contain secret-like keys or values');
  });

  it('parses TTS provider smoke CLI args', () => {
    expect(
      parseTTSProviderSmokeArgs([
        '--provider',
        'openai-tts',
        '--model=gpt-4o-mini-tts',
        '--voice',
        'alloy',
        '--format',
        'opus',
        '--text',
        'Hello smoke.',
        '--speed',
        '1.25',
        '--pitch=-0.1',
        '--tone',
        'warm',
        '--emotion=calm',
        '--option',
        'stability=0.7',
        '--provider-option',
        'style=soft',
        '--live',
        '--json',
        '--project',
        'project-test',
        '--location=us-central1',
      ]),
    ).toEqual({
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      voiceId: 'alloy',
      format: 'opus',
      text: 'Hello smoke.',
      speed: 1.25,
      pitch: -0.1,
      tone: 'warm',
      emotion: 'calm',
      providerOptions: {
        stability: 0.7,
        style: 'soft',
      },
      live: true,
      json: true,
      project: 'project-test',
      location: 'us-central1',
    });
  });

  it('keeps live smoke explicit even if a legacy env toggle is present', () => {
    vi.stubEnv('TTS_PROVIDER_SMOKE_LIVE', '1');

    expect(parseTTSProviderSmokeArgs(['--provider', 'local-endpoint']).live).toBe(false);
  });

  it('suppresses provider failure details that may contain secrets', () => {
    expect(
      formatTTSProviderSmokeError(
        new Error('Local TTS endpoint request failed with 500: token=secret-url-token audioBase64=abc'),
      ),
    ).toBe(
      'TTS provider smoke failed (retryable_network). Provider request failed with a retryable network or temporary service error.',
    );
    expect(formatTTSProviderSmokeError(new Error('TTS provider smoke is not ready: enabled, secretConfigured'))).toBe(
      'TTS provider smoke is not ready (missing_config): enabled, secretConfigured',
    );
    expect(
      formatTTSProviderSmokeError(new Error('TTS smoke options must not contain secret-like keys or values')),
    ).toBe('TTS provider smoke failed (missing_config). TTS smoke options must not contain secret-like keys or values');
  });
});
