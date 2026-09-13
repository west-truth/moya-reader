import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceProviderRegistryPort } from './app-external-source-registry';
import { compositeSourceRegistry } from './composite-source-registry';

describe('source provider composition', () => {
  it('keeps trusted providers first and routes optional operations to their owning provider', async () => {
    const provider = (id: `${string}.${string}`) =>
      ({
        getExternalSources: () => [
          {
            descriptor: {
              schemaVersion: 1,
              id,
              title: id,
              kind: 'catalog',
              runtimes: ['self-host-gateway'],
              capabilities: ['browse'],
            },
          },
        ],
        getExternalSourceStatus: () => ({ state: 'connected' }),
        connectExternalSource: vi.fn(async () => {}),
        disconnectExternalSource: vi.fn(async () => {}),
        listExternalSource: vi.fn(async () => ({ items: [] })),
        downloadExternalSource: vi.fn(async () => ({ file: new File(['text'], 'source.txt') })),
        canPickExternalSource: () => true,
        pickExternalSource: vi.fn(async () => ({ selectedCount: 1, addedCount: 1 })),
      }) satisfies ExternalSourceProviderRegistryPort;
    const trusted = provider('moya.trusted');
    const duplicate = provider('moya.trusted');
    const installed = provider('org.installed');
    const combined = compositeSourceRegistry(trusted, duplicate, installed);
    const context = { brokers: { get: () => undefined } };
    expect(combined.getExternalSources()).toHaveLength(2);
    await combined.listExternalSource('moya.trusted', context, {}, new AbortController().signal);
    expect(trusted.listExternalSource).toHaveBeenCalledOnce();
    expect(duplicate.listExternalSource).not.toHaveBeenCalled();
    await combined.pickExternalSource!('org.installed', context);
    expect(installed.pickExternalSource).toHaveBeenCalledOnce();
    expect(combined.canRemoveExternalSourceItem!('org.installed', context)).toBe(false);
    // Removal changes inventory before the old Source Hub selection is reconciled. Reader render must survive.
    installed.getExternalSources = () => [];
    expect(combined.getExternalSourceStatus('org.installed', context).state).toBe('unavailable');
    expect(combined.getExternalSourceConnectionForm!('org.installed', context)).toBeUndefined();
    expect(combined.canPickExternalSource!('org.installed', context)).toBe(false);
    expect(combined.canRemoveExternalSourceItem!('org.installed', context)).toBe(false);
    await expect(combined.pickExternalSource!('org.installed', context)).rejects.toThrow('external_source_unavailable');
    expect(installed.pickExternalSource).toHaveBeenCalledOnce();
  });
});
