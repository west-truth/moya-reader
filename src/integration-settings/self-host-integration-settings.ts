import type { ExternalSourceLink } from '../external-sources/contracts';
import type { ExtensionEnablementDocumentV1 } from '../extensions/extension-enablement-store';
import type { WebNovelMetadataCollectorAutomaticApply } from '../services/webnovel-metadata-collector-broker';
import type { ExternalSourceSubscriptionRecord } from '../external-sources/local-state';

export const SELF_HOST_INTEGRATION_SETTINGS_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_SOURCE_SHARED_STATE_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_SOURCE_SHARED_CONNECTION_SCHEMA_VERSION = 1 as const;
export const MAX_SELF_HOST_INTEGRATION_SETTINGS_BYTES = 2 * 1024 * 1024;

export interface SharedWebNovelMetadataSettingsV1 {
  readonly schemaVersion: 1;
  readonly includeAdult: boolean;
  readonly automaticLookup: boolean;
  readonly automaticApply: WebNovelMetadataCollectorAutomaticApply;
}

/** Non-secret source connection hint. Passwords, OAuth tokens and session cookies never enter this document. */
export interface ExternalSourceSharedConnectionV1 {
  readonly schemaVersion: typeof EXTERNAL_SOURCE_SHARED_CONNECTION_SCHEMA_VERSION;
  readonly connectorId: string;
  readonly accountConnectionId: string;
  readonly endpoint: string;
  readonly authMode: 'none' | 'ui_login' | 'basic_auth';
  readonly label: string;
  readonly updatedAt: string;
}

export interface ExternalSourceSharedStateV1 {
  readonly schemaVersion: typeof EXTERNAL_SOURCE_SHARED_STATE_SCHEMA_VERSION;
  readonly connections: readonly ExternalSourceSharedConnectionV1[];
  readonly links: readonly ExternalSourceLink[];
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
}

export interface SelfHostIntegrationSettingsV1 {
  readonly schemaVersion: typeof SELF_HOST_INTEGRATION_SETTINGS_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly extensionEnablement: ExtensionEnablementDocumentV1;
  readonly webNovelMetadata: SharedWebNovelMetadataSettingsV1;
  readonly externalSources: ExternalSourceSharedStateV1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown, maxLength = 4_096): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function isoDate(value: unknown): string | undefined {
  const candidate = text(value, 64);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
}

function stringList(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  const result = value.map((item) => text(item, 1_024));
  return result.every((item): item is string => Boolean(item)) ? result : undefined;
}

function extensionEnablement(value: unknown): ExtensionEnablementDocumentV1 | undefined {
  const input = record(value);
  const enabled = record(input?.enabledByExtensionId);
  if (input?.schemaVersion !== 1 || !enabled || Object.keys(enabled).length > 256) return undefined;
  const normalized: Record<string, boolean> = {};
  for (const [id, state] of Object.entries(enabled)) {
    if (!/^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/.test(id) || !id.includes('.') || typeof state !== 'boolean') {
      return undefined;
    }
    normalized[id] = state;
  }
  return { schemaVersion: 1, enabledByExtensionId: normalized };
}

function webNovelMetadata(value: unknown): SharedWebNovelMetadataSettingsV1 | undefined {
  const input = record(value);
  if (
    input?.schemaVersion !== 1 ||
    typeof input.includeAdult !== 'boolean' ||
    typeof input.automaticLookup !== 'boolean' ||
    (input.automaticApply !== 'off' && input.automaticApply !== 'missing_fields')
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    includeAdult: input.includeAdult,
    automaticLookup: input.automaticLookup,
    automaticApply: input.automaticApply,
  };
}

function sharedConnection(value: unknown): ExternalSourceSharedConnectionV1 | undefined {
  const input = record(value);
  const connectorId = text(input?.connectorId, 256);
  const accountConnectionId = text(input?.accountConnectionId, 256);
  const endpoint = text(input?.endpoint, 4_096);
  const label = text(input?.label, 256);
  const updatedAt = isoDate(input?.updatedAt);
  if (
    input?.schemaVersion !== 1 ||
    !connectorId ||
    !accountConnectionId ||
    !endpoint ||
    !label ||
    !updatedAt ||
    !['none', 'ui_login', 'basic_auth'].includes(String(input.authMode))
  ) {
    return undefined;
  }
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    schemaVersion: 1,
    connectorId,
    accountConnectionId,
    endpoint,
    authMode: input.authMode as ExternalSourceSharedConnectionV1['authMode'],
    label,
    updatedAt,
  };
}

