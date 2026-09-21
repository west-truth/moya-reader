import { LOCAL_ARCHIVE_SERIES_TYPE, isLocalArchiveSeries } from '@noveldesk/document-series-core';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
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
  if (source?.metadata.contentType === LOCAL_ARCHIVE_SERIES_TYPE) {
    const index: unknown = JSON.parse(await source.blob.text());
    if (!isLocalArchiveSeries(index)) throw new Error('보관된 원본 목록이 올바르지 않습니다.');
    // Explicit browser export still buffers its final ZIP; don't allocate a multi-GB Blob here.
    if (index.sources.reduce((size, part) => size + part.byteLength, 0) > 500 * 1024 ** 2)
      throw new Error('500MiB를 넘는 합본의 파일 내보내기는 아직 지원하지 않습니다.');
    const writer = new ZipWriter(new BlobWriter('application/zip'), { level: 0, useWebWorkers: false });
    for (const [i, part] of index.sources.entries()) {
      const resource = assets.getComicSourcePart
        ? await assets.getComicSourcePart(bookId, part.contentHash)
        : await assets.getEmbeddedResource(bookId, part.assetId);
      if (
        !resource ||
        resource.metadata.kind !== 'source_part' ||
        resource.metadata.contentHash !== part.contentHash ||
        resource.blob.size !== part.byteLength
      )
        throw new Error('보관된 회차 원본을 찾지 못했습니다.');
      const fileName = part.fileName.replace(/.*[\\/]/u, '') || `original.${index.format === 'epub' ? 'epub' : 'cbz'}`;
      await writer.add(`${String(i + 1).padStart(4, '0')}/${fileName}`, new BlobReader(resource.blob));
    }
    const blob = await writer.close();
    return {
      blob,
      metadata: {
        ...source.metadata,
        fileName: 'original-files.zip',
        contentType: 'application/zip',
        byteLength: blob.size,
        contentHash: await hashBlobInChunks(blob),
      },
    };
  }
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
