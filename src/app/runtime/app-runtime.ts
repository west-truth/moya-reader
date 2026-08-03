import type { AIProvider } from '../../providers/ai';
import type { BookAnalysisWorkflowGateway } from '../../features/ai/book-analysis-workflow-gateway';
import type { NativeBookWorkflowBridge } from '../../features/ai/native-workflow/contracts';
import { RemoteBookAnalysisWorkflowGateway } from '../../features/ai/remote-book-analysis-workflow-gateway';
import {
  DesktopProviderControlClient,
  RemoteProviderControlClient,
  type ProviderControlClient,
} from '../../providers/provider-control-client';
import { createReaderProviderRuntime, type ReaderProviderRuntime } from '../../providers/reader-provider-runtime';
import type { TTSProvider } from '../../providers/tts';
import type { TTSCacheGateway } from '../../features/tts/tts-cache-gateway';
import {
  detectPlatformRuntime,
  resolveProviderExecutionRuntime,
  type PlatformRuntimeInfo,
  type ProviderExecutionRuntimeKind,
} from '../../platform/runtime';
import { createPlatformSystemTTSProvider } from '../../platform/android/system-tts';
import { createReaderRuntime, type ReaderRuntime } from '../../repositories/reader-runtime';
import type {
  NativeAnalysisWorkflowRepository,
  ReaderRepository,
  RevisionPinnedReaderRepository,
} from '../../repositories/reader-repository';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import {
  LazyNativeBookAnalysisWorkflowGateway,
  LazyNativeTTSCacheGateway,
  TauriNativeBookWorkflowBridge,
} from '../../platform/tauri';

export interface AppRuntime {
  readonly readerRuntime: ReaderRuntime;
  readonly providerRuntime: ReaderProviderRuntime;
  readonly defaultAIProvider: AIProvider;
  readonly defaultTTSProvider: TTSProvider;
  readonly platformRuntime: PlatformRuntimeInfo;
  readonly providerExecutionRuntime: ProviderExecutionRuntimeKind;
  readonly providerApiClient?: RemoteApiClient;
  readonly providerControlClient?: ProviderControlClient;
  readonly bookAnalysisWorkflowGateway?: BookAnalysisWorkflowGateway;
  readonly ttsCacheGateway?: TTSCacheGateway;
}

export interface AppRuntimeDependencies {
  readonly readerRuntimeFactory?: () => ReaderRuntime;
  readonly providerRuntimeFactory?: () => ReaderProviderRuntime;
  readonly platformRuntimeDetector?: () => PlatformRuntimeInfo;
  readonly remoteProviderControlClientFactory?: (apiClient: RemoteApiClient) => ProviderControlClient;
  readonly desktopProviderControlClientFactory?: () => ProviderControlClient;
  readonly remoteBookAnalysisWorkflowGatewayFactory?: (apiClient: RemoteApiClient) => BookAnalysisWorkflowGateway;
  readonly nativeBookWorkflowBridgeFactory?: () => NativeBookWorkflowBridge;
  readonly nativeBookAnalysisWorkflowGatewayFactory?: (
    bridge: NativeBookWorkflowBridge,
    repository: RevisionPinnedReaderRepository & NativeAnalysisWorkflowRepository,
  ) => BookAnalysisWorkflowGateway;
  readonly nativeTTSCacheGatewayFactory?: () => TTSCacheGateway;
}

function nativeWorkflowRepository(
  repository: ReaderRepository,
): repository is RevisionPinnedReaderRepository & NativeAnalysisWorkflowRepository {
  const candidate = repository as Partial<RevisionPinnedReaderRepository & NativeAnalysisWorkflowRepository>;
  return (
    typeof candidate.openContentRevision === 'function' &&
    typeof candidate.saveNativeAnalysisWorkflowDescriptor === 'function' &&
    typeof candidate.getNativeAnalysisWorkflowDescriptor === 'function' &&
    typeof candidate.saveNativeAnalysisWorkflowFence === 'function' &&
    typeof candidate.stageNativeAnalysisOutput === 'function' &&
    typeof candidate.promoteNativeAnalysisOutput === 'function'
  );
}

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
  const platformRuntime = dependencies.platformRuntimeDetector?.() ?? detectPlatformRuntime();
  const providerRuntime =
    dependencies.providerRuntimeFactory?.() ??
    createReaderProviderRuntime({ systemTTSProvider: createPlatformSystemTTSProvider(platformRuntime) });
  const readerRuntime = dependencies.readerRuntimeFactory?.() ?? createReaderRuntime();
  const providerExecutionRuntime = resolveProviderExecutionRuntime({
    backendMode: readerRuntime.mode,
    platformKind: platformRuntime.kind,
    hasRemoteApiClient: Boolean(readerRuntime.remoteApiClient),
    hasSyncApiClient: Boolean(readerRuntime.syncApiClient),
  });
  const providerApiClient =
    providerExecutionRuntime === 'server' ? (readerRuntime.remoteApiClient ?? readerRuntime.syncApiClient) : undefined;

  let providerControlClient: ProviderControlClient | undefined;
  let bookAnalysisWorkflowGateway: BookAnalysisWorkflowGateway | undefined;
  let ttsCacheGateway: TTSCacheGateway | undefined;
  if (providerApiClient) {
    providerControlClient =
      dependencies.remoteProviderControlClientFactory?.(providerApiClient) ??
      new RemoteProviderControlClient(providerApiClient);
    bookAnalysisWorkflowGateway =
      dependencies.remoteBookAnalysisWorkflowGatewayFactory?.(providerApiClient) ??
      new RemoteBookAnalysisWorkflowGateway(providerApiClient);
  } else if (providerExecutionRuntime === 'desktop') {
    providerControlClient = dependencies.desktopProviderControlClientFactory?.() ?? new DesktopProviderControlClient();
    if (platformRuntime.kind === 'tauri-desktop' && nativeWorkflowRepository(readerRuntime.readerRepository)) {
      ttsCacheGateway = dependencies.nativeTTSCacheGatewayFactory?.() ?? new LazyNativeTTSCacheGateway();
      const bridge = dependencies.nativeBookWorkflowBridgeFactory?.() ?? new TauriNativeBookWorkflowBridge();
      bookAnalysisWorkflowGateway =
        dependencies.nativeBookAnalysisWorkflowGatewayFactory?.(bridge, readerRuntime.readerRepository) ??
        new LazyNativeBookAnalysisWorkflowGateway(bridge, readerRuntime.readerRepository);
    }
  }

  return {
    readerRuntime,
    providerRuntime,
    defaultAIProvider: providerRuntime.getDefaultAIProvider(),
    defaultTTSProvider: providerRuntime.getDefaultTTSProvider(),
    platformRuntime,
    providerExecutionRuntime,
    providerApiClient,
    providerControlClient,
    bookAnalysisWorkflowGateway,
    ttsCacheGateway,
  };
}
