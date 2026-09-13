import type { ExternalSourceContributionDescriptorV2, ExternalSourceRuntime } from '@noveldesk/extension-contracts';
import {
  validateSourceInput,
  validateSourceResult,
  type SourceMethod,
  type SourceResults,
} from '@noveldesk/extension-contracts/source-protocol';
import type { SourceAsset, SourceContent } from '@noveldesk/extension-contracts/source-sdk';
import { packageSha256, verifyMoyaExtension, type VerifiedMoyaPackage } from './package-archive';
import type { PackageInstallStore } from './package-install-store';
import { PackageInstaller } from './package-installer';
import type { SourceStateValues, SourceStateChanges } from './source-state';
import type { RepositoryEntry, RepositoryIndex } from './repository-contract';
import type { SourceAuthenticationRequest, SourceAuthenticationStatus } from '@noveldesk/extension-contracts/package';
import type {
  ContentConnectionRequest,
  ContentConnectionStatus,
} from '../../../packages/extension-contracts/source-content-service';

/** Platform implementation owns code execution, granted network authority and asset transfer. Never supplied by guests. */
export interface PackageExecutionPort {
  preferences?(
    pkg: VerifiedMoyaPackage,
    sourceId: string,
    epoch: string,
    request: import('../../../packages/extension-contracts/source-preferences').SourcePreferencesRequest,
    signal: AbortSignal,
  ): Promise<import('./compatibility-preferences').CompatibilityPreferences>;
  contentConnection?(
    pkg: VerifiedMoyaPackage,
    sourceId: string,
    epoch: string,
    request: ContentConnectionRequest,
    signal: AbortSignal,
  ): Promise<ContentConnectionStatus>;
  listRepository?(url: string, signal: AbortSignal): Promise<RepositoryIndex>;
  downloadRepository?(url: string, entry: RepositoryEntry, signal: AbortSignal): Promise<Blob>;
  checkUpdate?(pkg: VerifiedMoyaPackage, signal: AbortSignal): Promise<Blob | undefined>;
  retainAuthentication?(packageId: string, epoch: string | undefined): void | Promise<void>;
  authenticate?(
    pkg: VerifiedMoyaPackage,
    sourceId: string,
    epoch: string,
    request: SourceAuthenticationRequest,
    signal: AbortSignal,
  ): Promise<SourceAuthenticationStatus>;
  readonly runtime: ExternalSourceRuntime;
  prepare(pkg: VerifiedMoyaPackage, signal?: AbortSignal): Promise<void>;
  invoke(
    pkg: VerifiedMoyaPackage,
    method: SourceMethod,
    input: Record<string, unknown>,
    signal: AbortSignal,
    state?: SourceStateValues,
    credentialEpoch?: string,
  ): Promise<{
    readonly result: unknown;
    readonly assets: ReadonlyMap<string, Blob>;
    readonly stateChanges?: SourceStateChanges;
  }>;
}

interface ActivePackage {
  readonly credentialEpoch?: string;
  readonly pkg: VerifiedMoyaPackage;
  readonly revision: number;
  readonly lifetime: AbortController;
}

export interface InstalledSource {
  readonly packageId: string;
  readonly generation: string;
  readonly descriptor: ExternalSourceContributionDescriptorV2;
}

/** Version changes cancel only this package's invocations. Readers and downloaded library data are not owned here. */
export class PackageRuntimeCatalog {
  private active = new Map<string, ActivePackage>();
  private sources: readonly InstalledSource[] = [];
  private listeners = new Set<() => void>();
  private refreshEpoch = 0;
  private pendingRefresh?: Promise<void>;
  private refreshRequested = false;
  private disposed = false;
  private retainedCredentials = new Map<string, string | undefined>();
  private errors: readonly { packageId: string; code: 'package_activation_failed' }[] = [];
  readonly installer: PackageInstaller;

  constructor(
    private readonly store: PackageInstallStore,
    private readonly execution: PackageExecutionPort,
  ) {
    this.installer = new PackageInstaller(store, (pkg, signal) => execution.prepare(pkg, signal));
  }

  getSources = (): readonly InstalledSource[] => this.sources;
  getErrors = () => this.errors;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async refresh(): Promise<void> {
    if (this.disposed) throw new Error('package_runtime_closed');
    this.refreshRequested = true;
    if (!this.pendingRefresh) {
      this.pendingRefresh = (async () => {
        try {
          // All callers wait for activation. A change during preparation requests another inventory read.
          while (this.refreshRequested && !this.disposed) {
            this.refreshRequested = false;
            await this.refreshOnce();
          }
        } finally {
          this.pendingRefresh = undefined;
        }
      })();
    }
    await this.pendingRefresh;
  }

