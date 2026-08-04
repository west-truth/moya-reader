import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRuntimeInfo } from '../../platform/runtime';
import type { ProviderControlClient } from '../../providers/provider-control-client';
import type { BookAnalysisWorkflowGateway } from '../../features/ai/book-analysis-workflow-gateway';
import type { NativeBookWorkflowBridge } from '../../features/ai/native-workflow/contracts';
import type { TTSCacheGateway } from '../../features/tts/tts-cache-gateway';
import { createReaderProviderRuntime } from '../../providers/reader-provider-runtime';
import { createReaderRuntime, SYNC_API_BASE_URL_STORAGE_KEY } from '../../repositories/reader-runtime';
import { createAppRuntime } from './app-runtime';

function tauriDesktopRuntime(): PlatformRuntimeInfo {
  return {
    kind: 'tauri-desktop',
    hasTauri: true,
    isMobileWebView: false,
    userAgent: 'NovelDesk test shell',
  };
}

function providerControlClient(): ProviderControlClient {
  return {
    saveProviderSecret: vi.fn(async () => ({ ok: true as const })),
    deleteProviderSecret: vi.fn(async () => ({ ok: true as const })),
    testProviderSecret: vi.fn(async () => ({ ok: true as const })),
  };
}

function workflowGateway(runtime: BookAnalysisWorkflowGateway['runtime'] = 'hosted'): BookAnalysisWorkflowGateway {
  return {
    runtime,
    supportsTTSCacheReadiness: runtime === 'hosted',
    getPlan: vi.fn(),
    start: vi.fn(),
    get: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
  };
}

function nativeTTSCacheGateway(): TTSCacheGateway {
  return {
    runtime: 'native',
    render: vi.fn(),
    inspect: vi.fn(),
  };
}

describe('createAppRuntime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('creates each runtime dependency once and preserves injected instances', () => {
    vi.stubEnv('VITE_READER_BACKEND', 'local');
    vi.stubEnv('VITE_SYNC_API_BASE_URL', '');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const readerRuntime = createReaderRuntime();
    const providerRuntime = createReaderProviderRuntime();
    const platformRuntime = tauriDesktopRuntime();
    const controlClient = providerControlClient();
    const readerRuntimeFactory = vi.fn(() => readerRuntime);
    const providerRuntimeFactory = vi.fn(() => providerRuntime);
    const platformRuntimeDetector = vi.fn(() => platformRuntime);
    const desktopProviderControlClientFactory = vi.fn(() => controlClient);
    const nativeBridge = {} as NativeBookWorkflowBridge;
    const nativeWorkflowGateway = workflowGateway('native');
    const nativeBookWorkflowBridgeFactory = vi.fn(() => nativeBridge);
    const nativeBookAnalysisWorkflowGatewayFactory = vi.fn(() => nativeWorkflowGateway);
    const nativeCacheGateway = nativeTTSCacheGateway();
    const nativeTTSCacheGatewayFactory = vi.fn(() => nativeCacheGateway);

    const runtime = createAppRuntime({
      readerRuntimeFactory,
      providerRuntimeFactory,
      platformRuntimeDetector,
      desktopProviderControlClientFactory,
      nativeBookWorkflowBridgeFactory,
      nativeBookAnalysisWorkflowGatewayFactory,
      nativeTTSCacheGatewayFactory,
    });

    expect(readerRuntimeFactory).toHaveBeenCalledOnce();
    expect(providerRuntimeFactory).toHaveBeenCalledOnce();
    expect(platformRuntimeDetector).toHaveBeenCalledOnce();
    expect(desktopProviderControlClientFactory).toHaveBeenCalledOnce();
    expect(runtime).toMatchObject({
      readerRuntime,
      providerRuntime,
      platformRuntime,
      providerExecutionRuntime: 'desktop',
      providerControlClient: controlClient,
      bookAnalysisWorkflowGateway: nativeWorkflowGateway,
      ttsCacheGateway: nativeCacheGateway,
    });
    expect(nativeBookWorkflowBridgeFactory).toHaveBeenCalledOnce();
    expect(nativeBookAnalysisWorkflowGatewayFactory).toHaveBeenCalledWith(nativeBridge, readerRuntime.readerRepository);
    expect(nativeTTSCacheGatewayFactory).toHaveBeenCalledOnce();
    expect(runtime.defaultAIProvider).toBe(providerRuntime.getDefaultAIProvider());
    expect(runtime.defaultTTSProvider).toBe(providerRuntime.getDefaultTTSProvider());
  });

  it('prefers the connected server control client over the native client', () => {
    vi.stubEnv('VITE_READER_BACKEND', 'local');
    vi.stubEnv('VITE_SYNC_API_BASE_URL', '');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => (key === SYNC_API_BASE_URL_STORAGE_KEY ? 'http://127.0.0.1:8787/api' : null)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const readerRuntime = createReaderRuntime();
    const remoteControlClient = providerControlClient();
    const remoteProviderControlClientFactory = vi.fn(() => remoteControlClient);
    const remoteWorkflowGateway = workflowGateway();
    const remoteBookAnalysisWorkflowGatewayFactory = vi.fn(() => remoteWorkflowGateway);
    const desktopProviderControlClientFactory = vi.fn(providerControlClient);
    const nativeBookWorkflowBridgeFactory = vi.fn(() => ({}) as NativeBookWorkflowBridge);

    const runtime = createAppRuntime({
      readerRuntimeFactory: () => readerRuntime,
      platformRuntimeDetector: tauriDesktopRuntime,
      remoteProviderControlClientFactory,
      remoteBookAnalysisWorkflowGatewayFactory,
      desktopProviderControlClientFactory,
      nativeBookWorkflowBridgeFactory,
    });

    expect(runtime.providerExecutionRuntime).toBe('server');
    expect(runtime.providerApiClient).toBe(readerRuntime.syncApiClient);
    expect(runtime.providerControlClient).toBe(remoteControlClient);
    expect(runtime.bookAnalysisWorkflowGateway).toBe(remoteWorkflowGateway);
    expect(remoteProviderControlClientFactory).toHaveBeenCalledWith(readerRuntime.syncApiClient);
    expect(desktopProviderControlClientFactory).not.toHaveBeenCalled();
    expect(nativeBookWorkflowBridgeFactory).not.toHaveBeenCalled();
    expect(remoteBookAnalysisWorkflowGatewayFactory).toHaveBeenCalledWith(readerRuntime.syncApiClient);
  });
});
