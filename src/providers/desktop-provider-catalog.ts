import { listChapterLabelingRequestProfileConfigs } from './chapter-labeling-request-profile';
import { compactSpeakerAttributionRequestProfile } from './speaker-attribution/request-profile';
import { resolveLLMCapabilitySnapshot, resolveTTSCapabilitySnapshot } from './provider-capability';
import type {
  ProviderCatalogItem,
  ProviderOptionConfig,
  ProviderSecretStatus,
  ProviderSettingsScope,
} from './provider-jobs';
import type { PlatformRuntimeKind } from '../platform/runtime';
import type {
  RemoteProviderCatalog,
  RemoteProviderSettings,
  RemoteProviderSettingsBundle,
} from '../services/remote/remote-api-client';

const LOCAL_PROVIDER_SETTINGS_KEY = 'noveldesk.localProviderSettings.v1';

type DesktopLLMProviderId = 'openai' | 'gemini-ai-studio' | 'gemini-vertex' | 'anthropic';
type DesktopTTSProviderId = 'openai-tts' | 'elevenlabs' | 'local-endpoint';

export function providerSettingsForScope(
  bundle: RemoteProviderSettingsBundle | undefined,
  scope: ProviderSettingsScope,
): RemoteProviderSettings | undefined {
  if (!bundle) return undefined;
  return scope === 'llm_labeling' ? bundle.llmLabeling : bundle.ttsSynthesis;
}

export function providerCatalogForScope(
  catalog: RemoteProviderCatalog | undefined,
  scope: ProviderSettingsScope,
): ProviderCatalogItem[] {
  if (!catalog) return [];
  return scope === 'llm_labeling' ? catalog.aiProviders : catalog.ttsProviders;
}

export function defaultProviderSecretName(scope: ProviderSettingsScope, providerId: string): string | undefined {
  if (scope === 'llm_labeling') {
    if (providerId === 'openai' || providerId === 'gemini-ai-studio' || providerId === 'anthropic') return 'api_key';
    if (providerId === 'gemini-vertex' || providerId === 'gemini-agent-platform') return 'credential_path';
  }
  if (scope === 'tts_synthesis') {
    if (providerId === 'openai-tts' || providerId === 'elevenlabs' || providerId === 'gemini-tts') return 'api_key';
    if (providerId === 'gemini-vertex-tts') return 'credential_path';
    if (providerId === 'google-cloud-tts') return 'access_token';
    if (providerId === 'local-endpoint') return 'endpoint_url';
  }
  return undefined;
}

export function providerSecretDraftKey(scope: ProviderSettingsScope, providerId: string, secretName: string): string {
  return `${scope}:${providerId}:${secretName}`;
}

export function providerSecretDisplayLabel(secretName: string): string {
  if (secretName === 'api_key') return 'API key';
  if (secretName === 'access_token') return 'Access token';
  if (secretName === 'credential_path') return 'Credential path';
  if (secretName === 'endpoint_url') return 'Endpoint URL';
  return secretName;
}

export function providerSecretStatusLabel(status: ProviderSecretStatus | undefined): string {
  if (!status?.configured) return '미설정';
  const sourceLabel =
    status.source === 'desktop_secure_store'
      ? 'Desktop 저장'
      : status.source === 'android_secure_store'
        ? 'Android 저장'
        : status.source === 'user_encrypted'
          ? 'UI 저장'
          : '서버 env';
  return `${sourceLabel}${status.last4 ? ` · ****${status.last4}` : ''}`;
}

export function providerSecretCanDelete(status: ProviderSecretStatus | undefined): boolean {
  return Boolean(
    status?.configured &&
    (status.source === 'user_encrypted' ||
      status.source === 'desktop_secure_store' ||
      status.source === 'android_secure_store'),
  );
}

export function replaceProviderSettingsInBundle(
  bundle: RemoteProviderSettingsBundle,
  settings: RemoteProviderSettings,
): RemoteProviderSettingsBundle {
  return settings.scope === 'llm_labeling'
    ? { ...bundle, llmLabeling: settings }
    : { ...bundle, ttsSynthesis: settings };
}

export function replaceSecretStatus(
  statuses: ProviderSecretStatus[],
  status: ProviderSecretStatus,
): ProviderSecretStatus[] {
  const key = providerSecretDraftKey(status.scope, status.providerId, status.secretName);
  return [
    ...statuses.filter((item) => providerSecretDraftKey(item.scope, item.providerId, item.secretName) !== key),
    status,
  ];
}

export function nativeLocalLLMProviderIds(nativePlatformKind: PlatformRuntimeKind): DesktopLLMProviderId[] {
  if (nativePlatformKind === 'tauri-mobile') return ['openai', 'gemini-ai-studio', 'anthropic'];
  return ['openai', 'gemini-ai-studio', 'gemini-vertex', 'anthropic'];
}

