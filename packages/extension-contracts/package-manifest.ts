import { validateExtensionManifest, type ExtensionManifestV1 } from './index';
import { validateSourceAuthentication, type SourceAuthentication } from './source-authentication';
import { validateSourceContentServices, type SourceContentService } from './source-content-service';
import { validSourcePreferenceDefinitions, type SourcePreferenceDefinition } from './source-preferences';
export type { SourceContentService } from './source-content-service';
export type {
  SourceAuthentication,
  SourceAuthenticationInput,
  SourceAuthenticationRequest,
  SourceAuthenticationStatus,
} from './source-authentication';
export { validateSourceAuthenticationRequest } from './source-authentication';

export const MOYA_PACKAGE_LIMITS = Object.freeze({
  archiveBytes: 10 * 1024 * 1024,
  expandedBytes: 30 * 1024 * 1024,
  entries: 256,
  manifestBytes: 64 * 1024,
  entryBytes: 5 * 1024 * 1024,
});

export interface MoyaPackageManifestV1 {
  readonly preferences?: readonly SourcePreferenceDefinition[];
  readonly updates?: { readonly repository: string };
  readonly packageFormat: 'moya.extension.package';
  readonly packageVersion: 1;
  readonly extension: ExtensionManifestV1;
  readonly execution: { readonly kind: 'moya-js'; readonly apiVersion: 1; readonly entry: 'dist/main.js' };
  readonly requestedAccess: {
    readonly networkOrigins: readonly string[];
    readonly storageKiB: number;
    readonly authentication?: readonly SourceAuthentication[];
    readonly contentServices?: readonly SourceContentService[];
    readonly webview?: boolean;
  };
  readonly license: string;
}

export type PackageValidationResult =
  | { readonly ok: true; readonly manifest: MoyaPackageManifestV1 }
  | {
      readonly ok: false;
      readonly code: 'invalid_package_manifest' | 'unsupported_package_api';
      readonly path: string;
    };

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function keys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

export function validateMoyaPackageManifest(input: unknown): PackageValidationResult {
  const invalid = (path: string): PackageValidationResult => ({ ok: false, code: 'invalid_package_manifest', path });
  if (
    !record(input) ||
    !keys(input, [
      'packageFormat',
      'packageVersion',
      'extension',
      'execution',
      'requestedAccess',
      'license',
      'updates',
      'preferences',
    ])
  )
    return invalid('package');
  if (input.packageFormat !== 'moya.extension.package') return invalid('packageFormat');
  if (input.updates !== undefined) {
    if (
      !record(input.updates) ||
      !keys(input.updates, ['repository']) ||
      typeof input.updates.repository !== 'string' ||
      input.updates.repository.length > 2048
    )
      return invalid('updates');
    try {
      const url = new URL(input.updates.repository);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        url.hostname.includes('*') ||
        url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost')
      )
        return invalid('updates.repository');
    } catch {
      return invalid('updates.repository');
    }
  }
  if (input.packageVersion !== 1) return { ok: false, code: 'unsupported_package_api', path: 'packageVersion' };
  const extension = validateExtensionManifest(input.extension);
  if (!extension.ok) return invalid('extension');
  const version = extension.manifest.version;
  if (
    version.length > 96 ||
    !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(version) ||
    version
      .split('-')
      .slice(1)
      .join('-')
      .split('.')
      .some((part) => /^0\d+$/.test(part))
  )
    return invalid('extension.version');
  if (extension.manifest.id.startsWith('moya.') || extension.manifest.id.startsWith('noveldesk.'))
    return invalid('extension.id');
  // Installation does not turn a third-party package into a compiled trusted React/workflow extension.
  if (
    extension.manifest.permissions.some(
      (permission) =>
        !['external.source.list', 'external.source.download', 'book.enrichment.propose'].includes(permission),
    )
  ) {
    return { ok: false, code: 'unsupported_package_api', path: 'extension.permissions' };
  }
  const contributions = extension.manifest.contributes;
  if (
    input.preferences !== undefined &&
    !validSourcePreferenceDefinitions(
      input.preferences,
      (contributions?.externalSources ?? []).map((source) => source.id),
    )
  )
    return invalid('preferences');
  if (
    !contributions ||
    !keys(contributions, ['externalSources', 'bookEnrichmentProviders']) ||
    !(contributions.externalSources?.length || contributions.bookEnrichmentProviders?.length)
  )
    return invalid('extension.contributes');
  const contributionIds = [
    ...(contributions.externalSources ?? []),
    ...(contributions.bookEnrichmentProviders ?? []),
  ].map(({ id }) => id);
  if (contributionIds.some((id) => !id.startsWith(`${extension.manifest.id}.`)))
    return invalid('extension.contributes.id');
  if (!record(input.execution) || !keys(input.execution, ['kind', 'apiVersion', 'entry'])) return invalid('execution');
  if (input.execution.kind !== 'moya-js' || input.execution.apiVersion !== 1)
    return { ok: false, code: 'unsupported_package_api', path: 'execution' };
  if (input.execution.entry !== 'dist/main.js') return invalid('execution.entry');
  if (
    !record(input.requestedAccess) ||
    !keys(input.requestedAccess, ['networkOrigins', 'storageKiB', 'authentication', 'contentServices', 'webview'])
  )
    return invalid('requestedAccess');
  if (input.requestedAccess.webview !== undefined && typeof input.requestedAccess.webview !== 'boolean')
    return invalid('requestedAccess.webview');
  const origins = input.requestedAccess.networkOrigins;
  if (
    !Array.isArray(origins) ||
    origins.length > 16 ||
    new Set(origins).size !== origins.length ||
    origins.some((origin) => {
      if (typeof origin !== 'string' || origin.length > 256) return true;
      try {
        const url = new URL(origin);
        return (
          url.protocol !== 'https:' ||
          url.origin !== origin ||
          url.hostname.includes('*') ||
          Boolean(url.username || url.password) ||
          url.hostname === 'localhost' ||
          url.hostname.endsWith('.localhost')
        );
      } catch {
        return true;
      }
    })
  )
    return invalid('requestedAccess.networkOrigins');
  const storage = input.requestedAccess.storageKiB;
  if (!Number.isInteger(storage) || (storage as number) < 0 || (storage as number) > 1024)
    return invalid('requestedAccess.storageKiB');
  if (
    input.requestedAccess.authentication !== undefined &&
    !validateSourceAuthentication(
      input.requestedAccess.authentication,
      (contributions.externalSources ?? []).map(({ id }) => id),
      origins,
    )
  )
    return invalid('requestedAccess.authentication');
  if (
    input.requestedAccess.contentServices !== undefined &&
    (!extension.manifest.permissions.includes('external.source.download') ||
      !validateSourceContentServices(
        input.requestedAccess.contentServices,
        (contributions.externalSources ?? [])
          .filter((source) => source.schemaVersion === 2 && source.seriesProfile?.kind === 'document_series')
          .map(({ id }) => id),
        origins,
      ))
  )
    return invalid('requestedAccess.contentServices');
  if (
    typeof input.license !== 'string' ||
    input.license.length < 1 ||
    input.license.length > 128 ||
    /[\r\n]/.test(input.license) ||
    input.license.includes(String.fromCharCode(0))
  )
    return invalid('license');
  return { ok: true, manifest: input as unknown as MoyaPackageManifestV1 };
}

/** Portable path rules are identical before extraction on Windows, Linux and browser hosts. */
export function isMoyaPackagePath(path: string): boolean {
  if (path.length === 0 || path.length > 180 || path.includes('\\') || !/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  return path
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    );
}
