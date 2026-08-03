import type {
  ProviderCatalogItem,
  ProviderModelConfig,
  ProviderOptionConfig,
} from '../../../../src/providers/provider-jobs';
import { listChapterLabelingRequestProfileConfigs } from '../../../../src/providers/chapter-labeling-request-profile';
import {
  resolveLLMCapabilitySnapshot,
  resolveTTSCapabilitySnapshot,
} from '../../../../src/providers/provider-capability';
import { compactSpeakerAttributionRequestProfile } from '../../../../src/providers/speaker-attribution/request-profile';
import {
  loadServerAISettings,
  providerOptionsForAIProvider,
  serverAIProviderIds,
  serverAIProviderIsImplemented,
  type ServerAIProviderId,
  type ServerAISettings,
} from './server-ai-config.js';

export type ServerTTSProviderId =
  'system' | 'openai-tts' | 'elevenlabs' | 'gemini-tts' | 'gemini-vertex-tts' | 'google-cloud-tts' | 'local-endpoint';

export const serverTTSProviderIds: ServerTTSProviderId[] = [
  'system',
  'openai-tts',
  'elevenlabs',
  'gemini-tts',
  'gemini-vertex-tts',
  'google-cloud-tts',
  'local-endpoint',
];

const implementedTTSProviders = new Set<ServerTTSProviderId>([
  'system',
  'openai-tts',
  'elevenlabs',
  'gemini-tts',
  'gemini-vertex-tts',
  'google-cloud-tts',
  'local-endpoint',
]);

export function serverTTSProviderIsImplemented(providerId: ServerTTSProviderId): boolean {
  return implementedTTSProviders.has(providerId);
}

export interface ServerProviderCatalog {
  readonly aiProviders: ProviderCatalogItem[];
  readonly ttsProviders: ProviderCatalogItem[];
}

const aiProviderNames: Record<ServerAIProviderId, string> = {
  mock: 'Local Mock Labeler',
  openai: 'OpenAI',
  'gemini-ai-studio': 'Gemini API / AI Studio',
  'gemini-vertex': 'Gemini Vertex AI',
  'gemini-agent-platform': 'Gemini Enterprise Agent Platform',
  anthropic: 'Claude API',
};

const ttsProviderNames: Record<ServerTTSProviderId, string> = {
  system: 'System TTS',
  'openai-tts': 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  'gemini-tts': 'Gemini TTS',
  'gemini-vertex-tts': 'Gemini Vertex TTS',
  'google-cloud-tts': 'Google Cloud TTS',
  'local-endpoint': 'Local TTS Endpoint',
};

const voiceOption: ProviderOptionConfig = {
  optionKey: 'voice',
  displayName: 'Voice',
  valueType: 'string',
  placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
  description: 'Provider voice id or voice name. Prefer storing character-specific values on the voice profile.',
};

const instructionOptions: ProviderOptionConfig[] = [
  {
    optionKey: 'instructions',
    displayName: 'Instructions',
    valueType: 'string',
    placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
    description: 'Non-secret delivery instruction appended by providers that support promptable speech.',
  },
  {
    optionKey: 'prompt',
    displayName: 'Prompt',
    valueType: 'string',
    placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
    description: 'Provider speech prompt for TTS adapters that use prompt-style input.',
  },
];

const llmProviderOptions: ProviderOptionConfig[] = [
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
    max: 131072,
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
    description: 'Model context capability used for model-aware labeling window planning.',
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

const formatChoices = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'pcm', label: 'PCM' },
  { value: 'ogg', label: 'OGG' },
  { value: 'opus', label: 'Opus' },
  { value: 'aac', label: 'AAC' },
  { value: 'flac', label: 'FLAC' },
];

const audioEncodingChoices = [
  { value: 'MP3', label: 'MP3' },
  { value: 'LINEAR16', label: 'Linear16/WAV' },
  { value: 'PCM', label: 'PCM' },
  { value: 'OGG_OPUS', label: 'OGG Opus' },
  { value: 'MULAW', label: 'Mu-law' },
  { value: 'ALAW', label: 'A-law' },
];

function renderFormatOption(choices = formatChoices): ProviderOptionConfig {
  return {
    optionKey: 'format',
    displayName: 'Output format',
    valueType: 'select',
    defaultValue: choices[0]?.value ?? 'mp3',
    choices,
    description: 'Provider-neutral audio format stored in the TTS render spec and cache identity.',
  };
}