export function desktopLocalProviderSettingsBundle(
  nativePlatformKind: PlatformRuntimeKind = 'tauri-desktop',
  now = new Date().toISOString(),
): RemoteProviderSettingsBundle {
  const enabledLLMProviders = nativeLocalLLMProviderIds(nativePlatformKind);
  return {
    llmLabeling: {
      scope: 'llm_labeling',
      defaultProviderId: 'openai',
      enabledProviderIds: enabledLLMProviders,
      modelByProvider: {
        openai: 'gpt-4.1-mini',
        'gemini-ai-studio': 'gemini-3.1-flash-lite',
        'gemini-vertex': 'gemini-3.1-flash-lite',
        anthropic: 'claude-3-5-haiku-latest',
      },
      providerOptionsByProvider: {
        'gemini-vertex': { location: 'global' },
      },
      updatedAt: now,
    },
    ttsSynthesis: {
      scope: 'tts_synthesis',
      defaultProviderId: 'system',
      enabledProviderIds: ['system'],
      modelByProvider: {
        'openai-tts': 'gpt-4o-mini-tts',
        elevenlabs: 'eleven_flash_v2_5',
        'local-endpoint': 'endpoint-default',
      },
      providerOptionsByProvider: {},
      updatedAt: now,
    },
  };
}

export function loadDesktopLocalProviderSettings(
  nativePlatformKind: PlatformRuntimeKind = 'tauri-desktop',
  storage: Storage | undefined = globalThis.localStorage,
): RemoteProviderSettingsBundle {
  const defaults = desktopLocalProviderSettingsBundle(nativePlatformKind);
  try {
    const raw = storage?.getItem(LOCAL_PROVIDER_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<RemoteProviderSettingsBundle>;
    return {
      llmLabeling: { ...defaults.llmLabeling, ...(parsed.llmLabeling ?? {}) },
      ttsSynthesis: { ...defaults.ttsSynthesis, ...(parsed.ttsSynthesis ?? {}) },
    };
  } catch {
    return defaults;
  }
}

export function saveDesktopLocalProviderSettings(
  bundle: RemoteProviderSettingsBundle,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(LOCAL_PROVIDER_SETTINGS_KEY, JSON.stringify(bundle));
  } catch {
    // Local provider settings are convenience state; the secure store still owns secrets.
  }
}

