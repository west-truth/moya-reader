import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceBroker, TrustedExternalSourceHostContext } from './contracts';
import { AppExternalSourceRegistry, type ExternalSourceRegistryPort } from './app-external-source-registry';
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