function sourceKey(value: unknown): ExternalSourceLink['source'] | undefined {
  const input = record(value);
  const connectorId = text(input?.connectorId, 256);
  const remoteId = text(input?.remoteId, 1_024);
  const accountConnectionId =
    input?.accountConnectionId === undefined ? undefined : text(input.accountConnectionId, 256);
  if (!connectorId || !remoteId || (input?.accountConnectionId !== undefined && !accountConnectionId)) return undefined;
  return { connectorId, remoteId, ...(accountConnectionId ? { accountConnectionId } : {}) };
}

function sourceLink(value: unknown): ExternalSourceLink | undefined {
  const input = record(value);
  const id = text(input?.id, 2_048);
  const source = sourceKey(input?.source);
  const localBookId = text(input?.localBookId, 256);
  const linkedAt = isoDate(input?.linkedAt);
  if (!input || !id || !source || !localBookId || !linkedAt || input.pendingImport !== undefined) return undefined;
  const optional = (field: string, maxLength = 512) =>
    input[field] === undefined ? undefined : text(input[field], maxLength);
  const collectionRemoteId = optional('collectionRemoteId', 1_024);
  const importedRemoteRevision = optional('importedRemoteRevision', 1_024);
  const importedSourceContentHash = optional('importedSourceContentHash', 512);
  const activeContentRevisionId = optional('activeContentRevisionId', 256);
  const lastCheckedAt = input.lastCheckedAt === undefined ? undefined : isoDate(input.lastCheckedAt);
  if (
    (input.collectionRemoteId !== undefined && !collectionRemoteId) ||
    (input.importedRemoteRevision !== undefined && !importedRemoteRevision) ||
    (input.importedSourceContentHash !== undefined && !importedSourceContentHash) ||
    (input.activeContentRevisionId !== undefined && !activeContentRevisionId) ||
    (input.lastCheckedAt !== undefined && !lastCheckedAt)
  ) {
    return undefined;
  }
  return {
    id,
    source,
    localBookId,
    linkedAt,
    ...(collectionRemoteId ? { collectionRemoteId } : {}),
    ...(importedRemoteRevision ? { importedRemoteRevision } : {}),
    ...(importedSourceContentHash ? { importedSourceContentHash } : {}),
    ...(activeContentRevisionId ? { activeContentRevisionId } : {}),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
  };
}