export function desktopProviderCatalog(
  statuses: ProviderSecretStatus[] = [],
  nativePlatformKind: PlatformRuntimeKind = 'tauri-desktop',
): RemoteProviderCatalog {
  const statusByProvider = new Map(
    statuses.map((status) => [providerSecretDraftKey(status.scope, status.providerId, status.secretName), status]),
  );
  const secretStatus = (scope: ProviderSettingsScope, providerId: string) => {
    const secretName = defaultProviderSecretName(scope, providerId);
    return secretName ? statusByProvider.get(providerSecretDraftKey(scope, providerId, secretName)) : undefined;
  };
  const labelingRequestProfiles = [
    ...listChapterLabelingRequestProfileConfigs(),
    {
      ...compactSpeakerAttributionRequestProfile,
      enabled: true,
      description: 'Speaker-only compact labeling with pinned scene packets and durable batch checkpoints.',
    },
  ];
  const platformLabel = nativePlatformKind === 'tauri-mobile' ? 'Android' : 'Desktop';
  const aiProvider = (providerId: DesktopLLMProviderId, displayName: string, modelId: string): ProviderCatalogItem => {
    const status = secretStatus('llm_labeling', providerId);
    return {
      providerId,
      displayName,
      kind: 'llm',
      executionTarget: 'desktop_secure_local',
      secretPolicy: 'desktop_secure_store_only',
      implemented: true,
      enabled: true,
      secretConfigured: Boolean(status?.configured),
      secretStatus: status,
      models: [
        {
          providerId,
          modelId,
          displayName: modelId,
          purpose: 'labeling',
          enabled: true,
          capabilitySnapshot: resolveLLMCapabilitySnapshot({ providerId, modelId }),
        },
      ],
      capabilities: {
        supportsStructuredOutput: true,
        supportsStreaming: false,
        supportsAudioCache: false,
        supportsPerCharacterVoice: false,
        supportedRequestProfiles: labelingRequestProfiles,
        supportedProviderOptions: desktopLLMProviderOptionConfigs(providerId),
      },
    };
  };
  const cloudTTSProvider = (
    providerId: DesktopTTSProviderId,
    displayName: string,
    modelId: string,
    maxInputCharacters: number,
  ): ProviderCatalogItem => {
    const status = secretStatus('tts_synthesis', providerId);
    const isLocalEndpoint = providerId === 'local-endpoint';
    return {
      providerId,
      displayName,
      kind: isLocalEndpoint ? 'local_tts' : 'tts',
      executionTarget: 'desktop_secure_local',
      secretPolicy: 'desktop_secure_store_only',
      implemented: true,
      enabled: true,
      secretConfigured: Boolean(status?.configured),
      secretStatus: status,
      models: [
        {
          providerId,
          modelId,
          displayName: modelId,
          purpose: 'tts',
          enabled: true,
          maxInputCharacters,
          maxInputSegments: 12,
          capabilitySnapshot: resolveTTSCapabilitySnapshot({
            providerId,
            modelId,
            providerOptions: { maxInputCharacters, maxInputSegments: 12 },
          }),
        },
      ],
      capabilities: {
        supportsStructuredOutput: false,
        supportsStreaming: !isLocalEndpoint,
        supportsAudioCache: false,
        supportsPerCharacterVoice: true,
        supportedRenderOptions: desktopTTSRenderOptionConfigs(providerId),
        supportedProviderOptions: desktopTTSProviderOptionConfigs(providerId),
        allowsCustomProviderOptions: isLocalEndpoint,
      },
    };
  };
  return {
    aiProviders: nativeLocalLLMProviderIds(nativePlatformKind).map((providerId) => {
      if (providerId === 'openai') return aiProvider(providerId, `OpenAI (${platformLabel})`, 'gpt-4.1-mini');
      if (providerId === 'gemini-ai-studio')
        return aiProvider(providerId, `Gemini API / AI Studio (${platformLabel})`, 'gemini-3.1-flash-lite');
      if (providerId === 'gemini-vertex')
        return aiProvider(providerId, `Gemini Vertex (${platformLabel})`, 'gemini-3.1-flash-lite');
      return aiProvider(providerId, `Claude API (${platformLabel})`, 'claude-3-5-haiku-latest');
    }),
    ttsProviders: [
      {
        providerId: 'system',
        displayName: 'System TTS',
        kind: 'system_tts',
        executionTarget: 'browser_local',
        secretPolicy: 'no_secret_required',
        implemented: true,
        enabled: true,
        secretConfigured: true,
        models: [
          {
            providerId: 'system',
            modelId: 'system',
            displayName: 'System voice',
            purpose: 'fallback',
            enabled: true,
          },
        ],
        capabilities: {
          supportsAudioCache: false,
          supportsPerCharacterVoice: false,
        },
      },
      cloudTTSProvider('openai-tts', `OpenAI TTS (${platformLabel})`, 'gpt-4o-mini-tts', 4000),
      cloudTTSProvider('elevenlabs', `ElevenLabs (${platformLabel})`, 'eleven_flash_v2_5', 5000),
      cloudTTSProvider('local-endpoint', `Local TTS Endpoint (${platformLabel})`, 'endpoint-default', 20000),
    ],
  };
}

function desktopLLMProviderOptionConfigs(providerId?: string): ProviderOptionConfig[] {
  const commonOptions: ProviderOptionConfig[] = [
    {
      optionKey: 'temperature',
      displayName: 'Temperature',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 0,
      max: 2,
      step: 0.05,
      description: 'Optional override. Leave empty to use the model default for labeling requests.',
    },
    {
      optionKey: 'topP',
      displayName: 'Top P',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      optionKey: 'maxOutputTokens',
      displayName: 'Max output tokens',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 256,
      max: 32768,
      step: 256,
    },
    {
      optionKey: 'contextWindowTokens',
      displayName: 'Context window tokens',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 2048,
      max: 2000000,
      step: 1024,
      description: 'Model context capability used to size labeling windows before a request is sent.',
    },
    {
      optionKey: 'contextSafetyFactor',
      displayName: 'Context safety factor',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 0.5,
      max: 1,
      step: 0.05,
      defaultValue: 0.9,
    },
    {
      optionKey: 'estimatedCharactersPerToken',
      displayName: 'Estimated characters per token',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 0.5,
      max: 8,
      step: 0.1,
      defaultValue: 1.5,
    },
    {
      optionKey: 'contextHaloParagraphs',
      displayName: 'Context halo paragraphs',
      valueType: 'number',
      placements: ['provider_settings'],
      min: 0,
      max: 8,
      step: 1,
      defaultValue: 2,
    },
  ];
  if (providerId !== 'gemini-vertex') return commonOptions;
  return [
    ...commonOptions,
    {
      optionKey: 'project',
      displayName: 'Google Cloud project',
      valueType: 'string',
      placements: ['provider_settings'],
      description: 'Optional override. If empty, the service-account project_id is used.',
    },
    {
      optionKey: 'location',
      displayName: 'Vertex location',
      valueType: 'string',
      placements: ['provider_settings'],
      defaultValue: 'global',
    },
  ];
}