  private async refreshOnce(): Promise<void> {
    const epoch = ++this.refreshEpoch;
    const records = await this.store.list();
    if (this.disposed || epoch !== this.refreshEpoch) return;
    // Invalidate stale work as soon as the new inventory is known, before potentially slow prepare calls.
    for (const [id, active] of this.active) {
      const next = records.find((record) => record.id === id);
      if (
        !next?.enabled ||
        !next.active ||
        next.revision !== active.revision ||
        next.active.digest !== active.pkg.digest
      )
        active.lifetime.abort();
    }
    const next = new Map<string, ActivePackage>();
    for (const record of records) {
      const epoch = record.active ? record.credentialEpoch : undefined;
      if (!this.retainedCredentials.has(record.id) || this.retainedCredentials.get(record.id) !== epoch) {
        await this.execution.retainAuthentication?.(record.id, epoch);
        this.retainedCredentials.set(record.id, epoch);
      }
    }
    const errors: { packageId: string; code: 'package_activation_failed' }[] = [];
    for (const record of records) {
      if (!record.enabled || !record.active) continue;
      const old = this.active.get(record.id);
      if (old && old.revision === record.revision && !old.lifetime.signal.aborted) {
        next.set(record.id, old);
        continue;
      }
      try {
        const stored = await this.store.read(record.id);
        if (!stored?.active || !stored.enabled || stored.revision !== record.revision)
          throw new Error('package_generation_changed');
        const pkg = await verifyMoyaExtension(stored.active.archive);
        if (pkg.digest !== record.active.digest || pkg.manifest.extension.id !== record.id)
          throw new Error('package_storage_integrity');
        await this.execution.prepare(pkg);
        if (this.disposed || epoch !== this.refreshEpoch) return;
        next.set(record.id, {
          pkg,
          revision: record.revision,
          credentialEpoch: record.credentialEpoch,
          lifetime: new AbortController(),
        });
      } catch {
        errors.push({ packageId: record.id, code: 'package_activation_failed' });
      }
    }
    if (this.disposed || epoch !== this.refreshEpoch) return;
    this.active = next;
    const sources = [...next.values()].flatMap(({ pkg, revision }) =>
      (pkg.manifest.extension.contributes?.externalSources ?? []).flatMap((descriptor) =>
        descriptor.schemaVersion === 2 && descriptor.runtimes.includes(this.execution.runtime)
          ? [
              {
                packageId: pkg.manifest.extension.id,
                generation: `${revision}:${pkg.digest}`,
                descriptor,
              },
            ]
          : [],
      ),
    );
    if (
      JSON.stringify(sources) !== JSON.stringify(this.sources) ||
      JSON.stringify(errors) !== JSON.stringify(this.errors)
    ) {
      this.sources = sources;
      this.errors = errors;
      for (const listener of this.listeners) listener();
    }
  }

  getSource(id: string): InstalledSource | undefined {
    const source = this.sources.find((entry) => entry.descriptor.id === id);
    return source && !this.active.get(source.packageId)?.lifetime.signal.aborted ? source : undefined;
  }

  async disable(sourceId: string): Promise<void> {
    const source = this.getSource(sourceId);
    if (!source) return;
    const record = await this.store.read(source.packageId);
    if (!record) throw new Error('package_source_unavailable');
    await this.installer.setEnabled(source.packageId, record.revision, false);
    await this.refresh();
  }

