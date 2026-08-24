import type { ExtensionContributionId, ExtensionManifestV1, ExtensionPermission } from '@noveldesk/extension-contracts';
import { ExtensionEnablementStore } from './extension-enablement-store';
import type {
  ExtensionLifecycleState,
  TrustedExtensionDefinition,
  TrustedExtensionRegistry,
} from './trusted-extension-registry';

export type ExtensionOrigin = 'bundled' | 'community';
export type ExtensionTrustLevel = 'trusted' | 'sandboxed';
export type ExtensionContributionKind = 'reader_addon' | 'command' | 'analysis' | 'book_enrichment' | 'external_source';

export interface AppExtensionRegistration<TReaderAddonContext, TAnalysisWorkflowContext> {
  readonly definition: TrustedExtensionDefinition<TReaderAddonContext, TAnalysisWorkflowContext>;
  readonly origin: ExtensionOrigin;
  readonly trustLevel: ExtensionTrustLevel;
  readonly defaultEnabled: boolean;
  readonly canDisable: boolean;
  readonly beta?: boolean;
  readonly description?: string;
}

export interface ExtensionContributionSummary {
  readonly id: ExtensionContributionId;
  readonly kind: ExtensionContributionKind;
  readonly title: string;
}

export interface AppExtensionSnapshot {
  readonly id: ExtensionContributionId;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly origin: ExtensionOrigin;
  readonly trustLevel: ExtensionTrustLevel;
  readonly defaultEnabled: boolean;
  readonly canDisable: boolean;
  readonly beta: boolean;
  readonly enabled: boolean;
  readonly state: ExtensionLifecycleState;
  readonly errorMessage?: string;
  readonly permissions: readonly ExtensionPermission[];
  readonly contributions: readonly ExtensionContributionSummary[];
}

function contributionSummaries(manifest: ExtensionManifestV1): readonly ExtensionContributionSummary[] {
  return [
    ...(manifest.contributes?.readerAddonTabs ?? []).map((item) => ({
      id: item.id,
      kind: 'reader_addon' as const,
      title: item.label,
    })),
    ...(manifest.contributes?.commands ?? []).map((item) => ({
      id: item.id,
      kind: 'command' as const,
      title: item.title,
    })),
    ...(manifest.contributes?.analysisWorkflows ?? []).map((item) => ({
      id: item.id,
      kind: 'analysis' as const,
      title: item.title,
    })),
    ...(manifest.contributes?.bookEnrichmentProviders ?? []).map((item) => ({
      id: item.id,
      kind: 'book_enrichment' as const,
      title: item.title,
    })),
    ...(manifest.contributes?.externalSources ?? []).map((item) => ({
      id: item.id,
      kind: 'external_source' as const,
      title: item.title,
    })),
  ];
}

/** Owns user enablement and the reactive projection of source-reviewed extensions. */
export class AppExtensionManager<TReaderAddonContext, TAnalysisWorkflowContext> {
  private readonly registrations = new Map<
    ExtensionContributionId,
    AppExtensionRegistration<TReaderAddonContext, TAnalysisWorkflowContext>
  >();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(
    private readonly registry: TrustedExtensionRegistry<TReaderAddonContext, TAnalysisWorkflowContext>,
    registrations: readonly AppExtensionRegistration<TReaderAddonContext, TAnalysisWorkflowContext>[],
    private readonly enablement = new ExtensionEnablementStore(),
  ) {
    for (const registration of [...registrations].sort((left, right) =>
      left.definition.manifest.id.localeCompare(right.definition.manifest.id),
    )) {
      if (!this.registry.register(registration.definition)) continue;
      this.registrations.set(registration.definition.manifest.id, registration);
    }
    for (const registration of this.registrations.values()) {
      const manifest = registration.definition.manifest;
      if (this.enablement.isEnabled(manifest.id, registration.defaultEnabled)) this.registry.activate(manifest.id);
      else this.registry.disable(manifest.id);
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getRevision = (): number => this.revision;

  isEnabled(extensionId: ExtensionContributionId): boolean {
    const registration = this.registrations.get(extensionId);
    return registration ? this.enablement.isEnabled(extensionId, registration.defaultEnabled) : false;
  }

  setEnabled(extensionId: ExtensionContributionId, enabled: boolean): boolean {
    const registration = this.registrations.get(extensionId);
    if (!registration || (!registration.canDisable && !enabled)) return false;
    const changed = this.isEnabled(extensionId) !== enabled;
    this.enablement.setEnabled(extensionId, enabled);
    const accepted = enabled ? this.registry.activate(extensionId) : this.registry.disable(extensionId);
    if (!accepted) return false;
    if (changed) this.publish();
    return true;
  }

  list(): readonly AppExtensionSnapshot[] {
    const lifecycleById = new Map(this.registry.getSnapshots().map((snapshot) => [snapshot.id, snapshot]));
    return [...this.registrations.values()]
      .map((registration) => {
        const manifest = registration.definition.manifest;
        const lifecycle = lifecycleById.get(manifest.id);
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: registration.description,
          origin: registration.origin,
          trustLevel: registration.trustLevel,
          defaultEnabled: registration.defaultEnabled,
          canDisable: registration.canDisable,
          beta: registration.beta ?? false,
          enabled: this.isEnabled(manifest.id),
          state: lifecycle?.state ?? 'failed',
          errorMessage: lifecycle?.errorMessage,
          permissions: manifest.permissions,
          contributions: contributionSummaries(manifest),
        } satisfies AppExtensionSnapshot;
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'ko') || left.id.localeCompare(right.id));
  }

  hasDeclaredManagedWorkflow(workflowId: ExtensionContributionId): boolean {
    return [...this.registrations.values()].some((registration) =>
      registration.definition.manifest.contributes?.analysisWorkflows?.some(
        (workflow) => workflow.id === workflowId && workflow.kind === 'managed' && workflow.target === 'book',
      ),
    );
  }

  private publish(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
