import {
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TrustedExtensionRegistry, type TrustedExtensionDefinition } from './trusted-extension-registry';

interface TestReaderContext {
  readonly bookTitle: string;
}

interface TestAnalysisContext {
  readonly enabled: boolean;
  readonly bookId: string;
}

function manifest(
  id: `test.${string}`,
  options: { command?: boolean; workflow?: boolean; enrichment?: boolean; externalSource?: boolean } = {},
): ExtensionManifestV1 {
  return {
    manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
    id,
    name: id,
    version: '1.0.0',
    engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
    permissions: [
      'reader.addon.render',
      'reader.context.read',
      ...(options.command ? (['app.command.execute'] as const) : []),
      ...(options.workflow ? (['analysis.workflow.execute'] as const) : []),
      ...(options.enrichment ? (['book.enrichment.propose'] as const) : []),
      ...(options.externalSource ? (['external.source.list', 'external.source.download'] as const) : []),
    ],
    contributes: {
      readerAddonTabs: [{ id: `${id}.panel`, label: id, icon: 'file-text', order: 20 }],
      commands: options.command ? [{ id: `${id}.run`, title: 'Run' }] : undefined,
      analysisWorkflows: options.workflow
        ? [
            {
              id: `${id}.workflow`,
              schemaVersion: 1,
              title: 'Analyze',
              target: 'chapter-bundle',
              order: 30,
            },
          ]
        : undefined,
      bookEnrichmentProviders: options.enrichment
        ? [
            {
              id: `${id}.enrichment`,
              schemaVersion: 1,
              title: 'Enrich',
              capabilities: ['metadata'],
            },
          ]
        : undefined,
      externalSources: options.externalSource
        ? [
            {
              id: `${id}.source`,
              schemaVersion: 1,
              title: 'External source',
              kind: 'cloud_file',
              capabilities: ['browse', 'file-download'],
              runtimes: ['web-direct'],
            },
          ]
        : undefined,
    },
  };
}