function renderSpeedOption(min: number, max: number): ProviderOptionConfig {
  return {
    optionKey: 'speed',
    displayName: 'Speed',
    valueType: 'number',
    min,
    max,
    step: 0.05,
    defaultValue: 1,
    description: 'Speech speed used for render spec identity and provider synthesis when supported.',
  };
}

const toneRenderOption: ProviderOptionConfig = {
  optionKey: 'tone',
  displayName: 'Tone',
  valueType: 'string',
  description: 'Non-secret delivery tone used by promptable TTS adapters.',
};

const emotionRenderOption: ProviderOptionConfig = {
  optionKey: 'emotion',
  displayName: 'Emotion',
  valueType: 'string',
  defaultValue: 'neutral',
  description: 'Segment emotion label used by promptable TTS adapters.',
};

function ttsRenderOptions(providerId: ServerTTSProviderId): ProviderOptionConfig[] {
  if (providerId === 'system') return [renderSpeedOption(0.1, 3)];
  if (providerId === 'elevenlabs') return [renderFormatOption(formatChoices.slice(0, 3)), renderSpeedOption(0.7, 1.2)];
  if (providerId === 'gemini-tts' || providerId === 'gemini-vertex-tts') {
    return [renderFormatOption([{ value: 'wav', label: 'WAV' }]), toneRenderOption, emotionRenderOption];
  }
  if (providerId === 'google-cloud-tts') {
    return [
      renderFormatOption([
        { value: 'mp3', label: 'MP3' },
        { value: 'wav', label: 'WAV/Linear16' },
        { value: 'pcm', label: 'PCM' },
        { value: 'ogg', label: 'OGG Opus' },
      ]),
      renderSpeedOption(0.25, 4),
      {
        optionKey: 'pitch',
        displayName: 'Pitch',
        valueType: 'number',
        min: -20,
        max: 20,
        step: 0.5,
        defaultValue: 0,
        description: 'Voice pitch in semitones for Google Cloud TTS compatible adapters.',
      },
      toneRenderOption,
      emotionRenderOption,
    ];
  }
  return [renderFormatOption(), renderSpeedOption(0.25, 4), toneRenderOption, emotionRenderOption];
}

