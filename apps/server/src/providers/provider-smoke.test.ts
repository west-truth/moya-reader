import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAIProviderSmokeError, parseProviderSmokeArgs, runAIProviderSmoke } from './provider-smoke.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider smoke runner', () => {
  it('reports sanitized dry-run readiness without making external calls', async () => {
    const summary = await runAIProviderSmoke({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.1-flash-lite',
      live: false,
      env: {
        AI_PROVIDER_ENABLED: 'mock,gemini-vertex',
        AI_PROVIDER_DEFAULT: 'gemini-vertex',
        AI_GEMINI_VERTEX_LABELING_MODEL_ID: 'gemini-3.1-flash-lite',
        VERTEX_CREDENTIALS_DIR: '__missing_vertex_credentials__',
      },
      cwd: process.cwd(),
    });

    expect(summary).toMatchObject({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.1-flash-lite',
      requestProfile: {
        profileId: 'chapter-labeling-v2-strict-tts',
      },
      live: false,
      ready: {
        enabled: true,
        implemented: true,
        secretConfigured: false,
        modelConfigured: true,
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(/private|Bearer|__missing_vertex_credentials__/i);
  });

  it('can run a live smoke against the mock provider without network access', async () => {
    const summary = await runAIProviderSmoke({
      providerId: 'mock',
      live: true,
      env: {
        AI_PROVIDER_ENABLED: 'mock',
      },
      cwd: process.cwd(),
    });

    expect(summary.result).toMatchObject({
      segmentCount: 2,
      characterCount: expect.any(Number),
    });
    expect(summary.result?.segmentTypes).toEqual(
      expect.objectContaining({
        quoted_dialogue: 1,
        system_message: 1,
      }),
    );
  });

  it('lets smoke runs override the chapter labeling request profile without editing env files', async () => {
    const summary = await runAIProviderSmoke({
      providerId: 'mock',
      requestProfileId: 'chapter-labeling-v1-strict-tts',
      live: false,
      env: {
        AI_PROVIDER_ENABLED: 'mock',
      },
      cwd: process.cwd(),
    });

    expect(summary.requestProfile).toMatchObject({
      profileId: 'chapter-labeling-v1-strict-tts',
      promptVersion: 'chapter-labeler-v1-strict-tts-windowed',
    });
  });

  it('rejects unsupported smoke request profiles before any live provider call', async () => {
    await expect(
      runAIProviderSmoke({
        providerId: 'mock',
        requestProfileId: 'missing-profile',
        live: true,
        env: {
          AI_PROVIDER_ENABLED: 'mock',
        },
        cwd: process.cwd(),
      }),
    ).rejects.toThrow('Unsupported chapter labeling request profile: missing-profile');
  });

  it('parses provider smoke CLI args', () => {
    expect(
      parseProviderSmokeArgs([
        '--provider',
        'gemini-vertex',
        '--model=gemini-3.1-flash-lite',
        '--profile',
        'chapter-labeling-v1-strict-tts',
        '--live',
        '--json',
        '--project',
        'project-test',
      ]),
    ).toEqual({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.1-flash-lite',
      requestProfileId: 'chapter-labeling-v1-strict-tts',
      live: true,
      json: true,
      project: 'project-test',
    });
  });

  it('keeps live smoke explicit even if a legacy env toggle is present', () => {
    vi.stubEnv('AI_PROVIDER_SMOKE_LIVE', '1');

    expect(parseProviderSmokeArgs(['--provider', 'gemini-vertex']).live).toBe(false);
  });

  it('formats provider failures with categories without leaking response details', () => {
    expect(formatAIProviderSmokeError(new Error('OpenAI request failed (401): token=secret'))).toBe(
      'AI provider smoke failed (auth). Provider authentication or authorization failed. Check server-side credentials and permissions.',
    );
    expect(formatAIProviderSmokeError(new Error('AI provider smoke is not ready: secretConfigured'))).toBe(
      'AI provider smoke is not ready (missing_config): secretConfigured',
    );
    expect(formatAIProviderSmokeError(new Error('Gemini request failed (500): apiKey=secret'))).not.toMatch(
      /apiKey=secret/,
    );
  });
});