function ttsFormatOption(
  choices = [
    { value: 'mp3', label: 'MP3' },
    { value: 'wav', label: 'WAV' },
    { value: 'pcm', label: 'PCM' },
    { value: 'ogg', label: 'OGG' },
    { value: 'opus', label: 'Opus' },
    { value: 'aac', label: 'AAC' },
    { value: 'flac', label: 'FLAC' },
  ],
): ProviderOptionConfig {
  return {
    optionKey: 'format',
    displayName: 'Output format',
    valueType: 'select',
    choices,
    defaultValue: choices[0]?.value ?? 'mp3',
    placements: ['provider_settings', 'synthesis_request'],
  };
}

function desktopTTSRenderOptionConfigs(providerId?: string): ProviderOptionConfig[] {
  if (providerId === 'elevenlabs') {
    return [
      ttsFormatOption([
        { value: 'mp3', label: 'MP3' },
        { value: 'wav', label: 'PCM 24k' },
        { value: 'opus', label: 'Opus' },
      ]),
      {
        optionKey: 'speed',
        displayName: 'Speed',
        valueType: 'number',
        min: 0.7,
        max: 1.2,
        step: 0.05,
        defaultValue: 1,
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
      },
    ];
  }
  return [
    ttsFormatOption(),
    {
      optionKey: 'speed',
      displayName: 'Speed',
      valueType: 'number',
      min: 0.25,
      max: 4,
      step: 0.05,
      defaultValue: 1,
      placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
    },
    {
      optionKey: 'tone',
      displayName: 'Tone',
      valueType: 'string',
      placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
    },
    {
      optionKey: 'emotion',
      displayName: 'Emotion',
      valueType: 'string',
      defaultValue: 'neutral',
      placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
    },
  ];
}

function desktopTTSProviderOptionConfigs(providerId?: string): ProviderOptionConfig[] {
  const voiceOption: ProviderOptionConfig = {
    optionKey: 'voice',
    displayName: 'Voice',
    valueType: 'string',
    placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
  };
  if (providerId === 'openai-tts') {
    return [
      voiceOption,
      {
        optionKey: 'responseFormat',
        displayName: 'Response format',
        valueType: 'select',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        defaultValue: 'mp3',
        choices: [
          { value: 'mp3', label: 'MP3' },
          { value: 'wav', label: 'WAV' },
          { value: 'pcm', label: 'PCM' },
          { value: 'opus', label: 'Opus' },
          { value: 'aac', label: 'AAC' },
          { value: 'flac', label: 'FLAC' },
        ],
      },
      {
        optionKey: 'speed',
        displayName: 'Provider speed override',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: 0.25,
        max: 4,
        step: 0.05,
      },
      {
        optionKey: 'instructions',
        displayName: 'Instructions',
        valueType: 'string',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
      },
    ];
  }
  if (providerId === 'elevenlabs') {
    return [
      voiceOption,
      {
        optionKey: 'outputFormat',
        displayName: 'Output format',
        valueType: 'string',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        defaultValue: 'mp3_44100_128',
      },
      ...['stability', 'similarityBoost', 'style'].map((optionKey) => ({
        optionKey,
        displayName: optionKey,
        valueType: 'number' as const,
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'] as const,
        min: 0,
        max: 1,
        step: 0.05,
      })),
      {
        optionKey: 'speed',
        displayName: 'Provider speed override',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: 0.7,
        max: 1.2,
        step: 0.05,
      },
      {
        optionKey: 'useSpeakerBoost',
        displayName: 'Speaker boost',
        valueType: 'boolean',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
      },
      {
        optionKey: 'enableLogging',
        displayName: 'Provider logging',
        valueType: 'boolean',
        placements: ['provider_settings', 'synthesis_request'],
      },
    ];
  }
  if (providerId === 'local-endpoint') {
    return [
      voiceOption,
      {
        optionKey: 'format',
        displayName: 'Format',
        valueType: 'select',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        defaultValue: 'mp3',
        choices: [
          { value: 'mp3', label: 'MP3' },
          { value: 'wav', label: 'WAV' },
          { value: 'pcm', label: 'PCM' },
          { value: 'ogg', label: 'OGG' },
          { value: 'opus', label: 'Opus' },
          { value: 'aac', label: 'AAC' },
          { value: 'flac', label: 'FLAC' },
        ],
      },
      {
        optionKey: 'speed',
        displayName: 'Provider speed override',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: 0.25,
        max: 4,
        step: 0.05,
      },
      {
        optionKey: 'tone',
        displayName: 'Tone',
        valueType: 'string',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
      },
      {
        optionKey: 'emotion',
        displayName: 'Emotion',
        valueType: 'string',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
      },
    ];
  }
  return [];
}