  async invoke<M extends SourceMethod>(
    sourceId: string,
    method: M,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    result: SourceResults[M];
    assets: ReadonlyMap<string, Blob>;
  }> {
    signal.throwIfAborted();
    const source = this.getSource(sourceId);
    const active = source && this.active.get(source.packageId);
    if (!source || !active) throw new Error('package_source_unavailable');
    const request = { ...input, sourceId };
    if (!validateSourceInput(method, request)) throw new Error('invalid_source_invocation');
    const joined = new AbortController();
    const cancel = () => joined.abort();
    signal.addEventListener('abort', cancel, { once: true });
    active.lifetime.signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted || active.lifetime.signal.aborted) cancel();
    const current = () => {
      joined.signal.throwIfAborted();
      if (this.active.get(source.packageId) !== active) throw new Error('package_generation_changed');
    };
    try {
      const usesStorage = active.pkg.manifest.requestedAccess.storageKiB > 0;
      if (usesStorage && (!this.store.readSourceState || !this.store.commitSourceState))
        throw new Error('unsupported_source_storage');
      const state = usesStorage
        ? await this.store.readSourceState!(source.packageId, sourceId, active.revision)
        : undefined;
      current();
      const response = await this.execution.invoke(
        active.pkg,
        method,
        request,
        joined.signal,
        state,
        active.credentialEpoch,
      );
      current();
      if (!validateSourceResult(method, response.result)) throw new Error('invalid_source_result');
      if (method === 'source.getWork' && (response.result as { id: string }).id !== input.workId)
        throw new Error('source_work_mismatch');
      const content = method === 'source.getContent' ? (response.result as SourceContent) : undefined;
      if (
        content &&
        (source.descriptor.seriesProfile?.kind === 'document_series'
          ? content.kind !== 'text'
          : content.kind !== 'images')
      )
        throw new Error('source_content_profile_mismatch');
      const refs = content
        ? content.kind === 'text'
          ? [content.asset]
          : content.assets
        : method === 'source.getCover' && response.result
          ? [response.result as unknown as SourceAsset]
          : [];
      if (response.assets.size !== refs.length) throw new Error('invalid_source_assets');
      for (const ref of refs) {
        const blob = response.assets.get(ref.handle);
        if (
          !blob ||
          blob.size !== ref.byteLength ||
          blob.type !== ref.contentType ||
          (await packageSha256(new Uint8Array(await blob.arrayBuffer()))) !== ref.sha256
        )
          throw new Error('invalid_source_asset');
        current();
      }
      if (response.stateChanges?.writes.length) {
        if (!usesStorage) throw new Error('permission_denied');
        current();
        await this.store.commitSourceState!(
          source.packageId,
          sourceId,
          active.revision,
          state!,
          response.stateChanges,
          joined.signal,
        );
        current();
      }
      return { result: response.result, assets: response.assets };
    } finally {
      signal.removeEventListener('abort', cancel);
      active.lifetime.signal.removeEventListener('abort', cancel);
    }
  }

  async checkUpdate(id: string, revision: number, signal = new AbortController().signal): Promise<Blob | undefined> {
    const record = await this.store.read(id);
    if (!record?.active || record.revision !== revision) throw new Error('package_install_conflict');
    if (!this.execution.checkUpdate) throw new Error('package_update_unavailable');
    const pkg = await verifyMoyaExtension(record.active.archive, signal);
    if (pkg.digest !== record.active.digest || pkg.manifest.extension.id !== id)
      throw new Error('package_storage_integrity');
    const archive = await this.execution.checkUpdate(pkg, signal);
    signal.throwIfAborted();
    if ((await this.store.read(id))?.revision !== revision) throw new Error('package_install_conflict');
    return archive;
  }

  async authenticate(
    sourceId: string,
    request: SourceAuthenticationRequest,
    signal = new AbortController().signal,
  ): Promise<SourceAuthenticationStatus> {
    await this.refresh();
    const source = this.getSource(sourceId);
    const active = source && this.active.get(source.packageId);
    if (!active?.credentialEpoch || !this.execution.authenticate) throw new Error('source_auth_unavailable');
    const joined = AbortSignal.any([signal, active.lifetime.signal]);
    const result = await this.execution.authenticate(active.pkg, sourceId, active.credentialEpoch, request, joined);
    joined.throwIfAborted();
    return result;
  }

  async contentConnection(sourceId: string, request: ContentConnectionRequest, signal = new AbortController().signal) {
    await this.refresh();
    const source = this.getSource(sourceId),
      active = source && this.active.get(source.packageId);
    if (!active?.credentialEpoch || !this.execution.contentConnection)
      throw new Error('source_content_service_required');
    const result = await this.execution.contentConnection(
      active.pkg,
      sourceId,
      active.credentialEpoch,
      request,
      AbortSignal.any([signal, active.lifetime.signal]),
    );
    signal.throwIfAborted();
    if (request.action !== 'status') {
      active.lifetime.abort();
      await this.refresh();
    }
    return result;
  }

  async preferences(
    sourceId: string,
    request: import('../../../packages/extension-contracts/source-preferences').SourcePreferencesRequest,
    signal = new AbortController().signal,
  ) {
    await this.refresh();
    const source = this.getSource(sourceId),
      active = source && this.active.get(source.packageId);
    if (!active?.credentialEpoch || !this.execution.preferences) throw new Error('invalid_source_preferences');
    const joined = AbortSignal.any([signal, active.lifetime.signal]);
    const result = await this.execution.preferences(active.pkg, sourceId, active.credentialEpoch, request, joined);
    joined.throwIfAborted();
    if (request.action === 'save') {
      active.lifetime.abort();
      await this.refresh();
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.refreshEpoch++;
    for (const active of this.active.values()) active.lifetime.abort();
    this.active.clear();
    this.sources = [];
    this.listeners.clear();
  }
}
