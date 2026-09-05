import type { ExtensionContributionId, ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import type {
  DownloadedExternalSource,
  ExternalSourceDownloadResult,
  NormalizedDownloadedExternalSource,
  ExternalItemKey,
  ExternalItemPage,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  ExternalSourcePickResult,
  TrustedExternalSourceHostContext,
} from './contracts';
import { normalizeExternalSourceDownload, normalizeExternalSourcePage } from './source-normalization';

export type ExternalSourceOrigin = 'built_in' | 'plugin';

export interface ExternalSourceContributionView {
  readonly descriptor: ExternalSourceContributionDescriptor;
  readonly origin?: ExternalSourceOrigin;
}

/** The host-facing source port shared by built-in connectors and source plugins. */
export interface ExternalSourceRegistryPort {
  resolveExternalSourceCover?(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    key: ExternalItemKey,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  getExternalSources(): readonly ExternalSourceContributionView[];
  getExternalSourceStatus(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): ExternalSourceConnectionStatus;
  getExternalSourceConnectionForm?(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): ExternalSourceConnectionForm | undefined;
  connectExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    input?: ExternalSourceConnectionInput,
  ): Promise<void>;
  disconnectExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): Promise<void>;
  listExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage>;
  downloadExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ): Promise<DownloadedExternalSource>;
  canPickExternalSource?(contributionId: ExtensionContributionId, context: TrustedExternalSourceHostContext): boolean;
  pickExternalSource?(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): Promise<ExternalSourcePickResult>;
  canRemoveExternalSourceItem?(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): boolean;
  removeExternalSourceItem?(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    key: ExternalItemKey,
  ): Promise<void>;
}

export interface BuiltInExternalSourceDefinition {
  readonly descriptor: ExternalSourceContributionDescriptor;
  readonly brokerId: string;
}

/** Trusted providers may return v1 or v2; only the app registry exposes the normalized host result. */
export interface ExternalSourceProviderRegistryPort extends Omit<ExternalSourceRegistryPort, 'downloadExternalSource'> {
  downloadExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ): Promise<ExternalSourceDownloadResult>;
}

/**
 * Keeps product connectors out of extension enablement while preserving the same bounded broker contract.
 * Optional plugin sources are merged after built-ins and cannot shadow a product connector ID.
 */
export class AppExternalSourceRegistry implements ExternalSourceRegistryPort {
  async resolveExternalSourceCover(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    key: ExternalItemKey,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    if (key.connectorId !== contributionId) throw new Error('표지 소스 연결이 다릅니다.');
    const before = this.connectionSnapshot(contributionId, context, key.accountConnectionId);
    const builtIn = this.builtIns.get(contributionId);
    const result = builtIn
      ? await this.requireBroker(builtIn, context).resolveCover?.(key, signal)
      : await this.pluginSources?.resolveExternalSourceCover?.(contributionId, context, key, signal);
    signal.throwIfAborted();
    this.assertConnectionSnapshot(contributionId, context, before);
    return result;
  }
  private readonly builtIns = new Map<ExtensionContributionId, BuiltInExternalSourceDefinition>();
  private readonly connectionEpochs = new Map<ExtensionContributionId, number>();

  constructor(
    builtIns: readonly BuiltInExternalSourceDefinition[],
    private readonly pluginSources?: ExternalSourceProviderRegistryPort,
  ) {
    for (const source of builtIns) {
      if (this.builtIns.has(source.descriptor.id)) {
        throw new Error(`Duplicate built-in external source: ${source.descriptor.id}`);
      }
      this.builtIns.set(source.descriptor.id, source);
    }
  }

  getExternalSources(): readonly ExternalSourceContributionView[] {
    const builtIns = [...this.builtIns.values()].map((source) => ({
      descriptor: source.descriptor,
      origin: 'built_in' as const,
    }));
    const plugins = (this.pluginSources?.getExternalSources() ?? [])
      .filter(({ descriptor }) => !this.builtIns.has(descriptor.id))
      .map((source) => ({ ...source, origin: 'plugin' as const }));
    return [...builtIns, ...plugins].sort(
      (left, right) =>
        (left.descriptor.order ?? 500) - (right.descriptor.order ?? 500) ||
        left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }

  getExternalSourceStatus(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): ExternalSourceConnectionStatus {
    const builtIn = this.builtIns.get(contributionId);
    return builtIn
      ? this.requireBroker(builtIn, context).status()
      : this.requirePluginSources(contributionId).getExternalSourceStatus(contributionId, context);
  }

  getExternalSourceConnectionForm(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): ExternalSourceConnectionForm | undefined {
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return this.requireBroker(builtIn, context).connectionForm?.();
    return this.pluginSources?.getExternalSourceConnectionForm?.(contributionId, context);
  }

  async connectExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    input?: ExternalSourceConnectionInput,
  ): Promise<void> {
    this.bumpConnectionEpoch(contributionId);
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return this.requireBroker(builtIn, context).connect(input);
    return this.requirePluginSources(contributionId).connectExternalSource(contributionId, context, input);
  }

