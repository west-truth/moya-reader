import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceBroker, ExternalSourceDownloadResult, TrustedExternalSourceHostContext } from './contracts';
import {
  AppExternalSourceRegistry,
  type ExternalSourceRegistryPort,
  type ExternalSourceProviderRegistryPort,
} from './app-external-source-registry';
import { DROPBOX_EXTERNAL_SOURCE_ID, dropboxBuiltInExternalSource } from './dropbox-external-source';

describe('AppExternalSourceRegistry', () => {
  it('keeps Dropbox built in while projecting extension-provided sources separately', async () => {
    const connect = vi.fn(async () => undefined);
    const pickItems = vi.fn(async () => ({ selectedCount: 1, addedCount: 1 }));
    const removeSelectedItem = vi.fn(async () => undefined);
    const broker: ExternalSourceBroker = {
      status: () => ({ state: 'disconnected', label: 'Dropbox' }),
      connectionForm: () => ({
        fields: [{ id: 'endpoint', label: '서버 주소', type: 'text', required: true }],
      }),
      connect,
      disconnect: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ items: [] })),
      download: vi.fn(),
      pickItems,
      removeSelectedItem,
    };
    const context: TrustedExternalSourceHostContext = {
      brokers: { get: (id) => (id === 'dropbox' ? broker : undefined) },
    };
    const pluginId = 'community.catalog' as ExtensionContributionId;
    const pluginPort = {
      getExternalSources: () => [
        {
          descriptor: {
            id: pluginId,
            schemaVersion: 1,
            title: '커뮤니티 카탈로그',
            kind: 'catalog',
            capabilities: ['browse'],
            runtimes: ['web-direct'],
          },
        },
      ],
    } as unknown as ExternalSourceRegistryPort;
    const registry = new AppExternalSourceRegistry([dropboxBuiltInExternalSource], pluginPort);

    expect(registry.getExternalSources()).toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: DROPBOX_EXTERNAL_SOURCE_ID }),
        origin: 'built_in',
      }),
      expect.objectContaining({ descriptor: expect.objectContaining({ id: pluginId }), origin: 'plugin' }),
    ]);

    expect(registry.getExternalSourceConnectionForm(DROPBOX_EXTERNAL_SOURCE_ID, context)).toEqual(
      expect.objectContaining({ fields: [expect.objectContaining({ id: 'endpoint' })] }),
    );
    await registry.connectExternalSource(DROPBOX_EXTERNAL_SOURCE_ID, context, { endpoint: 'http://127.0.0.1:4567' });
    expect(connect).toHaveBeenCalledWith({ endpoint: 'http://127.0.0.1:4567' });
    expect(registry.canPickExternalSource(DROPBOX_EXTERNAL_SOURCE_ID, context)).toBe(true);
    await expect(registry.pickExternalSource(DROPBOX_EXTERNAL_SOURCE_ID, context)).resolves.toEqual({
      selectedCount: 1,
      addedCount: 1,
    });
    const key = {
      connectorId: DROPBOX_EXTERNAL_SOURCE_ID,
      accountConnectionId: 'dropbox:test',
      remoteId: 'remote-file',
    };
    expect(registry.canRemoveExternalSourceItem(DROPBOX_EXTERNAL_SOURCE_ID, context)).toBe(true);
    await registry.removeExternalSourceItem(DROPBOX_EXTERNAL_SOURCE_ID, context, key);
    expect(removeSelectedItem).toHaveBeenCalledWith(key);
  });
});

describe('app source v2 boundary', () => {
  const profile = { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' } as const;
  const descriptor = {
    id: 'test.text' as const,
    schemaVersion: 2 as const,
    title: 'Text',
    kind: 'catalog' as const,
    capabilities: ['browse', 'release-list', 'release-download', 'document-content'] as const,
    runtimes: ['web-direct'] as const,
    seriesProfile: profile,
  };
  const key = { connectorId: descriptor.id, accountConnectionId: 'account', remoteId: 'release' };
  const ref = { key, fileName: 'chapter.txt', context: { expectedProfile: profile, connectionGeneration: 'g1' } };
  const file = new File(['text'], 'chapter.txt');
  const result = {
    content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
  } as const;

  function harness(plugin = false) {
    const state = { generation: 'g1' };
    const broker: ExternalSourceBroker = {
      status: () => ({ state: 'connected', accountConnectionId: 'account', connectionGeneration: state.generation }),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ items: [] })),
      download: vi.fn(async (): Promise<ExternalSourceDownloadResult> => result),
    };
    const context: TrustedExternalSourceHostContext = { brokers: { get: () => broker } };
    const provider: ExternalSourceProviderRegistryPort = {
      getExternalSources: () => [{ descriptor }],
      getExternalSourceStatus: () => broker.status(),
      connectExternalSource: async () => broker.connect(),
      disconnectExternalSource: async () => broker.disconnect(),
      listExternalSource: async (_id, _context, input, signal) => broker.list(input, signal),
      downloadExternalSource: async (_id, _context, input, signal) => broker.download(input, signal),
    };
    return {
      state,
      broker,
      context,
      registry: new AppExternalSourceRegistry(
        plugin ? [] : [{ descriptor, brokerId: 'text' }],
        plugin ? provider : undefined,
      ),
    };
  }

  it.each([false, true])('normalizes %s plugin and built-in downloads through the same boundary', async (plugin) => {
    const { registry, context } = harness(plugin);
    const downloaded = await registry.downloadExternalSource(descriptor.id, context, ref, new AbortController().signal);
    expect(downloaded.file).toBe(file);
    expect(downloaded.content).toEqual(result.content);
  });

  it('rejects stale generation and wrong source before calling a provider', async () => {
    const { registry, context, broker } = harness();
    const signal = new AbortController().signal;
    await expect(
      registry.downloadExternalSource(
        descriptor.id,
        context,
        { ...ref, context: { connectionGeneration: 'old' } },
        signal,
      ),
    ).rejects.toThrow('연결');
    await expect(
      registry.downloadExternalSource(
        descriptor.id,
        context,
        { ...ref, key: { ...key, connectorId: 'other.source' } },
        signal,
      ),
    ).rejects.toThrow('연결');
    expect(broker.download).not.toHaveBeenCalled();
  });

  it.each(['generation', 'reconnect', 'abort'] as const)('discards a completed download after %s', async (change) => {
    const { registry, context, broker, state } = harness();
    let finish!: (value: ExternalSourceDownloadResult) => void;
    vi.mocked(broker.download).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const abort = new AbortController();
    const pending = registry.downloadExternalSource(descriptor.id, context, ref, abort.signal);
    if (change === 'generation') state.generation = 'g2';
    if (change === 'reconnect') await registry.connectExternalSource(descriptor.id, context);
    if (change === 'abort') abort.abort();
    finish(result);
    await expect(pending).rejects.toThrow();
  });
});
