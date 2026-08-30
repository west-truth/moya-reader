import type { Novel } from '../domain/types';
import type { JsonValue, SyncEvent } from '../sync/types';
import { analysisStatusValue } from './analysis-status';
import { requestToPromise } from './indexeddb-transaction';

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function optionalString(source: Record<string, JsonValue>, key: string, fallback?: string): string | undefined {
  if (!(key in source)) return fallback;
  return typeof source[key] === 'string' && source[key] ? source[key] : undefined;
}

function optionalNumber(source: Record<string, JsonValue>, key: string, fallback?: number): number | undefined {
  if (!(key in source)) return fallback;
  return typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : undefined;
}

export async function applyBookMetadataSyncEvent(tx: IDBTransaction, event: SyncEvent): Promise<void> {
  if (!event.novelId) return;
  const store = tx.objectStore('novels');
  const existing = await requestToPromise<Novel | undefined>(store.get(event.novelId));
  if (!existing) return;
  const payload = record(event.payload);
  const novel = record(payload.novel);
  const title =
    (typeof novel.title === 'string' && novel.title) ||
    (typeof payload.title === 'string' && payload.title) ||
    existing.title;
  const favorite =
    (typeof novel.favorite === 'boolean' ? novel.favorite : undefined) ??
    (typeof payload.favorite === 'boolean' ? payload.favorite : undefined) ??
    existing.favorite;
  const analysisStatus =
    analysisStatusValue(novel.analysisStatus) ?? analysisStatusValue(payload.analysisStatus) ?? existing.analysisStatus;
  const incomingRevision =
    (typeof novel.metadataRevision === 'number' ? novel.metadataRevision : undefined) ??
    (typeof payload.metadataRevision === 'number' ? payload.metadataRevision : undefined) ??
    existing.metadataRevision ??
    0;
  if (incomingRevision < (existing.metadataRevision ?? 0)) return;
  const tags = Array.isArray(novel.tags)
    ? novel.tags.filter((value): value is string => typeof value === 'string')
    : existing.tags;
  store.put({
    ...existing,
    title,
    favorite,
    analysisStatus,
    author: optionalString(novel, 'author', existing.author),
    seriesTitle: optionalString(novel, 'seriesTitle', existing.seriesTitle),
    seriesIndex: optionalNumber(novel, 'seriesIndex', existing.seriesIndex),
    tags,
    description: optionalString(novel, 'description', existing.description),
    language: optionalString(novel, 'language', existing.language),
    coverAssetId: optionalString(novel, 'coverAssetId', existing.coverAssetId),
    coverContentHash: optionalString(novel, 'coverContentHash', existing.coverContentHash),
    coverFit:
      novel.coverFit === 'crop' || novel.coverFit === 'contain' ? novel.coverFit : (existing.coverFit ?? 'crop'),
    coverPositionX: optionalNumber(novel, 'coverPositionX', existing.coverPositionX),
    coverPositionY: optionalNumber(novel, 'coverPositionY', existing.coverPositionY),
    metadataRevision: incomingRevision,
    updatedAt: event.createdAt,
  });
}
