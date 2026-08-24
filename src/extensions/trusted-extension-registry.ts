import type {
  AnalysisWorkflowContributionDescriptor,
  BookEnrichmentProviderDescriptor,
  CommandContributionDescriptor,
  ExtensionContributionId,
  ExtensionManifestV1,
  ExtensionPermission,
  ExternalSourceContributionDescriptor,
  ReaderAddonContributionDescriptor,
} from '@noveldesk/extension-contracts';
import { MOYA_EXTENSION_API_VERSION, validateExtensionManifest } from '@noveldesk/extension-contracts';
import type { ReactNode } from 'react';
import type {
  BookEnrichmentCandidateDraft,
  TrustedBookEnrichmentHostContext,
} from '../features/book-enrichment/book-enrichment-contract';
import type {
  DownloadedExternalSource,
  ExternalItemPage,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../external-sources/contracts';

export type ExtensionDisposable = () => void;
export type ExtensionLifecycleState = 'registered' | 'active' | 'disabled' | 'failed';

export interface TrustedReaderAddonContribution<TContext> {
  readonly extensionId: ExtensionContributionId;
  readonly descriptor: ReaderAddonContributionDescriptor;
  render(context: TContext): ReactNode;
}

export type TrustedCommandHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>;

export interface TrustedAnalysisWorkflowRegistration<TContext> {
  isEnabled?(context: TContext): boolean;
  run?(context: TContext): unknown | Promise<unknown>;
  render?(context: TContext): ReactNode;
}

export interface TrustedAnalysisWorkflowContribution<TContext> extends TrustedAnalysisWorkflowRegistration<TContext> {
  readonly extensionId: ExtensionContributionId;
  readonly descriptor: AnalysisWorkflowContributionDescriptor;
}

export interface TrustedBookEnrichmentProviderRegistration {
  isEnabled?(context: TrustedBookEnrichmentHostContext): boolean;
  propose(
    context: TrustedBookEnrichmentHostContext,
  ): readonly BookEnrichmentCandidateDraft[] | Promise<readonly BookEnrichmentCandidateDraft[]>;
}

export interface TrustedBookEnrichmentProviderContribution extends TrustedBookEnrichmentProviderRegistration {
  readonly extensionId: ExtensionContributionId;
  readonly extensionVersion: string;
  readonly descriptor: BookEnrichmentProviderDescriptor;
}

export interface TrustedExternalSourceRegistration {
  status(context: TrustedExternalSourceHostContext): ExternalSourceConnectionStatus;
  connectionForm?(context: TrustedExternalSourceHostContext): ExternalSourceConnectionForm | undefined;
  connect(context: TrustedExternalSourceHostContext, input?: ExternalSourceConnectionInput): Promise<void>;
  disconnect(context: TrustedExternalSourceHostContext): Promise<void>;
  list(
    context: TrustedExternalSourceHostContext,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage>;
  download(
    context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ): Promise<DownloadedExternalSource>;
}

export interface TrustedExternalSourceContribution extends TrustedExternalSourceRegistration {
  readonly extensionId: ExtensionContributionId;
  readonly extensionVersion: string;
  readonly descriptor: ExternalSourceContributionDescriptor;
}

export interface TrustedExtensionHostContext<TReaderAddonContext, TAnalysisWorkflowContext> {
  readonly extensionId: ExtensionContributionId;
  readonly apiVersion: typeof MOYA_EXTENSION_API_VERSION;
  readonly permissions: {
    has(permission: ExtensionPermission): boolean;
  };
  readonly readerAddons: {
    register(
      contributionId: ExtensionContributionId,
      render: (context: TReaderAddonContext) => ReactNode,
    ): ExtensionDisposable;
  };
  readonly commands: {
    register(contributionId: ExtensionContributionId, handler: TrustedCommandHandler): ExtensionDisposable;
  };
  readonly analysisWorkflows: {
    register(
      contributionId: ExtensionContributionId,
      registration: TrustedAnalysisWorkflowRegistration<TAnalysisWorkflowContext>,
    ): ExtensionDisposable;
  };
  readonly bookEnrichmentProviders: {
    register(
      contributionId: ExtensionContributionId,
      registration: TrustedBookEnrichmentProviderRegistration,
    ): ExtensionDisposable;
  };
  readonly externalSources: {
    register(
      contributionId: ExtensionContributionId,
      registration: TrustedExternalSourceRegistration,
    ): ExtensionDisposable;
  };
}

export interface TrustedExtensionDefinition<TReaderAddonContext, TAnalysisWorkflowContext = never> {
  readonly manifest: ExtensionManifestV1;
  activate(
    context: TrustedExtensionHostContext<TReaderAddonContext, TAnalysisWorkflowContext>,
  ): void | ExtensionDisposable;
}

export interface TrustedExtensionSnapshot {
  readonly id: ExtensionContributionId;
  readonly name: string;
  readonly version: string;
  readonly state: ExtensionLifecycleState;
  readonly errorMessage?: string;
}

export interface ExtensionDiagnostic {
  readonly extensionId?: string;
  readonly phase: 'registration' | 'activation';
  readonly message: string;
}

interface RegisteredExtension<TReaderAddonContext, TAnalysisWorkflowContext> {
  readonly definition: TrustedExtensionDefinition<TReaderAddonContext, TAnalysisWorkflowContext>;
  state: ExtensionLifecycleState;
  disposables: ExtensionDisposable[];
  errorMessage?: string;
}

interface RegisteredCommand {
  readonly extensionId: ExtensionContributionId;
  readonly descriptor: CommandContributionDescriptor;
  readonly handler: TrustedCommandHandler;
}

function disposeAll(disposables: readonly ExtensionDisposable[]): void {
  for (const dispose of [...disposables].reverse()) {
    try {
      dispose();
    } catch {
      // Trusted extension cleanup is isolated so App teardown can continue.
    }
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Trusted extension activation failed.';
}

export class TrustedExtensionRegistry<TReaderAddonContext, TAnalysisWorkflowContext = never> {
  private readonly extensions = new Map<
    ExtensionContributionId,
    RegisteredExtension<TReaderAddonContext, TAnalysisWorkflowContext>
  >();
  private readonly readerAddonContributions = new Map<
    ExtensionContributionId,
    TrustedReaderAddonContribution<TReaderAddonContext>
  >();
  private readonly commandContributions = new Map<ExtensionContributionId, RegisteredCommand>();
  private readonly analysisWorkflowContributions = new Map<
    ExtensionContributionId,
    TrustedAnalysisWorkflowContribution<TAnalysisWorkflowContext>
  >();
  private readonly bookEnrichmentProviderContributions = new Map<
    ExtensionContributionId,
    TrustedBookEnrichmentProviderContribution
  >();
  private readonly externalSourceContributions = new Map<ExtensionContributionId, TrustedExternalSourceContribution>();
  private readonly diagnostics: ExtensionDiagnostic[] = [];

  register(definition: TrustedExtensionDefinition<TReaderAddonContext, TAnalysisWorkflowContext>): boolean {
    const validation = validateExtensionManifest(definition.manifest);
    if (!validation.ok) {
      this.diagnostics.push({
        extensionId: typeof definition.manifest?.id === 'string' ? definition.manifest.id : undefined,
        phase: 'registration',
        message: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' '),
      });
      return false;
    }
    if (this.extensions.has(validation.manifest.id)) {
      this.diagnostics.push({
        extensionId: validation.manifest.id,
        phase: 'registration',
        message: `Duplicate trusted extension id: ${validation.manifest.id}`,
      });
      return false;
    }
    this.extensions.set(validation.manifest.id, {
      definition,
      state: 'registered',
      disposables: [],
    });
    return true;
  }

  activateAll(): void {
    for (const id of [...this.extensions.keys()].sort()) this.activate(id);
  }

  activate(extensionId: ExtensionContributionId): boolean {
    const registration = this.extensions.get(extensionId);
    if (!registration) return false;
    if (registration.state === 'active') return true;

    const manifest = registration.definition.manifest;
    const permissions = new Set<ExtensionPermission>(manifest.permissions);
    const disposables: ExtensionDisposable[] = [];
    const requirePermission = (permission: ExtensionPermission) => {
      if (!permissions.has(permission)) {
        throw new Error(`Extension ${extensionId} did not declare ${permission}.`);
      }
    };
    const declaredReaderAddon = (contributionId: ExtensionContributionId) => {
      const descriptor = manifest.contributes?.readerAddonTabs?.find((item) => item.id === contributionId);
      if (!descriptor) throw new Error(`Reader addon ${contributionId} is not declared in the manifest.`);
      return descriptor;
    };
    const declaredCommand = (contributionId: ExtensionContributionId) => {
      const descriptor = manifest.contributes?.commands?.find((item) => item.id === contributionId);
      if (!descriptor) throw new Error(`Command ${contributionId} is not declared in the manifest.`);
      return descriptor;
    };
    const declaredAnalysisWorkflow = (contributionId: ExtensionContributionId) => {
      const descriptor = manifest.contributes?.analysisWorkflows?.find((item) => item.id === contributionId);
      if (!descriptor) throw new Error(`Analysis workflow ${contributionId} is not declared in the manifest.`);
      return descriptor;
    };
    const declaredBookEnrichmentProvider = (contributionId: ExtensionContributionId) => {
      const descriptor = manifest.contributes?.bookEnrichmentProviders?.find((item) => item.id === contributionId);
      if (!descriptor) throw new Error(`Book enrichment provider ${contributionId} is not declared in the manifest.`);
      return descriptor;
    };
    const declaredExternalSource = (contributionId: ExtensionContributionId) => {
      const descriptor = manifest.contributes?.externalSources?.find((item) => item.id === contributionId);
      if (!descriptor) throw new Error(`External source ${contributionId} is not declared in the manifest.`);
      return descriptor;
    };

    const hostContext: TrustedExtensionHostContext<TReaderAddonContext, TAnalysisWorkflowContext> = {
      extensionId,
      apiVersion: MOYA_EXTENSION_API_VERSION,
      permissions: { has: (permission) => permissions.has(permission) },
      readerAddons: {
        register: (contributionId, render) => {
          requirePermission('reader.addon.render');
          requirePermission('reader.context.read');
          const descriptor = declaredReaderAddon(contributionId);
          if (this.readerAddonContributions.has(contributionId)) {
            throw new Error(`Duplicate reader addon contribution: ${contributionId}`);
          }
          const contribution = { extensionId, descriptor, render };
          this.readerAddonContributions.set(contributionId, contribution);
          const dispose = () => {
            if (this.readerAddonContributions.get(contributionId) === contribution) {
              this.readerAddonContributions.delete(contributionId);
            }
          };
          disposables.push(dispose);
          return dispose;
        },
      },
      commands: {
        register: (contributionId, handler) => {
          requirePermission('app.command.execute');
          const descriptor = declaredCommand(contributionId);
          if (this.commandContributions.has(contributionId)) {
            throw new Error(`Duplicate command contribution: ${contributionId}`);
          }
          const command = { extensionId, descriptor, handler };
          this.commandContributions.set(contributionId, command);
          const dispose = () => {
            if (this.commandContributions.get(contributionId) === command) {
              this.commandContributions.delete(contributionId);
            }
          };
          disposables.push(dispose);
          return dispose;
        },
      },
      analysisWorkflows: {
        register: (contributionId, workflowRegistration) => {
          requirePermission('analysis.workflow.execute');
          const descriptor = declaredAnalysisWorkflow(contributionId);
          const kind = descriptor.kind ?? 'action';
          if (kind === 'action' && typeof workflowRegistration.run !== 'function') {
            throw new Error(`Action analysis workflow ${contributionId} must register run().`);
          }
          if (kind === 'managed' && typeof workflowRegistration.render !== 'function') {
            throw new Error(`Managed analysis workflow ${contributionId} must register render().`);
          }
          if (this.analysisWorkflowContributions.has(contributionId)) {
            throw new Error(`Duplicate analysis workflow contribution: ${contributionId}`);
          }
          const contribution = { ...workflowRegistration, extensionId, descriptor };
          this.analysisWorkflowContributions.set(contributionId, contribution);
          const dispose = () => {
            if (this.analysisWorkflowContributions.get(contributionId) === contribution) {
              this.analysisWorkflowContributions.delete(contributionId);
            }
          };
          disposables.push(dispose);
          return dispose;
        },
      },
      bookEnrichmentProviders: {
        register: (contributionId, providerRegistration) => {
          requirePermission('book.enrichment.propose');
          const descriptor = declaredBookEnrichmentProvider(contributionId);
          if (typeof providerRegistration.propose !== 'function') {
            throw new Error(`Book enrichment provider ${contributionId} must register propose().`);
          }
          if (this.bookEnrichmentProviderContributions.has(contributionId)) {
            throw new Error(`Duplicate book enrichment provider contribution: ${contributionId}`);
          }
          const contribution = {
            ...providerRegistration,
            extensionId,
            extensionVersion: manifest.version,
            descriptor,
          };
          this.bookEnrichmentProviderContributions.set(contributionId, contribution);
          const dispose = () => {
            if (this.bookEnrichmentProviderContributions.get(contributionId) === contribution) {
              this.bookEnrichmentProviderContributions.delete(contributionId);
            }
          };
          disposables.push(dispose);
          return dispose;
        },
      },
      externalSources: {
        register: (contributionId, sourceRegistration) => {
          requirePermission('external.source.list');
          requirePermission('external.source.download');
          const descriptor = declaredExternalSource(contributionId);
          if (
            typeof sourceRegistration.status !== 'function' ||
            typeof sourceRegistration.connect !== 'function' ||
            typeof sourceRegistration.disconnect !== 'function' ||
            typeof sourceRegistration.list !== 'function' ||
            typeof sourceRegistration.download !== 'function'
          ) {
            throw new Error(`External source ${contributionId} must register the complete host-mediated source port.`);
          }
          if (this.externalSourceContributions.has(contributionId)) {
            throw new Error(`Duplicate external source contribution: ${contributionId}`);
          }
          const contribution = {
            ...sourceRegistration,
            extensionId,
            extensionVersion: manifest.version,
            descriptor,
          };
          this.externalSourceContributions.set(contributionId, contribution);
          const dispose = () => {
            if (this.externalSourceContributions.get(contributionId) === contribution) {
              this.externalSourceContributions.delete(contributionId);
            }
          };
          disposables.push(dispose);
          return dispose;
        },
      },
    };

    try {
      registration.state = 'registered';
      registration.errorMessage = undefined;
      const extensionDispose = registration.definition.activate(hostContext);
      if (extensionDispose && !disposables.includes(extensionDispose)) disposables.push(extensionDispose);
      registration.disposables = disposables;
      registration.state = 'active';
      return true;
    } catch (error) {
      disposeAll(disposables);
      const message = safeErrorMessage(error);
      registration.disposables = [];
      registration.state = 'failed';
      registration.errorMessage = message;
      this.diagnostics.push({ extensionId, phase: 'activation', message });
      return false;
    }
  }

  disable(extensionId: ExtensionContributionId): boolean {
    const registration = this.extensions.get(extensionId);
    if (!registration) return false;
    disposeAll(registration.disposables);
    registration.disposables = [];
    registration.state = 'disabled';
    registration.errorMessage = undefined;
    return true;
  }

  getReaderAddonTabs(): readonly TrustedReaderAddonContribution<TReaderAddonContext>[] {
    return [...this.readerAddonContributions.values()].sort(
      (left, right) =>
        (left.descriptor.order ?? 500) - (right.descriptor.order ?? 500) ||
        left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }

  getReaderAddon(contributionId: string): TrustedReaderAddonContribution<TReaderAddonContext> | undefined {
    return this.readerAddonContributions.get(contributionId as ExtensionContributionId);
  }

  getAnalysisWorkflows(): readonly TrustedAnalysisWorkflowContribution<TAnalysisWorkflowContext>[] {
    return [...this.analysisWorkflowContributions.values()].sort(
      (left, right) =>
        (left.descriptor.order ?? 500) - (right.descriptor.order ?? 500) ||
        left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }

  getAnalysisWorkflow(
    contributionId: string,
  ): TrustedAnalysisWorkflowContribution<TAnalysisWorkflowContext> | undefined {
    return this.analysisWorkflowContributions.get(contributionId as ExtensionContributionId);
  }

  getBookEnrichmentProviders(): readonly TrustedBookEnrichmentProviderContribution[] {
    return [...this.bookEnrichmentProviderContributions.values()].sort(
      (left, right) =>
        (left.descriptor.order ?? 500) - (right.descriptor.order ?? 500) ||
        left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }

  getBookEnrichmentProvider(contributionId: string): TrustedBookEnrichmentProviderContribution | undefined {
    return this.bookEnrichmentProviderContributions.get(contributionId as ExtensionContributionId);
  }

  getExternalSources(): readonly TrustedExternalSourceContribution[] {
    return [...this.externalSourceContributions.values()].sort(
      (left, right) =>
        (left.descriptor.order ?? 500) - (right.descriptor.order ?? 500) ||
        left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }

  getExternalSource(contributionId: string): TrustedExternalSourceContribution | undefined {
    return this.externalSourceContributions.get(contributionId as ExtensionContributionId);
  }

  getExternalSourceStatus(
    contributionId: ExtensionContributionId,
    hostContext: TrustedExternalSourceHostContext,
  ): ExternalSourceConnectionStatus {
    return this.requireExternalSource(contributionId).status(hostContext);
  }

  getExternalSourceConnectionForm(
    contributionId: ExtensionContributionId,
    hostContext: TrustedExternalSourceHostContext,
  ): ExternalSourceConnectionForm | undefined {
    return this.requireExternalSource(contributionId).connectionForm?.(hostContext);
  }

  async connectExternalSource(
    contributionId: ExtensionContributionId,
    hostContext: TrustedExternalSourceHostContext,
    input?: ExternalSourceConnectionInput,
  ): Promise<void> {
    await this.requireExternalSource(contributionId).connect(hostContext, input);
  }

  async disconnectExternalSource(
    contributionId: ExtensionContributionId,
    hostContext: TrustedExternalSourceHostContext,
  ): Promise<void> {
    await this.requireExternalSource(contributionId).disconnect(hostContext);
  }

  async listExternalSource(
    contributionId: ExtensionContributionId,
    hostContext: TrustedExternalSourceHostContext,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage> {
    return this.requireExternalSource(contributionId).list(hostContext, input, signal);
  }

  async downloadExternalSource(
    contributionId: ExtensionContributionId,
    hostContext: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ): Promise<DownloadedExternalSource> {
    return this.requireExternalSource(contributionId).download(hostContext, ref, signal);
  }

  async executeBookEnrichmentProvider(
    contributionId: ExtensionContributionId,
    context: TrustedBookEnrichmentHostContext,
  ): Promise<readonly BookEnrichmentCandidateDraft[]> {
    const provider = this.bookEnrichmentProviderContributions.get(contributionId);
    if (!provider || provider.isEnabled?.(context) === false) {
      throw new Error(`Trusted book enrichment provider is unavailable: ${contributionId}`);
    }
    return provider.propose(context);
  }

  async executeAnalysisWorkflow(
    contributionId: ExtensionContributionId,
    context: TAnalysisWorkflowContext,
  ): Promise<unknown> {
    const workflow = this.analysisWorkflowContributions.get(contributionId);
    if (!workflow || workflow.isEnabled?.(context) === false) {
      throw new Error(`Trusted analysis workflow is unavailable: ${contributionId}`);
    }
    if ((workflow.descriptor.kind ?? 'action') !== 'action' || !workflow.run) {
      throw new Error(`Trusted analysis workflow is not an action: ${contributionId}`);
    }
    return workflow.run(context);
  }

  renderAnalysisWorkflow(contributionId: ExtensionContributionId, context: TAnalysisWorkflowContext): ReactNode {
    const workflow = this.analysisWorkflowContributions.get(contributionId);
    if (!workflow || workflow.isEnabled?.(context) === false) {
      throw new Error(`Trusted analysis workflow is unavailable: ${contributionId}`);
    }
    if (workflow.descriptor.kind !== 'managed' || !workflow.render) {
      throw new Error(`Trusted analysis workflow is not a managed surface: ${contributionId}`);
    }
    return workflow.render(context);
  }

  async executeCommand(contributionId: ExtensionContributionId, ...args: readonly unknown[]): Promise<unknown> {
    const command = this.commandContributions.get(contributionId);
    if (!command) throw new Error(`Trusted extension command is unavailable: ${contributionId}`);
    return command.handler(...args);
  }

  getSnapshots(): readonly TrustedExtensionSnapshot[] {
    return [...this.extensions.values()]
      .map(({ definition, state, errorMessage }) => ({
        id: definition.manifest.id,
        name: definition.manifest.name,
        version: definition.manifest.version,
        state,
        errorMessage,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getDiagnostics(): readonly ExtensionDiagnostic[] {
    return [...this.diagnostics];
  }

  private requireExternalSource(contributionId: ExtensionContributionId): TrustedExternalSourceContribution {
    const source = this.externalSourceContributions.get(contributionId);
    if (!source) throw new Error(`Trusted external source is unavailable: ${contributionId}`);
    return source;
  }
}
