import { describe, expect, it } from 'vitest';
import type { ProviderCatalogItem } from '../providers/provider-jobs';
import {
  autoRepairForDraftProvider,
  buildProviderDraftOptionsForProvider,
  buildProviderSettingsSaveInput,
  catalogProviderReady,
  createProviderSettingsDraft,
  providerOptionValueFromRecord,
  providerOptionValueForDraftProvider,
  providerOptionsContainSecretLikeValue,
  providerSettingOptionConfigs,
  providerVoiceProfileOptionConfigs,
  providerReadinessLabel,
  requestProfileIdForDraftProvider,
  setDraftProviderAutoRepair,
  setDraftDefaultProvider,
  setDraftProviderEnabled,
  setDraftProviderOption,
  setDraftProviderRequestProfile,
  setProviderOptionInRecord,
} from '../providers/provider-settings-ui';
import type { RemoteProviderSettings } from '../services/remote/remote-api-client';

const catalog = [
  provider('mock', { secretPolicy: 'no_secret_required', secretConfigured: true }),
  provider('openai', { secretConfigured: true, modelId: 'gpt-labeler' }),
  provider('anthropic', { secretConfigured: false, modelId: 'claude-labeler' }),
  provider('gemini-vertex', { implemented: false, secretConfigured: true }),
];
const ttsCatalog = [
  provider('system', {
    kind: 'system_tts',
    executionTarget: 'browser_local',
    secretPolicy: 'no_secret_required',
    secretConfigured: true,
  }),
  provider('openai-tts', { kind: 'tts', secretConfigured: true, modelId: 'gpt-4o-mini-tts' }),
  provider('elevenlabs', { kind: 'tts', implemented: false, secretConfigured: false }),
];

function provider(
  providerId: string,
  patch: Partial<ProviderCatalogItem> & { modelId?: string } = {},
): ProviderCatalogItem {
  const modelId = patch.modelId;
  return {
    providerId,
    displayName: providerId,
    kind: 'llm',
    executionTarget: 'server_worker',
    secretPolicy: 'server_env_only',
    implemented: true,
    enabled: true,
    secretConfigured: false,
    models: modelId ? [{ providerId, modelId, displayName: modelId, purpose: 'labeling', enabled: true }] : [],
    capabilities: { supportsStructuredOutput: true },
    ...patch,
  };
}

const requestProfile = {
  profileId: 'chapter-labeling-v1',
  displayName: 'Chapter Labeling v1',
  promptVersion: 'chapter-labeler-v1',
  schemaVersion: 'chapter-labeling-result-v1',
  enabled: true,
};
const strictTtsRequestProfile = {
  profileId: 'chapter-labeling-v1-strict-tts',
  displayName: 'Strict TTS Labeling v1',
  promptVersion: 'chapter-labeler-v1-strict-tts-windowed',
  schemaVersion: 'chapter-labeling-result-v1',
  enabled: true,
};

function settings(patch: Partial<RemoteProviderSettings> = {}): RemoteProviderSettings {
  return {
    scope: 'llm_labeling',
    defaultProviderId: 'openai',
    enabledProviderIds: ['mock', 'openai'],
    modelByProvider: { openai: 'gpt-labeler-custom' },
    providerOptionsByProvider: { openai: { temperature: 0.1 } },
    ...patch,
  };
}

