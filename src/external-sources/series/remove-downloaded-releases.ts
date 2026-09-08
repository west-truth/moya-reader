import {
  buildDocumentSeriesArchive,
  readDocumentSeriesArchive,
  REMOTE_DOCUMENT_IDENTITY_SCHEME,
} from '@noveldesk/document-series-core';
import { buildComicRemovalDelta } from '@noveldesk/fixed-document-core/comic-source';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ImportService } from '../../services/import/import-service';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';

/** Keep the book identity/links; availability is projected from the committed chapters. */
export async function removeDownloadedReleases(options: {
  bookId: string;
  sectionIds: readonly string[];
  assets: BookAssetRepository;
  importService: ImportService;
  getNovel(id: string): Promise<Novel | undefined>;
}): Promise<Novel> {
  const novel = await options.getNovel(options.bookId);
  if (!novel || novel.deletedAt || !novel.activeContentRevisionId)
    throw new Error('작품의 현재 본문을 확인하지 못했습니다.');
  const ids = new Set(options.sectionIds);
  if (!ids.size) throw new Error('삭제할 회차를 선택해 주세요.');
  if (novel.format === 'image_archive') {
    if (!options.importService.supportsIncrementalImageSeriesAppend)
      throw new Error('이 환경은 만화 회차 삭제를 지원하지 않습니다.');
    const file = await buildComicRemovalDelta(novel.id, [...ids]);
    await options.importService.importFile(
      {
        file,
        encoding: 'auto',
        clientBookId: novel.id,
        importMode: 'append_image_series',
        baseActiveContentRevisionId: novel.activeContentRevisionId,
      },
      () => {},
    ).promise;
  } else if (novel.format === 'txt') {
    if (!options.importService.supportsExpectedBase)
      throw new Error('이 환경은 안전한 텍스트 회차 삭제를 지원하지 않습니다.');
    const source = await options.assets.exportSource(novel.id);
    const normalize = (value: string | undefined) => value?.replace(/^sha256:/u, '').toLowerCase();
    if (!source || normalize(await hashBlobInChunks(source.blob)) !== normalize(novel.sourceContentHash))
      throw new Error('작품 원본이 변경되었습니다. 다시 시도해 주세요.');
    const archive = await readDocumentSeriesArchive(source.blob);
    if (
      !archive ||
      archive.manifest.schemaVersion !== 2 ||
      [...ids].some((id) => !archive.manifest.sources.some((value) => value.id === id))
    )
      throw new Error('삭제할 텍스트 회차의 원본을 확인하지 못했습니다.');
    const file = await buildDocumentSeriesArchive({
      collection: archive.manifest.collection,
      identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
      sources: archive.manifest.sources
        .filter((value) => !ids.has(value.id))
        .map((value) => ({ ...value, blob: archive.sources.get(value.id)! })),
    });
    await options.importService.importFile(
      {
        file,
        encoding: 'utf-8',
        chapterSplitMode: 'single',
        clientBookId: novel.id,
        expectedBase: { kind: 'revision', contentRevisionId: novel.activeContentRevisionId },
      },
      () => {},
    ).promise;
  } else {
    throw new Error('이 작품은 소스 회차 삭제를 지원하지 않습니다.');
  }
  const updated = await options.getNovel(novel.id);
  if (!updated || updated.deletedAt) throw new Error('삭제 후 작품 상태를 확인하지 못했습니다.');
  if (updated.activeContentRevisionId)
    await options.assets.cleanupRemovedDownloads?.(novel.id, updated.activeContentRevisionId);
  return updated;
}