function ttsProviderOptions(providerId: ServerTTSProviderId): ProviderOptionConfig[] {
  if (providerId === 'system') return [];
  if (providerId === 'openai-tts') {
    return [
      voiceOption,
      {
        optionKey: 'responseFormat',
        displayName: 'Response format',
        valueType: 'select',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        defaultValue: 'mp3',
        choices: formatChoices,
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
      instructionOptions[0],
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
        description: 'ElevenLabs output_format value.',
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
  if (providerId === 'gemini-tts' || providerId === 'gemini-vertex-tts') {
    return [
      voiceOption,
      ...(providerId === 'gemini-vertex-tts'
        ? [
            {
              optionKey: 'languageCode',
              displayName: 'Language code',
              valueType: 'string' as const,
              placements: ['provider_settings', 'voice_profile', 'synthesis_request'] as const,
              defaultValue: 'ko-KR',
            },
          ]
        : []),
      {
        optionKey: 'sampleRate',
        displayName: 'Sample rate',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: 8000,
        max: 48000,
        step: 1000,
        defaultValue: 24000,
      },
      ...instructionOptions,
    ];
  }
  if (providerId === 'google-cloud-tts') {
    return [
      voiceOption,
      {
        optionKey: 'languageCode',
        displayName: 'Language code',
        valueType: 'string',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        defaultValue: 'ko-KR',
      },
      {
        optionKey: 'audioEncoding',
        displayName: 'Audio encoding',
        valueType: 'select',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        defaultValue: 'MP3',
        choices: audioEncodingChoices,
      },
      {
        optionKey: 'speakingRate',
        displayName: 'Speaking rate',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: 0.25,
        max: 4,
        step: 0.05,
      },
      {
        optionKey: 'pitch',
        displayName: 'Pitch',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: -20,
        max: 20,
        step: 0.5,
      },
      {
        optionKey: 'sampleRateHertz',
        displayName: 'Sample rate',
        valueType: 'number',
        placements: ['provider_settings', 'voice_profile', 'synthesis_request'],
        min: 8000,
        max: 48000,
        step: 1000,
      },
      ...instructionOptions,
    ];
  }
  return [voiceOption];
}

function splitEnabled(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

const ttsProviderEnvPrefix: Record<ServerTTSProviderId, string | undefined> = {
  system: undefined,
  'openai-tts': 'TTS_OPENAI',
  elevenlabs: 'TTS_ELEVENLABS',
  'gemini-tts': 'TTS_GEMINI',
  'gemini-vertex-tts': 'TTS_GEMINI_VERTEX',
  'google-cloud-tts': 'TTS_GOOGLE_CLOUD',
  'local-endpoint': 'TTS_LOCAL_ENDPOINT',
};

const defaultTTSInputCharacterLimit: Record<ServerTTSProviderId, number | undefined> = {
  system: undefined,
  'openai-tts': 4000,
  elevenlabs: 5000,
  'gemini-tts': 4000,
  'gemini-vertex-tts': 5000,
  'google-cloud-tts': 5000,
  'local-endpoint': 20000,
};

const defaultTTSSegmentLimit: Record<ServerTTSProviderId, number | undefined> = {
  system: undefined,
  'openai-tts': 12,
  elevenlabs: 12,
  'gemini-tts': 12,
  'gemini-vertex-tts': 12,
  'google-cloud-tts': 12,
  'local-endpoint': 32,
};

function positiveIntegerEnv(env: NodeJS.ProcessEnv, keys: string[], fallback: number | undefined): number | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (!value) continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function ttsModelLimits(
  providerId: ServerTTSProviderId,
  env: NodeJS.ProcessEnv,
): Pick<ProviderModelConfig, 'maxInputCharacters' | 'maxInputSegments'> {
  const prefix = ttsProviderEnvPrefix[providerId];
  return {
    maxInputCharacters: positiveIntegerEnv(
      env,
      [prefix ? `${prefix}_MAX_INPUT_CHARACTERS` : '', 'TTS_MAX_INPUT_CHARACTERS'].filter(Boolean),
      defaultTTSInputCharacterLimit[providerId],
    ),
    maxInputSegments: positiveIntegerEnv(
      env,
      [prefix ? `${prefix}_MAX_SEGMENTS` : '', 'TTS_MAX_SEGMENTS'].filter(Boolean),
      defaultTTSSegmentLimit[providerId],
    ),
  };
}

function ttsCapabilityOptions(providerId: ServerTTSProviderId): Readonly<Record<string, unknown>> {
  if (providerId === 'gemini-tts' || providerId === 'gemini-vertex-tts') {
    return { formats: ['wav'], supportedControls: ['voice', 'tone', 'emotion'] };
  }
  if (providerId === 'google-cloud-tts') {
    return { formats: ['mp3', 'wav', 'pcm', 'ogg'], supportedControls: ['voice', 'speed', 'pitch', 'tone', 'emotion'] };
  }
  if (providerId === 'elevenlabs') {
    return { formats: ['mp3', 'pcm', 'wav'], supportedControls: ['voice', 'speed'] };
  }
  if (providerId === 'openai-tts') {
    return { formats: ['mp3', 'wav', 'pcm', 'opus', 'aac', 'flac'], supportedControls: ['voice', 'speed', 'tone'] };
  }
  return { formats: ['mp3'], supportedControls: ['voice', 'speed'] };
}

function modelConfig(
  providerId: string,
  modelId: string | undefined,
  purpose: ProviderModelConfig['purpose'],
  limits: Pick<ProviderModelConfig, 'maxInputCharacters' | 'maxInputSegments'> = {},
  providerOptions: Readonly<Record<string, unknown>> = {},
): ProviderModelConfig[] {
  return modelId
    ? [
        {
          providerId,
          modelId,
          displayName: modelId,
          purpose,
          enabled: true,
          ...limits,
          capabilitySnapshot:
            purpose === 'tts'
              ? resolveTTSCapabilitySnapshot({
                  providerId,
                  modelId,
                  providerOptions: { ...providerOptions, ...limits },
                })
              : resolveLLMCapabilitySnapshot({ providerId, modelId, providerOptions }),
        },
      ]
    : [];
}

export function listServerProviderCatalog(
  env: NodeJS.ProcessEnv = process.env,
  aiSettings: ServerAISettings = loadServerAISettings(env),
): ServerProviderCatalog {
  const enabledTTSProviders = splitEnabled(env.TTS_PROVIDER_ENABLED);
  const ttsModelByProvider: Record<ServerTTSProviderId, string | undefined> = {
    system: undefined,
    'openai-tts': env.TTS_OPENAI_MODEL_ID?.trim() || undefined,
    elevenlabs: env.TTS_ELEVENLABS_MODEL_ID?.trim() || 'eleven_flash_v2_5',
    'gemini-tts': env.TTS_GEMINI_MODEL_ID?.trim() || 'gemini-3.1-flash-tts-preview',
    'gemini-vertex-tts': env.TTS_GEMINI_VERTEX_MODEL_ID?.trim() || 'gemini-3.1-flash-tts-preview',
    'google-cloud-tts': env.TTS_GOOGLE_CLOUD_MODEL_ID?.trim() || 'gemini-3.1-flash-tts-preview',
    'local-endpoint': env.TTS_LOCAL_ENDPOINT_MODEL_ID?.trim() || undefined,
  };
  const googleCloudProject = env.GOOGLE_CLOUD_PROJECT?.trim() || aiSettings.geminiVertex.project;
  const googleCloudAccessToken = env.TTS_GOOGLE_CLOUD_ACCESS_TOKEN?.trim() || env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim();
  const googleCloudCredentialPath = aiSettings.geminiVertex.credentialsPath;
  const labelingRequestProfiles = [
    compactSpeakerAttributionRequestProfile,
    ...listChapterLabelingRequestProfileConfigs(),
  ];
  const ttsSecretConfigured: Record<ServerTTSProviderId, boolean> = {
    system: true,
    'openai-tts': Boolean(env.OPENAI_API_KEY?.trim()),
    elevenlabs: Boolean(env.ELEVENLABS_API_KEY?.trim()),
    'gemini-tts': Boolean(env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()),
    'gemini-vertex-tts': Boolean(googleCloudProject && googleCloudCredentialPath),
    'google-cloud-tts': Boolean(googleCloudAccessToken || (googleCloudProject && googleCloudCredentialPath)),
    'local-endpoint': Boolean(env.TTS_LOCAL_ENDPOINT_URL?.trim()),
  };

  return {
    aiProviders: serverAIProviderIds.map((providerId) => ({
      providerId,
      displayName: aiProviderNames[providerId],
      kind: 'llm',
      executionTarget: 'server_worker',
      secretPolicy: providerId === 'mock' ? 'no_secret_required' : 'server_env_only',
      implemented: serverAIProviderIsImplemented(providerId),
      enabled: aiSettings.enabledProviderIds.has(providerId),
      secretConfigured: aiSettings.secretConfiguredByProvider[providerId],
      models: modelConfig(
        providerId,
        aiSettings.labelingModelIdByProvider[providerId],
        'labeling',
        {},
        providerOptionsForAIProvider(aiSettings, providerId),
      ),
      capabilities: {
        supportsStructuredOutput: providerId !== 'mock',
        supportsStreaming: false,
        supportsAudioCache: false,
        supportsPerCharacterVoice: false,
        supportedRequestProfiles: labelingRequestProfiles,
        supportedProviderOptions: llmProviderOptions,
      },
    })),
    ttsProviders: serverTTSProviderIds.map((providerId) => ({
      providerId,
      displayName: ttsProviderNames[providerId],
      kind: providerId === 'system' ? 'system_tts' : providerId === 'local-endpoint' ? 'local_tts' : 'tts',
      executionTarget:
        providerId === 'system'
          ? 'browser_local'
          : providerId === 'local-endpoint'
            ? 'external_local_endpoint'
            : 'server_worker',
      secretPolicy:
        providerId === 'system'
          ? 'no_secret_required'
          : providerId === 'local-endpoint'
            ? 'external_local_endpoint_only'
            : 'server_env_only',
      implemented: serverTTSProviderIsImplemented(providerId),
      enabled: providerId === 'system' || enabledTTSProviders.has(providerId),
      secretConfigured: ttsSecretConfigured[providerId],
      models: modelConfig(
        providerId,
        ttsModelByProvider[providerId],
        'tts',
        ttsModelLimits(providerId, env),
        ttsCapabilityOptions(providerId),
      ),
      capabilities: {
        supportsStructuredOutput: false,
        supportsStreaming: providerId !== 'system',
        supportsAudioCache: providerId !== 'system',
        supportsPerCharacterVoice: true,
        supportedRenderOptions: ttsRenderOptions(providerId),
        supportedProviderOptions: ttsProviderOptions(providerId),
        allowsCustomProviderOptions: providerId === 'local-endpoint',
      },
    })),
  };
}