describe('provider settings UI helpers', () => {
  it('creates a draft from saved settings and catalog defaults', () => {
    const draft = createProviderSettingsDraft(settings(), catalog);

    expect(draft.defaultProviderId).toBe('openai');
    expect(draft.enabledProviderIds).toEqual(['mock', 'openai']);
    expect(draft.modelByProvider.openai).toBe('gpt-labeler-custom');
    expect(draft.modelByProvider.anthropic).toBe('claude-labeler');
    expect(draft.providerOptionsTextByProvider.openai).toContain('"temperature": 0.1');
  });

  it('creates a TTS synthesis draft with system fallback and cacheable providers', () => {
    const draft = createProviderSettingsDraft(
      settings({
        scope: 'tts_synthesis',
        defaultProviderId: 'system',
        enabledProviderIds: ['system', 'openai-tts'],
        modelByProvider: { 'openai-tts': 'tts-custom' },
        providerOptionsByProvider: { 'openai-tts': { voice: 'alloy' } },
      }),
      ttsCatalog,
    );

    expect(draft.scope).toBe('tts_synthesis');
    expect(draft.defaultProviderId).toBe('system');
    expect(draft.enabledProviderIds).toEqual(['system', 'openai-tts']);
    expect(draft.modelByProvider['openai-tts']).toBe('tts-custom');
    expect(catalogProviderReady(ttsCatalog[0])).toBe(true);
    expect(catalogProviderReady(ttsCatalog[1])).toBe(true);
  });

  it('keeps the default provider enabled when default changes', () => {
    const draft = createProviderSettingsDraft(settings({ enabledProviderIds: ['mock'] }), catalog);
    const next = setDraftDefaultProvider(draft, 'openai');

    expect(next.defaultProviderId).toBe('openai');
    expect(next.selectedProviderId).toBe('openai');
    expect(next.enabledProviderIds).toEqual(['mock', 'openai']);
  });

  it('moves the default when a selected provider is disabled', () => {
    const draft = createProviderSettingsDraft(settings(), catalog);
    const next = setDraftProviderEnabled(draft, 'openai', false);

    expect(next.defaultProviderId).toBe('mock');
    expect(next.enabledProviderIds).toEqual(['mock']);
  });

  it('builds save input and rejects invalid or secret-like options', () => {
    const draft = createProviderSettingsDraft(settings(), catalog);
    const ok = buildProviderSettingsSaveInput(draft, catalog);
    expect(ok.ok).toBe(true);
    expect(ok.input).toMatchObject({
      defaultProviderId: 'openai',
      enabledProviderIds: ['mock', 'openai'],
      modelByProvider: { openai: 'gpt-labeler-custom' },
      providerOptionsByProvider: { openai: { temperature: 0.1 } },
    });

    const invalidJson = {
      ...draft,
      providerOptionsTextByProvider: { ...draft.providerOptionsTextByProvider, openai: '{invalid' },
    };
    expect(buildProviderSettingsSaveInput(invalidJson, catalog)).toMatchObject({
      ok: false,
      providerId: 'openai',
    });

    const secretLike = {
      ...draft,
      providerOptionsTextByProvider: {
        ...draft.providerOptionsTextByProvider,
        openai: '{"apiKey":"sk-proj-secretvalue"}',
      },
    };
    expect(buildProviderSettingsSaveInput(secretLike, catalog)).toMatchObject({
      ok: false,
      providerId: 'openai',
    });
  });

  it('builds one provider option draft for sample actions without accepting secrets', () => {
    const draft = createProviderSettingsDraft(
      settings({
        scope: 'tts_synthesis',
        defaultProviderId: 'openai-tts',
        enabledProviderIds: ['openai-tts'],
        providerOptionsByProvider: { 'openai-tts': { format: 'mp3', voice: 'alloy' } },
      }),
      ttsCatalog,
    );

    expect(buildProviderDraftOptionsForProvider(draft, 'openai-tts')).toEqual({
      ok: true,
      options: { format: 'mp3', voice: 'alloy' },
    });

    const secretLike = {
      ...draft,
      providerOptionsTextByProvider: {
        ...draft.providerOptionsTextByProvider,
        'openai-tts': '{"apiKey":"sk-proj-secretvalue"}',
      },
    };
    expect(buildProviderDraftOptionsForProvider(secretLike, 'openai-tts')).toMatchObject({
      ok: false,
      providerId: 'openai-tts',
    });
  });

  it('reads and updates request profile ids through provider options JSON', () => {
    const profileCatalog = [
      provider('openai', {
        secretConfigured: true,
        modelId: 'gpt-labeler',
        capabilities: {
          supportsStructuredOutput: true,
          supportedRequestProfiles: [requestProfile, strictTtsRequestProfile],
        },
      }),
    ];
    const draft = createProviderSettingsDraft(
      settings({
        defaultProviderId: 'openai',
        enabledProviderIds: ['openai'],
        providerOptionsByProvider: { openai: { temperature: 0.2 } },
      }),
      profileCatalog,
    );

    expect(requestProfileIdForDraftProvider(draft, profileCatalog[0])).toBe('chapter-labeling-v1');
    const next = setDraftProviderRequestProfile(draft, 'openai', 'chapter-labeling-v1-strict-tts');

    expect(next.providerOptionsTextByProvider.openai).toContain('"requestProfileId": "chapter-labeling-v1-strict-tts"');
    expect(buildProviderSettingsSaveInput(next, profileCatalog)).toMatchObject({
      ok: true,
      input: {
        providerOptionsByProvider: {
          openai: {
            temperature: 0.2,
            requestProfileId: 'chapter-labeling-v1-strict-tts',
          },
        },
      },
    });
  });

  it('reads and updates auto repair through provider options JSON', () => {
    const draft = createProviderSettingsDraft(
      settings({
        providerOptionsByProvider: { openai: { temperature: 0.2 } },
      }),
      catalog,
    );

    expect(autoRepairForDraftProvider(draft, 'openai')).toBe(false);
    const enabled = setDraftProviderAutoRepair(draft, 'openai', true);

    expect(autoRepairForDraftProvider(enabled, 'openai')).toBe(true);
    expect(buildProviderSettingsSaveInput(enabled, catalog)).toMatchObject({
      ok: true,
      input: {
        providerOptionsByProvider: {
          openai: {
            temperature: 0.2,
            autoRepairOnValidationFailure: true,
          },
        },
      },
    });

    const disabled = setDraftProviderAutoRepair(enabled, 'openai', false);
    expect(autoRepairForDraftProvider(disabled, 'openai')).toBe(false);
    expect(disabled.providerOptionsTextByProvider.openai).not.toContain('autoRepairOnValidationFailure');
  });

  it('exposes catalog option metadata and updates non-secret provider options', () => {
    const optionCatalog = [
      provider('openai-tts', {
        kind: 'tts',
        secretConfigured: true,
        capabilities: {
          supportsAudioCache: true,
          supportedRenderOptions: [
            {
              optionKey: 'format',
              displayName: 'Format',
              valueType: 'select',
              choices: [{ value: 'mp3', label: 'MP3' }],
            },
            { optionKey: 'speed', displayName: 'Speed', valueType: 'number', min: 0.25, max: 4 },
          ],
          supportedProviderOptions: [
            { optionKey: 'voice', displayName: 'Voice', valueType: 'string', placements: ['voice_profile'] },
            {
              optionKey: 'instructions',
              displayName: 'Instructions',
              valueType: 'string',
              placements: ['provider_settings'],
            },
            {
              optionKey: 'speed',
              displayName: 'Provider speed',
              valueType: 'number',
              placements: ['provider_settings'],
              min: 0.25,
              max: 4,
            },
          ],
        },
      }),
    ];
    const draft = createProviderSettingsDraft(
      settings({
        scope: 'tts_synthesis',
        defaultProviderId: 'openai-tts',
        enabledProviderIds: ['openai-tts'],
        providerOptionsByProvider: { 'openai-tts': { speed: 1.1 } },
      }),
      optionCatalog,
    );

    expect(providerSettingOptionConfigs(optionCatalog[0]).map((option) => option.optionKey)).toEqual([
      'format',
      'speed',
      'instructions',
    ]);
    expect(providerOptionValueForDraftProvider(draft, 'openai-tts', 'speed')).toBe(1.1);

    const withInstructions = setDraftProviderOption(
      draft,
      'openai-tts',
      { optionKey: 'instructions', valueType: 'string' },
      ' warm narration ',
    );
    expect(providerOptionValueForDraftProvider(withInstructions, 'openai-tts', 'instructions')).toBe('warm narration');

    const withFormat = setDraftProviderOption(
      withInstructions,
      'openai-tts',
      { optionKey: 'format', valueType: 'select' },
      'mp3',
    );
    const withoutSpeed = setDraftProviderOption(
      withFormat,
      'openai-tts',
      { optionKey: 'speed', valueType: 'number' },
      '',
    );
    expect(buildProviderSettingsSaveInput(withoutSpeed, optionCatalog)).toMatchObject({
      ok: true,
      input: {
        providerOptionsByProvider: {
          'openai-tts': {
            instructions: 'warm narration',
            format: 'mp3',
          },
        },
      },
    });
  });

  it('exposes voice-profile provider options without duplicating provider voice id', () => {
    const voiceCatalogItem = provider('elevenlabs', {
      kind: 'tts',
      secretConfigured: true,
      capabilities: {
        supportsAudioCache: true,
        supportedProviderOptions: [
          { optionKey: 'voice', displayName: 'Voice', valueType: 'string', placements: ['voice_profile'] },
          {
            optionKey: 'stability',
            displayName: 'Stability',
            valueType: 'number',
            placements: ['provider_settings', 'voice_profile'],
            min: 0,
            max: 1,
          },
          {
            optionKey: 'enableLogging',
            displayName: 'Logging',
            valueType: 'boolean',
            placements: ['provider_settings'],
          },
        ],
      },
    });

    expect(providerVoiceProfileOptionConfigs(voiceCatalogItem).map((option) => option.optionKey)).toEqual([
      'stability',
    ]);

    const providerOptions = setProviderOptionInRecord(
      { stability: 0.3 },
      { optionKey: 'stability', valueType: 'number' },
      '0.75',
    );
    expect(providerOptions).toEqual({ stability: 0.75 });
    expect(providerOptionValueFromRecord(providerOptions, 'stability')).toBe(0.75);

    const cleared = setProviderOptionInRecord(providerOptions, { optionKey: 'stability', valueType: 'number' }, '');
    expect(cleared).toEqual({});
    expect(providerOptionsContainSecretLikeValue({ instructions: 'Bearer secret-token-value' })).toBe(true);
    expect(
      providerOptionsContainSecretLikeValue({ endpointUrl: 'http://127.0.0.1:5000/synthesize?token=secret' }),
    ).toBe(true);
  });

  it('reports catalog readiness without exposing secrets', () => {
    expect(catalogProviderReady(catalog[0])).toBe(true);
    expect(catalogProviderReady(catalog[1])).toBe(true);
    expect(catalogProviderReady(catalog[2])).toBe(false);
    expect(providerReadinessLabel(catalog[2])).toBe('서버 설정 필요');
    expect(
      providerReadinessLabel(
        provider('openai', {
          executionTarget: 'desktop_secure_local',
          secretPolicy: 'desktop_secure_store_only',
          secretConfigured: false,
        }),
      ),
    ).toBe('키 설정 필요');
    expect(providerReadinessLabel(catalog[3])).toBe('미구현');
  });
});
