import { lazy } from 'react';
import { createAppRuntime, type AppRuntime } from '../../../src/app/runtime/app-runtime';
import { WebDataSettings } from './WebDataSettings';
import { createReaderRuntime } from '../../../src/repositories/reader-runtime';
import { createAppExtensionRuntime } from '../../../src/extensions/app-extension-runtime';
import { readerInfoTrustedExtension } from '../../../src/extensions/builtin/reader-info-extension';
import type { AIProvider } from '../../../src/providers/ai';
import { ProviderRegistry } from '../../../src/providers/provider-registry';
import { SystemTTSProvider, type TTSProvider } from '../../../src/providers/tts';
import type { ReaderProviderRuntime } from '../../../src/providers/reader-provider-runtime';
import { WebLibraryNotice } from './WebLibraryNotice';
import { WebUpdateNotice } from './WebUpdateNotice';
import { recordWebBackup } from './web-data-safety';
import { googleVaultAdapter } from './google/google-vault-adapter';

/** Never manufacture analysis output when the Web edition has no real AI engine. */
export function createWebProviderRuntime(): ReaderProviderRuntime {
  const ai: AIProvider = {
    providerId: 'web-ai-unavailable',
    displayName: 'AI 분석 미지원',
    async labelChapterSegments() {
      throw new Error('현재 Web 버전은 AI 분석을 지원하지 않습니다. 일반 읽기와 시스템 음성은 사용할 수 있습니다.');
    },
  };
  const tts = new SystemTTSProvider();
  return {
    aiProviders: new ProviderRegistry([ai]),
    ttsProviders: new ProviderRegistry<TTSProvider>([tts]),
    defaultAIProviderId: ai.providerId,
    defaultTTSProviderId: tts.providerId,
    capabilities: [
      {
        providerId: tts.providerId,
        kind: 'system_tts',
        executionTarget: 'browser_local',
        secretPolicy: 'no_secret_required',
        supportsAudioCache: false,
        supportsPerCharacterVoice: false,
      },
    ],
    getDefaultAIProvider: () => ai,
    getDefaultTTSProvider: () => tts,
  };
}

/** Static edition boundary: legacy storage/env must never attach books to a server. */
const WebSyncPanel = lazy(() => import('./WebSyncPanel'));

export function createWebRuntime(): AppRuntime {
  const runtime = createAppRuntime({
    readerRuntimeFactory: () => createReaderRuntime({ mode: 'local', allowServerSync: false }),
    providerRuntimeFactory: createWebProviderRuntime,
    platformRuntimeDetector: () => ({
      kind: 'browser',
      hasTauri: false,
      isMobileWebView: false,
      userAgent: globalThis.navigator?.userAgent ?? '',
    }),
    extensionRuntimeFactory: () => createAppExtensionRuntime({ trustedDefinitions: [readerInfoTrustedExtension] }),
  });
  return {
    ...runtime,
    product: {
      kind: 'local-static',
      StoragePanel: WebDataSettings,
      SyncPanel: WebSyncPanel,
      LibraryNotice: WebLibraryNotice,
      Lifecycle: WebUpdateNotice,
      onBackupExported: recordWebBackup,
      cloudVaultProvider: googleVaultAdapter,
    },
  };
}
