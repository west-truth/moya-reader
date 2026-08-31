import type { BookAssetMetadata } from '../domain/types';
import { requestToPromise } from './indexeddb-request';
import { BOOK_ASSET_STORES, type StoredBookAsset } from './book-asset-schema';

export async function activateSourceAssetInTransaction(
  tx: IDBTransaction,
  input: { assetId: string; bookId: string; contentRevisionId: string; activatedAt: string },
): Promise<BookAssetMetadata> {
  const store = tx.objectStore(BOOK_ASSET_STORES.assets);
  const asset = await requestToPromise<StoredBookAsset | undefined>(store.get(input.assetId));
  if (!asset || asset.status !== 'staged' || asset.bookId !== input.bookId) {
    throw new Error(`Staged source asset ${input.assetId} is unavailable`);
  }
  if (asset.contentRevisionId !== input.contentRevisionId) {
    throw new Error(`Source asset ${input.assetId} belongs to another content revision`);
  }
  const active = await requestToPromise<StoredBookAsset[]>(
    store.index('bookId_kind_status').getAll([input.bookId, 'source', 'active']),
  );
  active.forEach((current) => store.put({ ...current, status: 'superseded' } satisfies StoredBookAsset));
  const next: StoredBookAsset = { ...asset, status: 'active', activatedAt: input.activatedAt };
  store.put(next);
  return next;
}

export async function activateEmbeddedAssetsInTransaction(
  tx: IDBTransaction,
  input: {
    assetIds: readonly string[];
    pageIndexes?: Readonly<Record<string, number>>;
    bookId: string;
    contentRevisionId: string;
    activatedAt: string;
    preserveExisting?: boolean;
    preserveExistingCover?: boolean;
  },
): Promise<{ assets: BookAssetMetadata[]; preservedCover?: BookAssetMetadata }> {
  const store = tx.objectStore(BOOK_ASSET_STORES.assets);
  const activated: BookAssetMetadata[] = [];
  const incomingIds = new Set(input.assetIds);
  const activeResources = await requestToPromise<StoredBookAsset[]>(
    store.index('bookId_kind_status').getAll([input.bookId, 'epub_resource', 'active']),
  );
  const activeDocumentPages = await requestToPromise<StoredBookAsset[]>(
    store.index('bookId_kind_status').getAll([input.bookId, 'document_page', 'active']),
  );
  const activeSourceParts = await requestToPromise<StoredBookAsset[]>(
    store.index('bookId_kind_status').getAll([input.bookId, 'source_part', 'active']),
  );
  if (!input.preserveExisting) {
    [...activeResources, ...activeDocumentPages, ...activeSourceParts].forEach((asset) => {
      if (!incomingIds.has(asset.id)) store.put({ ...asset, status: 'superseded' } satisfies StoredBookAsset);
    });
  }
  const activeCovers = await requestToPromise<StoredBookAsset[]>(
    store.index('bookId_kind_status').getAll([input.bookId, 'cover', 'active']),
  );
  const preservedCover =
    input.preserveExisting || input.preserveExistingCover
      ? activeCovers[0]
      : (activeCovers.find((asset) => asset.provenance === 'user_supplied') ??
        activeCovers.find((asset) => asset.provenance === 'approved_enrichment'));
  if (!preservedCover) {
    activeCovers.forEach((asset) => {
      if (!incomingIds.has(asset.id)) store.put({ ...asset, status: 'superseded' } satisfies StoredBookAsset);
    });
  }
  for (const assetId of input.assetIds) {
    const asset = await requestToPromise<StoredBookAsset | undefined>(store.get(assetId));
    if (
      (asset?.status === 'active' || asset?.status === 'superseded') &&
      asset.bookId === input.bookId &&
      (asset.kind === 'cover' ||
        asset.kind === 'epub_resource' ||
        asset.kind === 'document_page' ||
        asset.kind === 'source_part')
    ) {
      // Exact superseded assets were identity-checked during staging and are safe to rebind here.
      const status =
        asset.kind === 'cover' && preservedCover && preservedCover.id !== asset.id ? 'superseded' : 'active';
      const next: StoredBookAsset = {
        ...asset,
        contentRevisionId: input.contentRevisionId,
        pageIndex: input.pageIndexes?.[asset.id] ?? asset.pageIndex,
        status,
        activatedAt: input.activatedAt,
      };
      store.put(next);
      activated.push(next);
      continue;
    }
    if (
      !asset ||
      asset.status !== 'staged' ||
      asset.bookId !== input.bookId ||
      asset.contentRevisionId !== input.contentRevisionId ||
      (asset.kind !== 'cover' &&
        asset.kind !== 'epub_resource' &&
        asset.kind !== 'document_page' &&
        asset.kind !== 'source_part')
    ) {
      throw new Error(`Staged embedded document asset ${assetId} is unavailable`);
    }
    const status = asset.kind === 'cover' && preservedCover ? 'superseded' : 'active';
    const next: StoredBookAsset = { ...asset, status, activatedAt: input.activatedAt };
    store.put(next);
    activated.push(next);
  }
  return { assets: activated, preservedCover };
}