function subscription(value: unknown): ExternalSourceSubscriptionRecord | undefined {
  const input = record(value);
  const id = text(input?.id, 2_048);
  const connectorId = text(input?.connectorId, 256);
  const collectionRemoteId = text(input?.collectionRemoteId, 1_024);
  const navigationRef = text(input?.navigationRef, 2_048);
  const title = text(input?.title, 1_024);
  const knownReleaseIds = stringList(input?.knownReleaseIds, 20_000);
  const newReleaseIds = stringList(input?.newReleaseIds, 20_000);
  const createdAt = isoDate(input?.createdAt);
  const updatedAt = isoDate(input?.updatedAt);
  const lastCheckedAt = isoDate(input?.lastCheckedAt);
  if (
    input?.schemaVersion !== 1 ||
    !id ||
    !connectorId ||
    !collectionRemoteId ||
    !navigationRef ||
    !title ||
    !knownReleaseIds ||
    !newReleaseIds ||
    !createdAt ||
    !updatedAt ||
    !lastCheckedAt ||
    typeof input.availableReleaseCount !== 'number' ||
    !Number.isSafeInteger(input.availableReleaseCount) ||
    input.availableReleaseCount < 0
  ) {
    return undefined;
  }
  const optionalText = (field: string, maxLength: number) =>
    input[field] === undefined ? undefined : text(input[field], maxLength);
  const accountConnectionId = optionalText('accountConnectionId', 256);
  const sourceNavigationRef = optionalText('sourceNavigationRef', 2_048);
  const author = optionalText('author', 1_024);
  const description = optionalText('description', 32_768);
  const thumbnailUrl = optionalText('thumbnailUrl', 32_768);
  const sourceLabel = optionalText('sourceLabel', 256);
  if (
    (input.accountConnectionId !== undefined && !accountConnectionId) ||
    (input.sourceNavigationRef !== undefined && !sourceNavigationRef) ||
    (input.author !== undefined && !author) ||
    (input.description !== undefined && !description) ||
    (input.thumbnailUrl !== undefined && !thumbnailUrl) ||
    (input.sourceLabel !== undefined && !sourceLabel)
  ) {
    return undefined;
  }
  return {
    id,
    connectorId,
    collectionRemoteId,
    navigationRef,
    title,
    knownReleaseIds,
    newReleaseIds,
    availableReleaseCount: input.availableReleaseCount,
    lastCheckedAt,
    createdAt,
    updatedAt,
    schemaVersion: 1,
    ...(accountConnectionId ? { accountConnectionId } : {}),
    ...(sourceNavigationRef ? { sourceNavigationRef } : {}),
    ...(author ? { author } : {}),
    ...(description ? { description } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
  };
}

function externalSources(value: unknown): ExternalSourceSharedStateV1 | undefined {
  const input = record(value);
  if (
    input?.schemaVersion !== 1 ||
    !Array.isArray(input.connections) ||
    !Array.isArray(input.links) ||
    !Array.isArray(input.subscriptions) ||
    input.connections.length > 32 ||
    input.links.length > 50_000 ||
    input.subscriptions.length > 5_000
  ) {
    return undefined;
  }
  const connections = input.connections.map(sharedConnection);
  const links = input.links.map(sourceLink);
  const subscriptions = input.subscriptions.map(subscription);
  if (
    !connections.every((item): item is ExternalSourceSharedConnectionV1 => Boolean(item)) ||
    !links.every((item): item is ExternalSourceLink => Boolean(item)) ||
    !subscriptions.every((item): item is ExternalSourceSubscriptionRecord => Boolean(item))
  ) {
    return undefined;
  }
  return { schemaVersion: 1, connections, links, subscriptions };
}

export function normalizeSelfHostIntegrationSettings(value: unknown): SelfHostIntegrationSettingsV1 | undefined {
  let byteLength: number;
  try {
    byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
  if (byteLength > MAX_SELF_HOST_INTEGRATION_SETTINGS_BYTES) return undefined;
  const input = record(value);
  const updatedAt = isoDate(input?.updatedAt);
  const enablement = extensionEnablement(input?.extensionEnablement);
  const metadata = webNovelMetadata(input?.webNovelMetadata);
  const sources = externalSources(input?.externalSources);
  if (input?.schemaVersion !== 1 || !updatedAt || !enablement || !metadata || !sources) return undefined;
  return {
    schemaVersion: 1,
    updatedAt,
    extensionEnablement: enablement,
    webNovelMetadata: metadata,
    externalSources: sources,
  };
}

function latestById<T>(
  local: readonly T[],
  remote: readonly T[],
  id: (item: T) => string,
  updatedAt: (item: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const item of [...local, ...remote]) {
    const current = merged.get(id(item));
    if (!current || Date.parse(updatedAt(item)) >= Date.parse(updatedAt(current))) merged.set(id(item), item);
  }
  return [...merged.values()].sort((left, right) => id(left).localeCompare(id(right)));
}

function metadataIsDefault(settings: SharedWebNovelMetadataSettingsV1): boolean {
  return !settings.includeAdult && !settings.automaticLookup && settings.automaticApply === 'off';
}

/**
 * Keeps previously device-local data when a self-host is upgraded for the first time.
 * Existing server choices win; missing source associations and extension choices are filled from this device.
 */
export function mergeInitialSelfHostIntegrationSettings(
  remote: SelfHostIntegrationSettingsV1,
  local: SelfHostIntegrationSettingsV1,
): SelfHostIntegrationSettingsV1 {
  const links = latestById(
    local.externalSources.links,
    remote.externalSources.links,
    (item) => item.id,
    (item) => item.lastCheckedAt ?? item.linkedAt,
  );
  return {
    schemaVersion: 1,
    updatedAt: remote.updatedAt,
    extensionEnablement: {
      schemaVersion: 1,
      enabledByExtensionId: {
        ...local.extensionEnablement.enabledByExtensionId,
        ...remote.extensionEnablement.enabledByExtensionId,
      },
    },
    webNovelMetadata:
      metadataIsDefault(remote.webNovelMetadata) && !metadataIsDefault(local.webNovelMetadata)
        ? local.webNovelMetadata
        : remote.webNovelMetadata,
    externalSources: {
      schemaVersion: 1,
      connections: latestById(
        local.externalSources.connections,
        remote.externalSources.connections,
        (item) => item.connectorId,
        (item) => item.updatedAt,
      ),
      links,
      subscriptions: latestById(
        local.externalSources.subscriptions,
        remote.externalSources.subscriptions,
        (item) => item.id,
        (item) => item.updatedAt,
      ),
    },
  };
}
