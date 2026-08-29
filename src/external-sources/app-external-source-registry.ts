import type { ExtensionContributionId, ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import type {
  DownloadedExternalSource,
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

export type ExternalSourceOrigin = 'built_in' | 'plugin';

export interface ExternalSourceContributionView {
  readonly descriptor: ExternalSourceContributionDescriptor;
  readonly origin?: ExternalSourceOrigin;
}

/** The host-facing source port shared by built-in connectors and source plugins. */
export interface ExternalSourceRegistryPort {
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

/**
 * Keeps product connectors out of extension enablement while preserving the same bounded broker contract.
 * Optional plugin sources are merged after built-ins and cannot shadow a product connector ID.
 */
export class AppExternalSourceRegistry implements ExternalSourceRegistryPort {
  private readonly builtIns = new Map<ExtensionContributionId, BuiltInExternalSourceDefinition>();

  constructor(
    builtIns: readonly BuiltInExternalSourceDefinition[],
    private readonly pluginSources?: ExternalSourceRegistryPort,
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
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return this.requireBroker(builtIn, context).connect(input);
    return this.requirePluginSources(contributionId).connectExternalSource(contributionId, context, input);
  }

  async disconnectExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
  ): Promise<void> {
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
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return this.requireBroker(builtIn, context).list(input, signal);
    return this.requirePluginSources(contributionId).listExternalSource(contributionId, context, input, signal);
  }

  async downloadExternalSource(
    contributionId: ExtensionContributionId,
    context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ): Promise<DownloadedExternalSource> {
    const builtIn = this.builtIns.get(contributionId);
    if (builtIn) return this.requireBroker(builtIn, context).download(ref, signal);
    return this.requirePluginSources(contributionId).downloadExternalSource(contributionId, context, ref, signal);
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

  private requirePluginSources(contributionId: ExtensionContributionId): ExternalSourceRegistryPort {
    if (!this.pluginSources) throw new Error(`External source is unavailable: ${contributionId}`);
    return this.pluginSources;
  }
}
