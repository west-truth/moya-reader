import { MockAIProvider, type AIProvider } from './ai';
import { SystemTTSProvider, type TTSProvider } from './tts';
import { ProviderRegistry } from './provider-registry';
import type { ProviderCapability } from './provider-jobs';

export interface ReaderProviderRuntime {
  readonly aiProviders: ProviderRegistry<AIProvider>;
  readonly ttsProviders: ProviderRegistry<TTSProvider>;
  readonly capabilities: ProviderCapability[];
  readonly defaultAIProviderId: string;
  readonly defaultTTSProviderId: string;
  getDefaultAIProvider(): AIProvider;
  getDefaultTTSProvider(): TTSProvider;
}

export interface ReaderProviderRuntimeInput {
  readonly systemTTSProvider?: TTSProvider;
}

export function createReaderProviderRuntime(input: ReaderProviderRuntimeInput = {}): ReaderProviderRuntime {
  const mockAIProvider = new MockAIProvider();
  const systemTTSProvider = input.systemTTSProvider ?? new SystemTTSProvider();
  const aiProviders = new ProviderRegistry<AIProvider>([mockAIProvider]);
  const ttsProviders = new ProviderRegistry<TTSProvider>([systemTTSProvider]);
  const defaultAIProviderId = mockAIProvider.providerId;
  const defaultTTSProviderId = systemTTSProvider.providerId;

  return {
    aiProviders,
    ttsProviders,
    defaultAIProviderId,
    defaultTTSProviderId,
    capabilities: [
      {
        providerId: mockAIProvider.providerId,
        kind: 'llm',
        executionTarget: 'browser_local',
        secretPolicy: 'no_secret_required',
        supportsStructuredOutput: false,
      },
      {
        providerId: systemTTSProvider.providerId,
        kind: 'system_tts',
        executionTarget: 'browser_local',
        secretPolicy: 'no_secret_required',
        supportsStreaming: false,
        supportsAudioCache: false,
        supportsPerCharacterVoice: false,
      },
    ],
    getDefaultAIProvider: () => aiProviders.get(defaultAIProviderId),
    getDefaultTTSProvider: () => ttsProviders.get(defaultTTSProviderId),
  };
}