describe('TrustedExtensionRegistry', () => {
  it('registers a v2 document source without exposing credentials in its payload', async () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    const profile = { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' } as const;
    const file = new File(['1화 본문'], 'chapter.txt');
    const payload = {
      content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
    } as const;
    const definition: TrustedExtensionDefinition<TestReaderContext> = {
      manifest: {
        ...manifest('test.text', { externalSource: true }),
        contributes: {
          externalSources: [
            {
              id: 'test.text.source',
              schemaVersion: 2,
              title: 'Text',
              kind: 'catalog',
              capabilities: ['browse', 'release-list', 'release-download', 'document-content'],
              runtimes: ['self-host-gateway'],
              seriesProfile: profile,
            },
          ],
        },
      },
      activate: (host) =>
        host.externalSources.register('test.text.source', {
          status: () => ({ state: 'connected', accountConnectionId: 'account' }),
          connect: async () => undefined,
          disconnect: async () => undefined,
          list: async () => ({ items: [] }),
          download: async () => payload,
        }),
    };
    expect(registry.register(definition)).toBe(true);
    registry.activateAll();
    expect(registry.getExternalSources()[0]?.descriptor.schemaVersion).toBe(2);
    await expect(
      registry.downloadExternalSource(
        'test.text.source',
        { brokers: { get: () => undefined } },
        {
          key: { connectorId: 'test.text.source', accountConnectionId: 'account', remoteId: 'chapter' },
          fileName: file.name,
          context: { expectedProfile: profile },
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(payload);
  });

  it('activates a declared reader addon and renders with host-owned context', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    const definition: TrustedExtensionDefinition<TestReaderContext> = {
      manifest: manifest('test.reader'),
      activate: (host) =>
        host.readerAddons.register('test.reader.panel', (context) => <strong>{context.bookTitle}</strong>),
    };

    expect(registry.register(definition)).toBe(true);
    registry.activateAll();

    const addon = registry.getReaderAddon('test.reader.panel');
    expect(addon?.descriptor.label).toBe('test.reader');
    expect(renderToStaticMarkup(<>{addon?.render({ bookTitle: '작품' })}</>)).toContain('작품');
    expect(registry.getSnapshots()).toContainEqual(expect.objectContaining({ id: 'test.reader', state: 'active' }));
  });

  it('rejects duplicate extension identities without replacing the first registration', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    const definition: TrustedExtensionDefinition<TestReaderContext> = {
      manifest: manifest('test.duplicate'),
      activate: () => undefined,
    };

    expect(registry.register(definition)).toBe(true);
    expect(registry.register(definition)).toBe(false);
    expect(registry.getSnapshots()).toHaveLength(1);
    expect(registry.getDiagnostics()[0]?.message).toContain('Duplicate trusted extension id');
  });

  it('isolates activation failure and removes partially registered contributions', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    registry.register({
      manifest: manifest('test.failure'),
      activate: (host) => {
        host.readerAddons.register('test.failure.panel', () => <span>should be removed</span>);
        throw new Error('activation exploded');
      },
    });
    registry.register({
      manifest: manifest('test.healthy'),
      activate: (host) => host.readerAddons.register('test.healthy.panel', () => <span>healthy</span>),
    });

    registry.activateAll();

    expect(registry.getReaderAddon('test.failure.panel')).toBeUndefined();
    expect(registry.getReaderAddon('test.healthy.panel')).toBeDefined();
    expect(registry.getSnapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'test.failure', state: 'failed', errorMessage: 'activation exploded' }),
        expect.objectContaining({ id: 'test.healthy', state: 'active' }),
      ]),
    );
  });

  it('fails closed when activation uses a capability that was not declared', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    registry.register({
      manifest: { ...manifest('test.permissions'), permissions: [] },
      activate: (host) => host.readerAddons.register('test.permissions.panel', () => <span>blocked</span>),
    });

    registry.activateAll();

    expect(registry.getReaderAddonTabs()).toHaveLength(0);
    expect(registry.getSnapshots()).toContainEqual(
      expect.objectContaining({
        id: 'test.permissions',
        state: 'failed',
        errorMessage: expect.stringContaining('reader.addon.render'),
      }),
    );
  });

  it('registers commands and removes all contributions when disabled', async () => {
    const handler = vi.fn((value: unknown) => `handled:${String(value)}`);
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    registry.register({
      manifest: manifest('test.commands', { command: true }),
      activate: (host) => {
        host.readerAddons.register('test.commands.panel', () => <span>commands</span>);
        host.commands.register('test.commands.run', handler);
      },
    });
    registry.activateAll();

    await expect(registry.executeCommand('test.commands.run', 'value')).resolves.toBe('handled:value');
    expect(handler).toHaveBeenCalledWith('value');
    expect(registry.disable('test.commands')).toBe(true);
    expect(registry.getReaderAddonTabs()).toHaveLength(0);
    await expect(registry.executeCommand('test.commands.run')).rejects.toThrow('unavailable');
  });

  it('dispatches an enabled analysis workflow and removes it when disabled', async () => {
    const run = vi.fn(({ bookId }: TestAnalysisContext) => `analyzed:${bookId}`);
    const registry = new TrustedExtensionRegistry<TestReaderContext, TestAnalysisContext>();
    registry.register({
      manifest: manifest('test.analysis', { workflow: true }),
      activate: (host) => {
        host.readerAddons.register('test.analysis.panel', () => <span>analysis</span>);
        host.analysisWorkflows.register('test.analysis.workflow', {
          isEnabled: ({ enabled }) => enabled,
          run,
        });
      },
    });
    registry.activateAll();

    expect(registry.getAnalysisWorkflow('test.analysis.workflow')?.descriptor.title).toBe('Analyze');
    await expect(
      registry.executeAnalysisWorkflow('test.analysis.workflow', { enabled: true, bookId: 'book-1' }),
    ).resolves.toBe('analyzed:book-1');
    await expect(
      registry.executeAnalysisWorkflow('test.analysis.workflow', { enabled: false, bookId: 'book-1' }),
    ).rejects.toThrow('unavailable');
    expect(registry.disable('test.analysis')).toBe(true);
    expect(registry.getAnalysisWorkflows()).toEqual([]);
  });

  it('propagates workflow execution errors without failing the activated extension', async () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext, TestAnalysisContext>();
    registry.register({
      manifest: manifest('test.analysis-error', { workflow: true }),
      activate: (host) => {
        host.readerAddons.register('test.analysis-error.panel', () => <span>analysis</span>);
        host.analysisWorkflows.register('test.analysis-error.workflow', {
          run: () => {
            throw new Error('workflow failed');
          },
        });
      },
    });
    registry.activateAll();

    await expect(
      registry.executeAnalysisWorkflow('test.analysis-error.workflow', { enabled: true, bookId: 'book-1' }),
    ).rejects.toThrow('workflow failed');
    expect(registry.getSnapshots()).toContainEqual(
      expect.objectContaining({ id: 'test.analysis-error', state: 'active' }),
    );
  });

  it('renders a managed workflow surface and removes it when the extension is disabled', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext, TestAnalysisContext>();
    const actionManifest = manifest('test.managed', { workflow: true });
    registry.register({
      manifest: {
        ...actionManifest,
        contributes: {
          ...actionManifest.contributes,
          analysisWorkflows: actionManifest.contributes?.analysisWorkflows?.map((workflow) => ({
            ...workflow,
            target: 'book' as const,
            kind: 'managed' as const,
          })),
        },
      },
      activate: (host) => {
        host.readerAddons.register('test.managed.panel', () => <span>analysis</span>);
        host.analysisWorkflows.register('test.managed.workflow', {
          isEnabled: ({ enabled }) => enabled,
          render: ({ bookId }) => <strong>{bookId}</strong>,
        });
      },
    });
    registry.activateAll();

    expect(
      renderToStaticMarkup(
        <>{registry.renderAnalysisWorkflow('test.managed.workflow', { enabled: true, bookId: 'book-1' })}</>,
      ),
    ).toContain('book-1');
    expect(() =>
      registry.renderAnalysisWorkflow('test.managed.workflow', { enabled: false, bookId: 'book-1' }),
    ).toThrow('unavailable');
    expect(registry.disable('test.managed')).toBe(true);
    expect(registry.getAnalysisWorkflow('test.managed.workflow')).toBeUndefined();
  });

  it('fails closed when a managed workflow omits its render surface', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext, TestAnalysisContext>();
    const actionManifest = manifest('test.invalid-managed', { workflow: true });
    registry.register({
      manifest: {
        ...actionManifest,
        contributes: {
          ...actionManifest.contributes,
          analysisWorkflows: actionManifest.contributes?.analysisWorkflows?.map((workflow) => ({
            ...workflow,
            target: 'book' as const,
            kind: 'managed' as const,
          })),
        },
      },
      activate: (host) => host.analysisWorkflows.register('test.invalid-managed.workflow', { run: () => undefined }),
    });
    registry.activateAll();

    expect(registry.getAnalysisWorkflow('test.invalid-managed.workflow')).toBeUndefined();
    expect(registry.getSnapshots()).toContainEqual(
      expect.objectContaining({
        id: 'test.invalid-managed',
        state: 'failed',
        errorMessage: expect.stringContaining('must register render()'),
      }),
    );
  });

  it('fails activation when an analysis workflow permission is missing', () => {
    const registry = new TrustedExtensionRegistry<TestReaderContext, TestAnalysisContext>();
    const workflowManifest = manifest('test.analysis-permission', { workflow: true });
    registry.register({
      manifest: {
        ...workflowManifest,
        permissions: workflowManifest.permissions.filter((permission) => permission !== 'analysis.workflow.execute'),
      },
      activate: (host) =>
        host.analysisWorkflows.register('test.analysis-permission.workflow', { run: () => undefined }),
    });
    registry.activateAll();

    expect(registry.getAnalysisWorkflows()).toEqual([]);
    expect(registry.getSnapshots()).toContainEqual(
      expect.objectContaining({
        id: 'test.analysis-permission',
        state: 'failed',
        errorMessage: expect.stringContaining('analysis.workflow.execute'),
      }),
    );
  });

  it('dispatches bounded book enrichment proposals and removes the provider when disabled', async () => {
    const propose = vi.fn(() => [{ kind: 'metadata' as const, patch: { author: '작가' } }]);
    const registry = new TrustedExtensionRegistry<TestReaderContext, TestAnalysisContext>();
    registry.register({
      manifest: manifest('test.enrichment', { enrichment: true }),
      activate: (host) => host.bookEnrichmentProviders.register('test.enrichment.enrichment', { propose }),
    });
    registry.activateAll();

    const context = {
      book: {
        bookId: 'book-1',
        metadataRevision: 2,
        title: '작품',
        tags: [],
        cover: { present: false },
      },
    };
    await expect(registry.executeBookEnrichmentProvider('test.enrichment.enrichment', context)).resolves.toEqual([
      { kind: 'metadata', patch: { author: '작가' } },
    ]);
    expect(propose).toHaveBeenCalledWith(context);
    expect(registry.getBookEnrichmentProviders()[0]).toMatchObject({
      extensionId: 'test.enrichment',
      extensionVersion: '1.0.0',
    });
    registry.disable('test.enrichment');
    expect(registry.getBookEnrichmentProviders()).toEqual([]);
  });

  it('fails closed when a book enrichment permission is missing', () => {
    const enrichmentManifest = manifest('test.enrichment-permission', { enrichment: true });
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    registry.register({
      manifest: {
        ...enrichmentManifest,
        permissions: enrichmentManifest.permissions.filter((permission) => permission !== 'book.enrichment.propose'),
      },
      activate: (host) =>
        host.bookEnrichmentProviders.register('test.enrichment-permission.enrichment', { propose: () => [] }),
    });
    registry.activateAll();
    expect(registry.getBookEnrichmentProviders()).toEqual([]);
    expect(registry.getSnapshots()).toContainEqual(
      expect.objectContaining({
        id: 'test.enrichment-permission',
        state: 'failed',
        errorMessage: expect.stringContaining('book.enrichment.propose'),
      }),
    );
  });

  it('dispatches an external source only through the host-owned broker and removes it when disabled', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: 'next' });
    const downloaded = { file: {} as File, remoteRevision: 'rev-1' };
    const download = vi.fn().mockResolvedValue(downloaded);
    const broker = {
      status: vi.fn(() => ({ state: 'connected' as const, label: 'Dropbox' })),
      connect,
      disconnect,
      list,
      download,
    };
    const hostContext = { brokers: { get: vi.fn(() => broker) } };
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    registry.register({
      manifest: manifest('test.external', { externalSource: true }),
      activate: (host) =>
        host.externalSources.register('test.external.source', {
          status: (context) => context.brokers.get('test')!.status(),
          connect: (context) => context.brokers.get('test')!.connect(),
          disconnect: (context) => context.brokers.get('test')!.disconnect(),
          list: (context, input, signal) => context.brokers.get('test')!.list(input, signal),
          download: (context, ref, signal) => context.brokers.get('test')!.download(ref, signal),
        }),
    });
    registry.activateAll();

    const abort = new AbortController();
    const ref = {
      key: { connectorId: 'test', remoteId: 'remote-1' },
      fileName: 'novel.txt',
    };
    expect(registry.getExternalSources()[0]).toMatchObject({
      extensionId: 'test.external',
      extensionVersion: '1.0.0',
      descriptor: { id: 'test.external.source', kind: 'cloud_file' },
    });
    expect(registry.getExternalSourceStatus('test.external.source', hostContext)).toEqual({
      state: 'connected',
      label: 'Dropbox',
    });
    await registry.connectExternalSource('test.external.source', hostContext);
    await expect(
      registry.listExternalSource('test.external.source', hostContext, { query: 'novel' }, abort.signal),
    ).resolves.toEqual({ items: [], nextCursor: 'next' });
    await expect(registry.downloadExternalSource('test.external.source', hostContext, ref, abort.signal)).resolves.toBe(
      downloaded,
    );
    await registry.disconnectExternalSource('test.external.source', hostContext);
    expect(connect).toHaveBeenCalledWith();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({ query: 'novel' }, abort.signal);
    expect(download).toHaveBeenCalledWith(ref, abort.signal);

    registry.disable('test.external');
    expect(registry.getExternalSources()).toEqual([]);
    expect(() => registry.getExternalSourceStatus('test.external.source', hostContext)).toThrow('unavailable');
  });

  it('fails closed when an external source permission is missing', () => {
    const externalManifest = manifest('test.external-permission', { externalSource: true });
    const registry = new TrustedExtensionRegistry<TestReaderContext>();
    registry.register({
      manifest: {
        ...externalManifest,
        permissions: externalManifest.permissions.filter((permission) => permission !== 'external.source.download'),
      },
      activate: (host) =>
        host.externalSources.register('test.external-permission.source', {
          status: () => ({ state: 'disconnected' }),
          connect: async () => undefined,
          disconnect: async () => undefined,
          list: async () => ({ items: [] }),
          download: async () => ({ file: {} as File }),
        }),
    });
    registry.activateAll();

    expect(registry.getExternalSources()).toEqual([]);
    expect(registry.getSnapshots()).toContainEqual(
      expect.objectContaining({
        id: 'test.external-permission',
        state: 'failed',
        errorMessage: expect.stringContaining('external.source.download'),
      }),
    );
  });
});