  async disconnectExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): Promise<void> {
    this.bumpConnectionEpoch(contributionId);
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return this.requireBroker(builtIn, context).disconnect();
    return this.requirePluginSources(contributionId).disconnectExternalSource(contributionId, context);
  }

  async listExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage> {
    signal.throwIfAborted();
    const before = this.connectionSnapshot(contributionId, context, input.accountConnectionId);
    const builtIn = this.builtIns.get(contributionId);
    const page = builtIn
      ? await this.requireBroker(builtIn, context).list(input, signal)
      : await this.requirePluginSources(contributionId).listExternalSource(contributionId, context, input, signal);
    signal.throwIfAborted();
    this.assertConnectionSnapshot(contributionId, context, before);
    return normalizeExternalSourcePage(
      this.requireDescriptor(contributionId),
      page,
      this.getExternalSourceStatus(contributionId, context).accountConnectionId,
    );
  }

  async downloadExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ): Promise<NormalizedDownloadedExternalSource> {
    signal.throwIfAborted();
    if (ref.key.connectorId !== contributionId) throw new Error('외부 소스 요청의 연결 정보가 다릅니다.');
    const before = this.connectionSnapshot(
      contributionId,
      context,
      ref.key.accountConnectionId,
      ref.context?.connectionGeneration,
    );
    const builtIn = this.builtIns.get(contributionId);
    const result = builtIn
      ? await this.requireBroker(builtIn, context).download(ref, signal)
      : await this.requirePluginSources(contributionId).downloadExternalSource(contributionId, context, ref, signal);
    signal.throwIfAborted();
    this.assertConnectionSnapshot(contributionId, context, before);
    const normalized = await normalizeExternalSourceDownload(
      this.requireDescriptor(contributionId),
      result,
      ref,
      signal,
    );
    this.assertConnectionSnapshot(contributionId, context, before);
    return normalized;
  }

  canPickExternalSource(contributionId: ExtensionContributionId, context: TrustedExternalSourceHostContext): boolean {
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return typeof this.requireBroker(builtIn, context).pickItems === 'function';
    return this.pluginSources?.canPickExternalSource?.(contributionId, context) ?? false;
  }

  async pickExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): Promise<ExternalSourcePickResult> {
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) {
      const broker = this.requireBroker(builtIn, context);
      const pickItems = broker.pickItems;
      if (!pickItems) throw new Error(`${builtIn.descriptor.title} source does not support file picking.`);
      return pickItems.call(broker);
    }
    const pick = this.pluginSources?.pickExternalSource;
    if (!pick) throw new Error(`External source does not support file picking: ${contributionId}`);
    return pick.call(this.pluginSources, contributionId, context);
  }

  canRemoveExternalSourceItem(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): boolean {
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return typeof this.requireBroker(builtIn, context).removeSelectedItem === 'function';
    return this.pluginSources?.canRemoveExternalSourceItem?.(contributionId, context) ?? false;
  }

  async removeExternalSourceItem(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    key: ExternalItemKey,
  ): Promise<void> {
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) {
      const broker = this.requireBroker(builtIn, context);
      const remove = broker.removeSelectedItem;
      if (!remove) throw new Error(`${builtIn.descriptor.title} source does not support removing selected files.`);
      await remove.call(broker, key);
      return;
    }
    const remove = this.pluginSources?.removeExternalSourceItem;
    if (!remove) throw new Error(`External source does not support removing selected files: ${contributionId}`);
    await remove.call(this.pluginSources, contributionId, context, key);
  }

  private requireBroker(source: BuiltInExternalSourceDefinition, context: TrustedExternalSourceHostContext) {
    const broker = context.brokers.get(source.brokerId);
    if (!broker) throw new Error(`${source.descriptor.title} source is unavailable in this runtime.`);
    return broker;
  }

  private bumpConnectionEpoch(contributionId: ExtensionContributionId): void {
    this.connectionEpochs.set(contributionId, (this.connectionEpochs.get(contributionId) ?? 0) + 1);
  }

  private connectionSnapshot(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    accountConnectionId?: string,
    connectionGeneration?: string,
  ): string {
    const status = this.getExternalSourceStatus(contributionId, context);
    if (
      status.state !== 'connected' ||
      (accountConnectionId !== undefined && accountConnectionId !== status.accountConnectionId) ||
      (connectionGeneration !== undefined && connectionGeneration !== status.connectionGeneration)
    ) {
      throw new Error('외부 소스 연결이 변경되었습니다. 목록을 다시 열어 주세요.');
    }
    return JSON.stringify([
      status.accountConnectionId ?? '',
      status.connectionGeneration ?? '',
      this.connectionEpochs.get(contributionId) ?? 0,
    ]);
  }

  private assertConnectionSnapshot(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    before: string,
  ): void {
    if (this.connectionSnapshot(contributionId, context) !== before) {
      throw new Error('외부 소스 연결이 변경되었습니다. 목록을 다시 열어 주세요.');
    }
  }

  private requireDescriptor(contributionId: ExtensionContributionId): ExternalSourceContributionDescriptor {
    const descriptor = this.getExternalSources().find((source) => source.descriptor.id === contributionId)?.descriptor;
    if (!descriptor) throw new Error('외부 소스를 사용할 수 없습니다.');
    return descriptor;
  }

  private requirePluginSources(contributionId: ExtensionContributionId): ExternalSourceProviderRegistryPort {
    if (!this.pluginSources) throw new Error(`External source is unavailable: ${contributionId}`);
    return this.pluginSources;
  }
}
