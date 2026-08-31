import {
  comicPartAssetId,
  flattenComicSource,
  type ComicSourcePart,
} from '@noveldesk/fixed-document-core/comic-source';
import { hashBlobInChunks } from '../services/import/chunked-file-reader';
import type { BookAssetRepository } from './book-asset-repository';

export async function readComicSourcePart(
  assets: BookAssetRepository,
  bookId: string,
  part: ComicSourcePart,
): Promise<Blob> {
  const resource = assets.getComicSourcePart
    ? await assets.getComicSourcePart(bookId, part.contentHash)
    : await assets.getEmbeddedResource(bookId, comicPartAssetId(bookId, part.contentHash));
  if (
    !resource ||
    resource.metadata.kind !== 'source_part' ||
    resource.metadata.contentHash !== part.contentHash ||
    resource.blob.size !== part.byteLength
  )
    throw new Error('보관된 만화 회차 원본을 찾지 못했습니다.');
  return resource.blob;
}

/** Keep raw exportSource hash-exact for sync. Only an explicit file export reconstructs a normal CBZ. */
export async function exportPortableBookSource(assets: BookAssetRepository | undefined, bookId: string) {
  if (!assets) return undefined;
  const source = await assets.exportSource(bookId);
  if (!source || source.metadata.contentType !== 'application/vnd.moya.comic-manifest+zip') return source;
  const blob = await flattenComicSource(source.blob, (part) => readComicSourcePart(assets, bookId, part));
  return {
    blob,
    metadata: {
      ...source.metadata,
      contentType: 'application/vnd.comicbook+zip',
      byteLength: blob.size,
      contentHash: await hashBlobInChunks(blob),
    },
  };
}
