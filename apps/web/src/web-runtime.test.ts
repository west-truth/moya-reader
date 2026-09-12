import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebRuntime } from './web-runtime';
import { SYNC_API_BASE_URL_STORAGE_KEY } from '../../../src/repositories/reader-runtime';
import { IndexedDbReaderRepository } from '../../../src/repositories/indexeddb-reader-repository';
import { BrowserImportService } from '../../../src/services/import/browser-import-service';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('public Web runtime boundary', () => {
  it('ignores legacy server configuration, tokens and a native-looking window', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, navigator: { userAgent: 'Android' } });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === SYNC_API_BASE_URL_STORAGE_KEY ? 'https://legacy.invalid/api' : null),
    });
    vi.stubEnv('VITE_READER_BACKEND', 'remote');
    vi.stubEnv('VITE_SYNC_API_BASE_URL', 'https://env.invalid/api');
    vi.stubEnv('VITE_API_AUTH_TOKEN', 'legacy-token');
    const runtime = createWebRuntime();
    expect(runtime.readerRuntime.mode).toBe('local');
    expect(runtime.readerRuntime.readerRepository).toBeInstanceOf(IndexedDbReaderRepository);
    expect(runtime.readerRuntime.importService).toBeInstanceOf(BrowserImportService);
    expect(runtime.readerRuntime.remoteApiClient).toBeUndefined();
    expect(runtime.readerRuntime.syncApiClient).toBeUndefined();
    expect(runtime.readerRuntime.serverAttachService).toBeUndefined();
    expect(runtime.readerRuntime.syncService).toBeUndefined();
    expect(runtime.providerControlClient).toBeUndefined();
    expect(runtime.bookAnalysisWorkflowGateway).toBeUndefined();
    expect(runtime.providerExecutionRuntime).toBe('none');
    expect(runtime.platformRuntime.kind).toBe('browser');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot silently create fabricated AI output and keeps system speech available', async () => {
    const runtime = createWebRuntime();
    await expect(runtime.defaultAIProvider.labelChapterSegments({} as never)).rejects.toThrow('AI 분석');
    expect(runtime.defaultAIProvider.providerId).not.toContain('mock');
    expect(runtime.providerRuntime.capabilities.map((item) => item.kind)).toEqual(['system_tts']);
    expect(
      runtime.extensionRuntime.trustedExtensions.getReaderAddonTabs().map(({ descriptor }) => descriptor.id),
    ).toEqual(['moya.reader.tools.info']);
    expect(runtime.defaultTTSProvider.providerId).toBe('system');
  });
});
