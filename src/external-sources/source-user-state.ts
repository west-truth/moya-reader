import { externalItemKeyId, type ExternalItemKey } from './contracts';

export interface SourceReleasePreference {
  readonly id: string;
  readonly kind: 'releasePreference';
  readonly source: ExternalItemKey;
  readonly title?: string;
  readonly read?: boolean;
  readonly readChangedAt?: string;
  readonly updatedAt: string;
}

export interface SourceDownloadQueue {
  readonly id: string;
  readonly kind: 'downloadQueue';
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly collectionRemoteId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly items: readonly {
    readonly key: ExternalItemKey;
    readonly remoteRevision?: string;
    readonly title: string;
    readonly sectionId: string;
  }[];
}

export function releasePreferenceId(key: ExternalItemKey): string {
  return `release-preference:${externalItemKeyId(key)}`;
}

export function sourceDownloadQueueId(key: ExternalItemKey, collectionRemoteId: string): string {
  return `download-queue:${JSON.stringify([key.connectorId, key.accountConnectionId ?? '', collectionRemoteId])}`;
}

export function validReleasePreference(value: unknown): value is SourceReleasePreference {
  if (!value || typeof value !== 'object') return false;
  const item = value as SourceReleasePreference;
  return (
    item.kind === 'releasePreference' &&
    typeof item.source?.connectorId === 'string' &&
    item.source.connectorId.length > 0 &&
    item.source.connectorId.length <= 256 &&
    typeof item.source.remoteId === 'string' &&
    item.source.remoteId.length > 0 &&
    item.source.remoteId.length <= 1024 &&
    (item.source.accountConnectionId === undefined ||
      (typeof item.source.accountConnectionId === 'string' && item.source.accountConnectionId.length <= 256)) &&
    item.id === releasePreferenceId(item.source) &&
    typeof item.updatedAt === 'string' &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    (item.readChangedAt === undefined ||
      (typeof item.readChangedAt === 'string' && Number.isFinite(Date.parse(item.readChangedAt)))) &&
    (item.title === undefined ||
      (typeof item.title === 'string' && item.title.trim().length > 0 && item.title.length <= 200)) &&
    (item.read === undefined || typeof item.read === 'boolean')
  );
}

export function normalizeReleasePreference(item: SourceReleasePreference): SourceReleasePreference {
  return {
    id: item.id,
    kind: 'releasePreference',
    source: {
      connectorId: item.source.connectorId,
      remoteId: item.source.remoteId,
      ...(item.source.accountConnectionId !== undefined
        ? { accountConnectionId: item.source.accountConnectionId }
        : {}),
    },
    updatedAt: item.updatedAt,
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.read !== undefined ? { read: item.read } : {}),
    ...(item.readChangedAt ? { readChangedAt: item.readChangedAt } : {}),
  };
}
