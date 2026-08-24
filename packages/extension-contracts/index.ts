export const MOYA_EXTENSION_MANIFEST_VERSION = 1 as const;
export const MOYA_EXTENSION_API_VERSION = 1 as const;

export type ExtensionContributionId = `${string}.${string}`;

export const EXTENSION_PERMISSIONS = [
  'analysis.workflow.execute',
  'app.command.execute',
  'book.enrichment.propose',
  'external.source.download',
  'external.source.list',
  'reader.addon.render',
  'reader.context.read',
] as const;

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

export const READER_ADDON_ICON_NAMES = ['chart', 'file-text', 'headphones', 'list', 'notes', 'wand'] as const;

export type ReaderAddonIconName = (typeof READER_ADDON_ICON_NAMES)[number];

export interface ReaderAddonContributionDescriptor {
  readonly id: ExtensionContributionId;
  readonly label: string;
  readonly icon: ReaderAddonIconName;
  readonly order?: number;
}

export interface CommandContributionDescriptor {
  readonly id: ExtensionContributionId;
  readonly title: string;
}

export const MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const ANALYSIS_WORKFLOW_TARGETS = ['chapter-bundle', 'book'] as const;
export const ANALYSIS_WORKFLOW_KINDS = ['action', 'managed'] as const;

export type AnalysisWorkflowTarget = (typeof ANALYSIS_WORKFLOW_TARGETS)[number];
export type AnalysisWorkflowKind = (typeof ANALYSIS_WORKFLOW_KINDS)[number];

export interface AnalysisWorkflowContributionDescriptor {
  readonly id: ExtensionContributionId;
  readonly schemaVersion: typeof MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION;
  readonly title: string;
  readonly description?: string;
  readonly target: AnalysisWorkflowTarget;
  /** Defaults to `action` for manifests created before managed workflow surfaces were introduced. */
  readonly kind?: AnalysisWorkflowKind;
  readonly order?: number;
}

export const MOYA_BOOK_ENRICHMENT_SCHEMA_VERSION = 1 as const;
export const BOOK_ENRICHMENT_CAPABILITIES = ['metadata', 'cover'] as const;

export type BookEnrichmentCapability = (typeof BOOK_ENRICHMENT_CAPABILITIES)[number];

export interface BookEnrichmentProviderDescriptor {
  readonly id: ExtensionContributionId;
  readonly schemaVersion: typeof MOYA_BOOK_ENRICHMENT_SCHEMA_VERSION;
  readonly title: string;
  readonly description?: string;
  readonly capabilities: readonly BookEnrichmentCapability[];
  readonly order?: number;
}

export const MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_SOURCE_KINDS = ['cloud_file', 'catalog'] as const;
export const EXTERNAL_SOURCE_CAPABILITIES = [
  'browse',
  'search',
  'work-details',
  'release-list',
  'cover-read',
  'file-download',
  'work-import',
] as const;
export const EXTERNAL_SOURCE_RUNTIMES = ['web-direct', 'self-host-gateway', 'tauri-native'] as const;

export type ExternalSourceKind = (typeof EXTERNAL_SOURCE_KINDS)[number];
export type ExternalSourceCapability = (typeof EXTERNAL_SOURCE_CAPABILITIES)[number];
export type ExternalSourceRuntime = (typeof EXTERNAL_SOURCE_RUNTIMES)[number];

export interface ExternalSourceContributionDescriptor {
  readonly id: ExtensionContributionId;
  readonly schemaVersion: typeof MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION;
  readonly title: string;
  readonly description?: string;
  readonly kind: ExternalSourceKind;
  readonly capabilities: readonly ExternalSourceCapability[];
  readonly runtimes: readonly ExternalSourceRuntime[];
  readonly order?: number;
}

export interface ExtensionManifestV1 {
  readonly manifestVersion: typeof MOYA_EXTENSION_MANIFEST_VERSION;
  readonly id: ExtensionContributionId;
  readonly name: string;
  readonly version: string;
  readonly engine: {
    readonly moyaApi: typeof MOYA_EXTENSION_API_VERSION;
  };
  readonly permissions: readonly ExtensionPermission[];
  readonly contributes?: {
    readonly analysisWorkflows?: readonly AnalysisWorkflowContributionDescriptor[];
    readonly bookEnrichmentProviders?: readonly BookEnrichmentProviderDescriptor[];
    readonly commands?: readonly CommandContributionDescriptor[];
    readonly externalSources?: readonly ExternalSourceContributionDescriptor[];
    readonly readerAddonTabs?: readonly ReaderAddonContributionDescriptor[];
  };
}

export interface ExtensionManifestValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ExtensionManifestValidationResult =
  | { readonly ok: true; readonly manifest: ExtensionManifestV1 }
  | { readonly ok: false; readonly issues: readonly ExtensionManifestValidationIssue[] };

