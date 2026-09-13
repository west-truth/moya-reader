import { compatibilityFileUpload } from './compatibility-file';
import type { InstalledSourceCatalogPort } from '../../external-sources/installed-package-source-registry';
import type { InstalledSource } from './package-runtime-catalog';
import type { ApkExtensionManager, ApkManagerSnapshot, ApkInstallReview } from './apk-extension-manager';
import {
  validateSourceResult,
  type SourceMethod,
  type SourceResults,
} from '@noveldesk/extension-contracts/source-protocol';
import { packageSha256 } from './package-archive';
import type { SourceAsset } from '@noveldesk/extension-contracts/source-sdk';

export interface NativeApkTransport {
  request(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  invoke(
    id: string,
    method: SourceMethod,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ result: unknown; assets: ReadonlyMap<string, Blob> }>;
}
export class NativeApkCatalog implements InstalledSourceCatalogPort {
  private sources: readonly InstalledSource[] = [];
  private listeners = new Set<() => void>();
  readonly manager: ApkExtensionManager;
  constructor(
    private readonly transport: NativeApkTransport,
    changed: () => Promise<void>,
  ) {
    const action = async (input: Record<string, unknown>, signal?: AbortSignal) => {
      await transport.request(input, signal);
      await changed();
    };
    this.manager = {
      preferences: (pkg) =>
        transport.request({ action: 'preferences', pkg }) as Promise<
          import('./compatibility-preferences').CompatibilityPreferences
        >,
      savePreferences: (pkg, revision, values, privateOrigins) =>
        action({ action: 'preferences-save', pkg, revision, values, privateOrigins }),
      list: () => transport.request({ action: 'list' }) as Promise<ApkManagerSnapshot>,
      refreshRepository: async (url, signal) => {
        await transport.request({ action: 'repository-refresh', url }, signal);
      },
      removeRepository: async (url) => {
        await transport.request({ action: 'repository-remove', url });
      },
      inspectFile: async (file, signal, sourceIndex) =>
        transport.request(
          { action: 'inspect-file', ...(await compatibilityFileUpload(file, sourceIndex)) },
          signal,
        ) as Promise<ApkInstallReview>,
      inspectRepository: (url, pkg, code, signal) =>
        transport.request({ action: 'inspect', url, pkg, code }, signal) as Promise<ApkInstallReview>,
      discardReview: async (id) => {
        await transport.request({ action: 'discard', id });
      },
      install: (review, signal) =>
        action({ action: 'install', id: review.id, revision: review.revision, trusted: true }, signal),
      change: (pkg, revision, change) => action({ action: 'change', pkg, revision, change }),
    };
  }
  getSources = () => this.sources;
  getSource = (id: string) => this.sources.find((source) => source.descriptor.id === id);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async refresh() {
    const value = (await this.transport.request({ action: 'list' })) as ApkManagerSnapshot & {
      sources: InstalledSource[];
    };
    const next = value.available && Array.isArray(value.sources) ? value.sources : [];
    if (JSON.stringify(this.sources) === JSON.stringify(next)) return;
    this.sources = next;
    for (const listener of this.listeners) listener();
  }
  async disable(id: string) {
    const source = this.getSource(id);
    if (!source) return;
    const inventory = await this.manager.list();
    await this.manager.change(source.packageId, inventory.revision, 'disable');
  }
  async invoke<M extends SourceMethod>(
    id: string,
    method: M,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ result: SourceResults[M]; assets: ReadonlyMap<string, Blob> }> {
    const generation = this.getSource(id)?.generation;
    if (!generation) throw new Error('package_source_unavailable');
    const value = await this.transport.invoke(id, method, input, signal);
    signal.throwIfAborted();
    if (this.getSource(id)?.generation !== generation) throw new Error('package_generation_changed');
    if (!validateSourceResult(method, value.result)) throw new Error('invalid_source_result');
    const refs: SourceAsset[] = [];
    if (method === 'source.getCover' && validateSourceResult('source.getCover', value.result) && value.result)
      refs.push(value.result);
    if (method === 'source.getContent' && validateSourceResult('source.getContent', value.result)) {
      const textSource = this.getSource(id)?.descriptor.seriesProfile?.kind === 'document_series';
      if (textSource !== (value.result.kind === 'text')) throw new Error('invalid_source_result');
      if (value.result.kind === 'text') refs.push(value.result.asset);
      else refs.push(...value.result.assets);
    }
    if (value.assets.size !== refs.length) throw new Error('invalid_source_assets');
    for (const ref of refs) {
      const blob = value.assets.get(ref.handle);
      if (
        !blob ||
        blob.size !== ref.byteLength ||
        blob.type !== ref.contentType ||
        (await packageSha256(new Uint8Array(await blob.arrayBuffer()))) !== ref.sha256
      )
        throw new Error('invalid_source_assets');
      signal.throwIfAborted();
    }
    return { result: value.result, assets: value.assets };
  }
  dispose() {
    this.sources = [];
    this.listeners.clear();
  }
}