const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const permissionSet = new Set<string>(EXTENSION_PERMISSIONS);
const readerAddonIconSet = new Set<string>(READER_ADDON_ICON_NAMES);
const analysisWorkflowTargetSet = new Set<string>(ANALYSIS_WORKFLOW_TARGETS);
const analysisWorkflowKindSet = new Set<string>(ANALYSIS_WORKFLOW_KINDS);
const bookEnrichmentCapabilitySet = new Set<string>(BOOK_ENRICHMENT_CAPABILITIES);
const externalSourceKindSet = new Set<string>(EXTERNAL_SOURCE_KINDS);
const externalSourceCapabilitySet = new Set<string>(EXTERNAL_SOURCE_CAPABILITIES);
const externalSourceRuntimeSet = new Set<string>(EXTERNAL_SOURCE_RUNTIMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validateContributionId(value: unknown, extensionId: string): value is ExtensionContributionId {
  return (
    typeof value === 'string' &&
    value.length <= 160 &&
    value.startsWith(`${extensionId}.`) &&
    EXTENSION_ID_PATTERN.test(value)
  );
}

export function validateExtensionManifest(input: unknown): ExtensionManifestValidationResult {
  const issues: ExtensionManifestValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: '$', message: 'Manifest must be an object.' }] };
  }

  if (input.manifestVersion !== MOYA_EXTENSION_MANIFEST_VERSION) {
    issues.push({ path: 'manifestVersion', message: 'Unsupported extension manifest version.' });
  }
  const extensionId = typeof input.id === 'string' ? input.id : '';
  if (!validText(extensionId, 128) || !EXTENSION_ID_PATTERN.test(extensionId) || !extensionId.includes('.')) {
    issues.push({ path: 'id', message: 'Extension id must be a lowercase dotted identifier.' });
  }
  if (!validText(input.name, 80)) {
    issues.push({ path: 'name', message: 'Extension name must contain 1 to 80 characters.' });
  }
  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    issues.push({ path: 'version', message: 'Extension version must use semantic version syntax.' });
  }
  if (!isRecord(input.engine) || input.engine.moyaApi !== MOYA_EXTENSION_API_VERSION) {
    issues.push({ path: 'engine.moyaApi', message: 'Extension must target the current Moya API version.' });
  }

  if (!Array.isArray(input.permissions)) {
    issues.push({ path: 'permissions', message: 'Permissions must be an array.' });
  } else {
    const seen = new Set<string>();
    input.permissions.forEach((permission, index) => {
      if (typeof permission !== 'string' || !permissionSet.has(permission)) {
        issues.push({ path: `permissions[${index}]`, message: 'Unknown extension permission.' });
      } else if (seen.has(permission)) {
        issues.push({ path: `permissions[${index}]`, message: 'Duplicate extension permission.' });
      } else {
        seen.add(permission);
      }
    });
  }

  const contributionIds = new Set<string>();
  if (input.contributes !== undefined && !isRecord(input.contributes)) {
    issues.push({ path: 'contributes', message: 'Contributes must be an object.' });
  } else if (isRecord(input.contributes)) {
    const readerAddonTabs = input.contributes.readerAddonTabs;
    if (readerAddonTabs !== undefined && !Array.isArray(readerAddonTabs)) {
      issues.push({ path: 'contributes.readerAddonTabs', message: 'Reader addon tabs must be an array.' });
    } else if (Array.isArray(readerAddonTabs)) {
      readerAddonTabs.forEach((candidate, index) => {
        const path = `contributes.readerAddonTabs[${index}]`;
        if (!isRecord(candidate)) {
          issues.push({ path, message: 'Reader addon contribution must be an object.' });
          return;
        }
        if (!validateContributionId(candidate.id, extensionId)) {
          issues.push({ path: `${path}.id`, message: 'Contribution id must be namespaced by the extension id.' });
        } else if (contributionIds.has(candidate.id)) {
          issues.push({ path: `${path}.id`, message: 'Duplicate contribution id.' });
        } else {
          contributionIds.add(candidate.id);
        }
        if (!validText(candidate.label, 40)) {
          issues.push({ path: `${path}.label`, message: 'Reader addon label must contain 1 to 40 characters.' });
        }
        if (typeof candidate.icon !== 'string' || !readerAddonIconSet.has(candidate.icon)) {
          issues.push({ path: `${path}.icon`, message: 'Unknown reader addon icon.' });
        }
        if (
          candidate.order !== undefined &&
          (typeof candidate.order !== 'number' ||
            !Number.isInteger(candidate.order) ||
            candidate.order < 0 ||
            candidate.order > 1_000)
        ) {
          issues.push({ path: `${path}.order`, message: 'Reader addon order must be an integer from 0 to 1000.' });
        }
      });
    }

    const commands = input.contributes.commands;
    if (commands !== undefined && !Array.isArray(commands)) {
      issues.push({ path: 'contributes.commands', message: 'Commands must be an array.' });
    } else if (Array.isArray(commands)) {
      commands.forEach((candidate, index) => {
        const path = `contributes.commands[${index}]`;
        if (!isRecord(candidate)) {
          issues.push({ path, message: 'Command contribution must be an object.' });
          return;
        }
        if (!validateContributionId(candidate.id, extensionId)) {
          issues.push({ path: `${path}.id`, message: 'Contribution id must be namespaced by the extension id.' });
        } else if (contributionIds.has(candidate.id)) {
          issues.push({ path: `${path}.id`, message: 'Duplicate contribution id.' });
        } else {
          contributionIds.add(candidate.id);
        }
        if (!validText(candidate.title, 80)) {
          issues.push({ path: `${path}.title`, message: 'Command title must contain 1 to 80 characters.' });
        }
      });
    }

    const analysisWorkflows = input.contributes.analysisWorkflows;
    if (analysisWorkflows !== undefined && !Array.isArray(analysisWorkflows)) {
      issues.push({ path: 'contributes.analysisWorkflows', message: 'Analysis workflows must be an array.' });
    } else if (Array.isArray(analysisWorkflows)) {
      analysisWorkflows.forEach((candidate, index) => {
        const path = `contributes.analysisWorkflows[${index}]`;
        if (!isRecord(candidate)) {
          issues.push({ path, message: 'Analysis workflow contribution must be an object.' });
          return;
        }
        if (!validateContributionId(candidate.id, extensionId)) {
          issues.push({ path: `${path}.id`, message: 'Contribution id must be namespaced by the extension id.' });
        } else if (contributionIds.has(candidate.id)) {
          issues.push({ path: `${path}.id`, message: 'Duplicate contribution id.' });
        } else {
          contributionIds.add(candidate.id);
        }
        if (candidate.schemaVersion !== MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION) {
          issues.push({ path: `${path}.schemaVersion`, message: 'Unsupported analysis workflow schema version.' });
        }
        if (!validText(candidate.title, 80)) {
          issues.push({ path: `${path}.title`, message: 'Analysis workflow title must contain 1 to 80 characters.' });
        }
        if (candidate.description !== undefined && !validText(candidate.description, 160)) {
          issues.push({
            path: `${path}.description`,
            message: 'Analysis workflow description must contain 1 to 160 characters.',
          });
        }
        if (typeof candidate.target !== 'string' || !analysisWorkflowTargetSet.has(candidate.target)) {
          issues.push({ path: `${path}.target`, message: 'Unknown analysis workflow target.' });
        }
        if (
          candidate.kind !== undefined &&
          (typeof candidate.kind !== 'string' || !analysisWorkflowKindSet.has(candidate.kind))
        ) {
          issues.push({ path: `${path}.kind`, message: 'Unknown analysis workflow kind.' });
        }
        if (
          candidate.order !== undefined &&
          (typeof candidate.order !== 'number' ||
            !Number.isInteger(candidate.order) ||
            candidate.order < 0 ||
            candidate.order > 1_000)
        ) {
          issues.push({ path: `${path}.order`, message: 'Analysis workflow order must be an integer from 0 to 1000.' });
        }
      });
    }

    const bookEnrichmentProviders = input.contributes.bookEnrichmentProviders;
    if (bookEnrichmentProviders !== undefined && !Array.isArray(bookEnrichmentProviders)) {
      issues.push({
        path: 'contributes.bookEnrichmentProviders',
        message: 'Book enrichment providers must be an array.',
      });
    } else if (Array.isArray(bookEnrichmentProviders)) {
      bookEnrichmentProviders.forEach((candidate, index) => {
        const path = `contributes.bookEnrichmentProviders[${index}]`;
        if (!isRecord(candidate)) {
          issues.push({ path, message: 'Book enrichment provider contribution must be an object.' });
          return;
        }
        if (!validateContributionId(candidate.id, extensionId)) {
          issues.push({ path: `${path}.id`, message: 'Contribution id must be namespaced by the extension id.' });
        } else if (contributionIds.has(candidate.id)) {
          issues.push({ path: `${path}.id`, message: 'Duplicate contribution id.' });
        } else {
          contributionIds.add(candidate.id);
        }
        if (candidate.schemaVersion !== MOYA_BOOK_ENRICHMENT_SCHEMA_VERSION) {
          issues.push({ path: `${path}.schemaVersion`, message: 'Unsupported book enrichment schema version.' });
        }
        if (!validText(candidate.title, 80)) {
          issues.push({ path: `${path}.title`, message: 'Book enrichment title must contain 1 to 80 characters.' });
        }
        if (candidate.description !== undefined && !validText(candidate.description, 160)) {
          issues.push({
            path: `${path}.description`,
            message: 'Book enrichment description must contain 1 to 160 characters.',
          });
        }
        if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0) {
          issues.push({ path: `${path}.capabilities`, message: 'Book enrichment capabilities must not be empty.' });
        } else {
          const seenCapabilities = new Set<string>();
          candidate.capabilities.forEach((capability, capabilityIndex) => {
            if (typeof capability !== 'string' || !bookEnrichmentCapabilitySet.has(capability)) {
              issues.push({
                path: `${path}.capabilities[${capabilityIndex}]`,
                message: 'Unknown book enrichment capability.',
              });
            } else if (seenCapabilities.has(capability)) {
              issues.push({
                path: `${path}.capabilities[${capabilityIndex}]`,
                message: 'Duplicate book enrichment capability.',
              });
            } else {
              seenCapabilities.add(capability);
            }
          });
        }
        if (
          candidate.order !== undefined &&
          (typeof candidate.order !== 'number' ||
            !Number.isInteger(candidate.order) ||
            candidate.order < 0 ||
            candidate.order > 1_000)
        ) {
          issues.push({ path: `${path}.order`, message: 'Book enrichment order must be an integer from 0 to 1000.' });
        }
      });
    }

    const externalSources = input.contributes.externalSources;
    if (externalSources !== undefined && !Array.isArray(externalSources)) {
      issues.push({ path: 'contributes.externalSources', message: 'External sources must be an array.' });
    } else if (Array.isArray(externalSources)) {
      externalSources.forEach((candidate, index) => {
        const path = `contributes.externalSources[${index}]`;
        if (!isRecord(candidate)) {
          issues.push({ path, message: 'External source contribution must be an object.' });
          return;
        }
        if (!validateContributionId(candidate.id, extensionId)) {
          issues.push({ path: `${path}.id`, message: 'Contribution id must be namespaced by the extension id.' });
        } else if (contributionIds.has(candidate.id)) {
          issues.push({ path: `${path}.id`, message: 'Duplicate contribution id.' });
        } else {
          contributionIds.add(candidate.id);
        }
        if (candidate.schemaVersion !== MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION) {
          issues.push({ path: `${path}.schemaVersion`, message: 'Unsupported external source schema version.' });
        }
        if (!validText(candidate.title, 80)) {
          issues.push({ path: `${path}.title`, message: 'External source title must contain 1 to 80 characters.' });
        }
        if (candidate.description !== undefined && !validText(candidate.description, 160)) {
          issues.push({
            path: `${path}.description`,
            message: 'External source description must contain 1 to 160 characters.',
          });
        }
        if (typeof candidate.kind !== 'string' || !externalSourceKindSet.has(candidate.kind)) {
          issues.push({ path: `${path}.kind`, message: 'Unknown external source kind.' });
        }
        if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0) {
          issues.push({ path: `${path}.capabilities`, message: 'External source capabilities must not be empty.' });
        } else {
          const seenCapabilities = new Set<string>();
          candidate.capabilities.forEach((capability, capabilityIndex) => {
            if (typeof capability !== 'string' || !externalSourceCapabilitySet.has(capability)) {
              issues.push({
                path: `${path}.capabilities[${capabilityIndex}]`,
                message: 'Unknown external source capability.',
              });
            } else if (seenCapabilities.has(capability)) {
              issues.push({
                path: `${path}.capabilities[${capabilityIndex}]`,
                message: 'Duplicate external source capability.',
              });
            } else {
              seenCapabilities.add(capability);
            }
          });
        }
        if (!Array.isArray(candidate.runtimes) || candidate.runtimes.length === 0) {
          issues.push({ path: `${path}.runtimes`, message: 'External source runtimes must not be empty.' });
        } else {
          const seenRuntimes = new Set<string>();
          candidate.runtimes.forEach((runtime, runtimeIndex) => {
            if (typeof runtime !== 'string' || !externalSourceRuntimeSet.has(runtime)) {
              issues.push({ path: `${path}.runtimes[${runtimeIndex}]`, message: 'Unknown external source runtime.' });
            } else if (seenRuntimes.has(runtime)) {
              issues.push({ path: `${path}.runtimes[${runtimeIndex}]`, message: 'Duplicate external source runtime.' });
            } else {
              seenRuntimes.add(runtime);
            }
          });
        }
        if (
          candidate.order !== undefined &&
          (typeof candidate.order !== 'number' ||
            !Number.isInteger(candidate.order) ||
            candidate.order < 0 ||
            candidate.order > 1_000)
        ) {
          issues.push({ path: `${path}.order`, message: 'External source order must be an integer from 0 to 1000.' });
        }
      });
    }
  }

  return issues.length === 0 ? { ok: true, manifest: input as unknown as ExtensionManifestV1 } : { ok: false, issues };
}
