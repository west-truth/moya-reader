import { decodeNovelTextWithEncoding } from '../../domain/parser';
import { sha256 } from '../../domain/hash';
import type { ChapterSplitMode, EncodingMode } from '../../domain/types';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { saveParsedNovelImport } from '../../storage/db';
import { getActiveBookSourceSnapshot, getActiveComicAssetMetadata } from '../../storage/book-asset-store';
import { ContentRevisionConflictError } from '../../storage/content-revisions';
import { hashBlobInChunks } from './chunked-file-reader';
import {
  COMIC_SOURCE_CONTENT_TYPE,
  comicPageAssetId,
  materializeComicSource,
  planComicSourceAppend,
  unpackComicSource,
} from '@noveldesk/fixed-document-core/comic-source';
import { persistentId128 } from '@noveldesk/text-core/hash';
import { withComicAppendLock } from './comic-append-lock';
import {
  parseDecodedNovelTextForImportCooperatively,
  type CooperativeImportParseProgress,
} from './cooperative-import-parser';
import type { ImportProgress, ImportProgressSubphase, ImportResult } from './import-service';

export const BROWSER_IMPORT_WRITE_BATCH_PAGES = 16;

export interface BrowserImportPipelineInput {
  jobId: string;
  fileName: string;
  buffer: ArrayBuffer;
  sourceBlob?: Blob;
  totalBytes: number;
  encoding: EncodingMode;
  chapterSplitMode?: ChapterSplitMode;
  clientBookId?: string;
  expectedBase?: import('./import-service').ImportExpectedBase;
  importMode?: 'replace_book' | 'append_image_series';
  baseActiveContentRevisionId?: string;
  expectedSourceContentHash?: string;
  expectedBaseActiveContentRevisionId?: string;
  preserveExistingEmbeddedAssets?: boolean;
  preserveExistingCover?: boolean;
  expectedNormalizedTextHash?: string;
  archivePassword?: string;
  shouldCancel?: () => boolean;
  onProgress: (progress: ImportProgress) => void;
  yieldControl?: () => Promise<void>;
}

function importAbortError(): Error {
  return new DOMException('Import cancelled', 'AbortError') as Error;
}

function throwIfCancelled(input: BrowserImportPipelineInput): void {
  if (input.shouldCancel?.()) throw importAbortError();
}

function assertExpectedNormalizedTextHash(input: BrowserImportPipelineInput, actual: string): void {
  if (input.expectedNormalizedTextHash && input.expectedNormalizedTextHash !== actual) {
    throw new Error('가져온 원본의 본문 식별자가 예상한 Cloud Vault 기록과 다릅니다.');
  }
}

function assertExpectedSourceContentHash(input: BrowserImportPipelineInput, actual: string): void {
  if (
    input.expectedSourceContentHash &&
    normalizedContentHash(input.expectedSourceContentHash) !== normalizedContentHash(actual)
  ) {
    throw new Error('가져온 원본의 식별자가 예상한 기록과 다릅니다.');
  }
}

function normalizedContentHash(value: string): string {
  return value
    .replace(/^sha256:/iu, '')
    .trim()
    .toLocaleLowerCase();
}

async function runBrowserImageSeriesAppendPipeline(input: BrowserImportPipelineInput): Promise<ImportResult> {
  if (input.expectedBase) throw new Error('expectedBase cannot be combined with append_image_series');
  const bookId = input.clientBookId;
  const deltaArchive = input.sourceBlob;
  if (!bookId || !deltaArchive) throw new Error('추가할 만화 회차의 작품 정보가 없습니다.');
  if (!input.baseActiveContentRevisionId) throw new Error('회차를 추가할 기준 본문 revision이 없습니다.');
  const deltaHash = await hashBlobInChunks(deltaArchive, {
    shouldCancel: input.shouldCancel,
    onProgress: ({ bytesRead }) =>
      input.onProgress(
        pipelineProgress(input, bytesRead, 'decoding', 'hashing_source', {
          message: `추가할 회차를 확인하는 중입니다. ${bytesRead.toLocaleString()} / ${input.totalBytes.toLocaleString()} 바이트`,
        }),
      ),
  });
  if (
    input.expectedSourceContentHash &&
    normalizedContentHash(input.expectedSourceContentHash) !== normalizedContentHash(deltaHash)
  ) {
    throw new Error('추가할 만화 회차의 원본 식별자가 다릅니다.');
  }

  let lastConflict: ContentRevisionConflictError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfCancelled(input);
    const snapshot = await getActiveBookSourceSnapshot(bookId);
    if (!snapshot || snapshot.novel.format !== 'image_archive' || !snapshot.novel.documentSectionCount) {
      throw new Error('기존 만화 작품의 원본을 찾지 못해 회차를 추가할 수 없습니다.');
    }
    const mergeController = new AbortController();
    const cancelPoll = input.shouldCancel
      ? setInterval(() => {
          if (input.shouldCancel?.()) mergeController.abort();
        }, 50)
      : undefined;
    let merged: Awaited<ReturnType<typeof planComicSourceAppend>>;
    try {
      merged = await planComicSourceAppend({
        existingSource: snapshot.blob,
        existingSourceHash: snapshot.metadata.contentHash,
        delta: deltaArchive,
        deltaHash,
        bookId,
        signal: mergeController.signal,
        existingAssets: await getActiveComicAssetMetadata(bookId),
      });
    } finally {
      if (cancelPoll !== undefined) clearInterval(cancelPoll);
    }
    throwIfCancelled(input);
    if (
      snapshot.novel.activeContentRevisionId !== input.baseActiveContentRevisionId &&
      merged.replacedSectionIds.length > 0
    ) {
      throw new ContentRevisionConflictError(
        '같은 회차가 다른 작업에서 먼저 변경되어 오래된 회차 파일로 덮어쓰지 않았습니다.',
      );
    }
    if (!merged.changedSectionIds.length) {
      const latest = await getActiveBookSourceSnapshot(bookId);
      if (
        latest &&
        latest.novel.activeContentRevisionId === snapshot.novel.activeContentRevisionId &&
        latest.metadata.contentHash.toLocaleLowerCase() === snapshot.metadata.contentHash.toLocaleLowerCase()
      ) {
        input.onProgress(
          pipelineProgress(input, input.totalBytes, 'ready', 'complete', {
            chaptersDetected: snapshot.novel.documentSectionCount,
            paragraphsWritten: snapshot.novel.totalParagraphs,
            message: '선택한 회차가 이미 작품에 들어 있습니다.',
          }),
        );
        return { novel: latest.novel };
      }
      continue;
    }
    try {
      const fileName = snapshot.metadata.fileName ?? snapshot.novel.sourceFileName;
      const parsed = await materializeComicSource({
        manifest: merged.manifest,
        sourceContentHash: merged.sourceContentHash,
        fileName,
        bookId,
        partsToStore: merged.newParts,
        pagePartsToRead: new Map([...merged.newParts].filter(([hash]) => hash !== snapshot.metadata.contentHash)),
        signal: mergeController.signal,
        pageAssetIds: merged.pageAssetIds,
      });
      await saveParsedNovelImport(parsed, {
        batchPageCount: BROWSER_IMPORT_WRITE_BATCH_PAGES,
        shouldCancel: input.shouldCancel,
        expectedBaseActiveContentRevisionId: snapshot.novel.activeContentRevisionId,
        preserveExistingCover: true,
        retainedEmbeddedAssetIds: [...merged.retainedPageIds, ...merged.retainedPartIds],
        embeddedAssetPageIndexes: Object.fromEntries(merged.pageAssetIds.map((id, index) => [id, index])),
        sourceAsset: {
          blob: merged.source,
          fileName,
          contentType: COMIC_SOURCE_CONTENT_TYPE,
          contentHash: merged.sourceContentHash,
        },
        onProgress: (progress) =>
          input.onProgress(
            pipelineProgress(input, input.totalBytes, 'writing', progress.phase, {
              chaptersDetected: parsed.chapters.length,
              paragraphsWritten: progress.paragraphsWritten,
              message:
                progress.phase === 'activating_revision'
                  ? '회차 목록을 적용하는 중입니다.'
                  : '새 회차를 저장하는 중입니다.',
            }),
          ),
      });
      input.onProgress(
        pipelineProgress(input, input.totalBytes, 'ready', 'complete', { message: '회차를 추가했습니다.' }),
      );
      return { novel: parsed.novel };
    } catch (error) {
      if (!(error instanceof ContentRevisionConflictError)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? new ContentRevisionConflictError('만화 회차를 추가하는 동안 작품이 계속 변경되었습니다.');
}

async function defaultYieldControl(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function reportAndYield(input: BrowserImportPipelineInput, progress: ImportProgress): Promise<void> {
  throwIfCancelled(input);
  input.onProgress(progress);
  await (input.yieldControl ?? defaultYieldControl)();
  throwIfCancelled(input);
}

function parserProgressMessage(progress: CooperativeImportParseProgress): string {
  switch (progress.phase) {
    case 'normalizing_text':
      return '본문의 줄바꿈과 공백을 정리하는 중입니다.';
    case 'hashing_normalized_text':
      return '정리한 본문의 무결성을 확인하는 중입니다.';
    case 'detecting_chapters':
      return '장 제목과 본문 경계를 찾는 중입니다.';
    case 'building_chapters':
      return progress.totalChapters > 0
        ? `장 구조를 만드는 중입니다. ${progress.chaptersProcessed.toLocaleString()} / ${progress.totalChapters.toLocaleString()}개 화`
        : '장 구조를 만드는 중입니다.';
  }
}

function parserProgressStatus(progress: CooperativeImportParseProgress): ImportProgress['status'] {
  return progress.phase === 'normalizing_text' || progress.phase === 'hashing_normalized_text'
    ? 'decoding'
    : 'splitting_chapters';
}

function pipelineProgress(
  input: BrowserImportPipelineInput,
  bytesRead: number,
  status: ImportProgress['status'],
  subphase: ImportProgressSubphase,
  overrides: Partial<Pick<ImportProgress, 'chaptersDetected' | 'paragraphsWritten' | 'message'>> = {},
): ImportProgress {
  return {
    jobId: input.jobId,
    status,
    subphase,
    bytesRead,
    totalBytes: input.totalBytes,
    chaptersDetected: overrides.chaptersDetected ?? 0,
    paragraphsWritten: overrides.paragraphsWritten ?? 0,
    message: overrides.message,
  };
}

async function decodeImportSource(input: BrowserImportPipelineInput) {
  const buffer = input.buffer;
  const bytesRead = buffer.byteLength;
  await reportAndYield(
    input,
    pipelineProgress(input, bytesRead, 'decoding', 'hashing_source', {
      message: '원본 파일의 무결성을 확인하는 중입니다.',
    }),
  );
  const rawTextHash = await sha256(buffer);

  await reportAndYield(
    input,
    pipelineProgress(input, bytesRead, 'decoding', 'decoding_text', {
      message: '파일 인코딩을 해석하는 중입니다.',
    }),
  );
  const decoded = decodeNovelTextWithEncoding(buffer, input.encoding);
  return { bytesRead, decoded, rawTextHash };
}

export async function runBrowserImportPipeline(input: BrowserImportPipelineInput): Promise<ImportResult> {
  const { bytesRead, decoded, rawTextHash } = await decodeImportSource(input);
  assertExpectedSourceContentHash(input, rawTextHash);
  input.buffer = new ArrayBuffer(0);
  throwIfCancelled(input);

  const parsed = await parseDecodedNovelTextForImportCooperatively(input.fileName, decoded, rawTextHash, {
    chapterSplitMode: input.chapterSplitMode ?? 'auto',
    clientBookId: input.clientBookId,
    shouldCancel: input.shouldCancel,
    yieldControl: input.yieldControl,
    onProgress: (progress) => {
      input.onProgress(
        pipelineProgress(input, bytesRead, parserProgressStatus(progress), progress.phase, {
          chaptersDetected: progress.chaptersProcessed,
          message: parserProgressMessage(progress),
        }),
      );
    },
  });
  throwIfCancelled(input);
  assertExpectedNormalizedTextHash(input, parsed.novel.normalizedTextHash);

  input.onProgress(
    pipelineProgress(input, bytesRead, 'writing', 'staging_chapters', {
      chaptersDetected: parsed.chapters.length,
      message: '장 메타데이터를 임시 저장하는 중입니다.',
    }),
  );

  await saveParsedNovelImport(parsed, {
    expectedBase: input.expectedBase,
    batchPageCount: BROWSER_IMPORT_WRITE_BATCH_PAGES,
    shouldCancel: input.shouldCancel,
    sourceAsset: input.sourceBlob
      ? {
          blob: input.sourceBlob,
          fileName: input.fileName,
          contentType: input.sourceBlob.type || 'text/plain',
          contentHash: parsed.novel.rawTextHash,
          encoding: parsed.novel.sourceEncoding,
        }
      : undefined,
    onProgress: (writeProgress) => {
      throwIfCancelled(input);
      const activatingRevision = writeProgress.phase === 'activating_revision';
      input.onProgress(
        pipelineProgress(input, bytesRead, 'writing', writeProgress.phase, {
          chaptersDetected: writeProgress.totalChapters,
          paragraphsWritten: writeProgress.paragraphsWritten,
          message: activatingRevision
            ? '본문 인덱스를 최종 적용하는 중입니다.'
            : `본문을 저장하는 중입니다. ${writeProgress.paragraphsWritten.toLocaleString()} / ${writeProgress.totalParagraphs.toLocaleString()} 문단`,
        }),
      );
    },
  });

  input.onProgress(
    pipelineProgress(input, bytesRead, 'ready', 'complete', {
      chaptersDetected: parsed.chapters.length,
      paragraphsWritten: parsed.novel.totalParagraphs,
      message: '가져오기가 완료되었습니다.',
    }),
  );
  return { novel: parsed.novel };
}

export async function runBrowserEpubImportPipeline(input: BrowserImportPipelineInput): Promise<ImportResult> {
  const bytes = new Uint8Array(input.buffer);
  await reportAndYield(
    input,
    pipelineProgress(input, bytes.byteLength, 'decoding', 'decoding_text', {
      message: 'EPUB 목차와 본문 구조를 해석하는 중입니다.',
    }),
  );
  const { materializeEpubImport, parseEpub } = await import('@noveldesk/epub-core');
  const document = await parseEpub(new Blob([bytes], { type: 'application/epub+zip' }));
  throwIfCancelled(input);
  const parsed = materializeEpubImport(document, {
    fileName: input.fileName,
    sourceBytes: bytes,
    clientBookId: input.clientBookId,
  });
  assertExpectedSourceContentHash(input, parsed.novel.rawTextHash);
  assertExpectedNormalizedTextHash(input, parsed.novel.normalizedTextHash);
  input.buffer = new ArrayBuffer(0);
  input.onProgress(
    pipelineProgress(input, bytes.byteLength, 'writing', 'staging_chapters', {
      chaptersDetected: parsed.chapters.length,
      message: 'EPUB 본문과 내장 이미지를 임시 저장하는 중입니다.',
    }),
  );
  await saveParsedNovelImport(parsed, {
    expectedBase: input.expectedBase,
    batchPageCount: BROWSER_IMPORT_WRITE_BATCH_PAGES,
    shouldCancel: input.shouldCancel,
    sourceAsset: input.sourceBlob
      ? {
          blob: input.sourceBlob,
          fileName: input.fileName,
          contentType: 'application/epub+zip',
          contentHash: parsed.novel.rawTextHash,
        }
      : undefined,
    onProgress: (writeProgress) => {
      throwIfCancelled(input);
      input.onProgress(
        pipelineProgress(input, bytes.byteLength, 'writing', writeProgress.phase, {
          chaptersDetected: writeProgress.totalChapters,
          paragraphsWritten: writeProgress.paragraphsWritten,
          message:
            writeProgress.phase === 'activating_revision'
              ? 'EPUB 문서와 리소스를 최종 적용하는 중입니다.'
              : `EPUB 본문을 저장하는 중입니다. ${writeProgress.paragraphsWritten.toLocaleString()} / ${writeProgress.totalParagraphs.toLocaleString()} 블록`,
        }),
      );
    },
  });
  input.onProgress(
    pipelineProgress(input, bytes.byteLength, 'ready', 'complete', {
      chaptersDetected: parsed.chapters.length,
      paragraphsWritten: parsed.novel.totalParagraphs,
      message: 'EPUB 가져오기가 완료되었습니다.',
    }),
  );
  return { novel: parsed.novel };
}

export async function runBrowserFixedDocumentImportPipeline(input: BrowserImportPipelineInput): Promise<ImportResult> {
  if (input.importMode === 'append_image_series')
    return withComicAppendLock(input.clientBookId ?? '', () => runBrowserImageSeriesAppendPipeline(input));
  const bytes = new Uint8Array(input.buffer);
  const isPdf = /\.pdf$/i.test(input.fileName);
  let sourceBlob = input.sourceBlob;
  const comicPackage =
    sourceBlob && /\.(zip|cbz)$/i.test(input.fileName) ? await unpackComicSource(sourceBlob) : undefined;
  const { DOCUMENT_SERIES_CONTENT_TYPE, hasDocumentSeriesManifest, materializeDocumentSeriesArchive } =
    await import('@noveldesk/document-series-core');
  const isDocumentSeries = Boolean(
    sourceBlob && /\.zip$/i.test(input.fileName) && (await hasDocumentSeriesManifest(sourceBlob)),
  );
  const streamsArchiveEntries =
    !isPdf && /\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(input.fileName) && Boolean(input.sourceBlob);
  const processedBytes = streamsArchiveEntries ? input.totalBytes : bytes.byteLength;
  await reportAndYield(
    input,
    pipelineProgress(
      input,
      streamsArchiveEntries ? 0 : processedBytes,
      'decoding',
      streamsArchiveEntries ? 'hashing_source' : 'decoding_text',
      {
        message: isPdf
          ? 'PDF 페이지 구조를 해석하는 중입니다.'
          : isDocumentSeries
            ? '연재 문서의 원본과 회차 구성을 검사하는 중입니다.'
            : '이미지 압축 파일의 페이지를 검사하는 중입니다.',
      },
    ),
  );
  const {
    imageArchiveContentType,
    materializeImageArchiveImport,
    materializePdfImport,
    materializeStreamingImageArchiveImport,
    openImageArchiveStream,
    parseImageArchive,
  } = await import('@noveldesk/fixed-document-core');
  const parsed = comicPackage
    ? await materializeComicSource({
        manifest: comicPackage.manifest,
        sourceContentHash: await hashBlobInChunks(comicPackage.source, { shouldCancel: input.shouldCancel }),
        fileName: input.fileName,
        bookId: input.clientBookId || persistentId128('comic_book', [await hashBlobInChunks(comicPackage.source)]),
        partsToStore: comicPackage.parts,
        pagePartsToRead: comicPackage.parts,
      })
    : isDocumentSeries
      ? await (async () => {
          const sourceContentHash = await hashBlobInChunks(sourceBlob!, {
            shouldCancel: input.shouldCancel,
            onProgress: ({ bytesRead }) =>
              input.onProgress(
                pipelineProgress(input, bytesRead, 'decoding', 'hashing_source', {
                  message: `연재 문서 원본을 확인하는 중입니다. ${bytesRead.toLocaleString()} / ${input.totalBytes.toLocaleString()} 바이트`,
                }),
              ),
          });
          return materializeDocumentSeriesArchive(sourceBlob!, {
            fileName: input.fileName,
            clientBookId: input.clientBookId,
            sourceContentHash,
          });
        })()
      : streamsArchiveEntries
        ? await (async () => {
            const archiveBlob = input.sourceBlob!;
            const sourceContentHash = await hashBlobInChunks(archiveBlob, {
              shouldCancel: input.shouldCancel,
              onProgress: ({ bytesRead }) =>
                input.onProgress(
                  pipelineProgress(input, bytesRead, 'decoding', 'hashing_source', {
                    message: `압축 원본을 확인하는 중입니다. ${bytesRead.toLocaleString()} / ${input.totalBytes.toLocaleString()} 바이트`,
                  }),
                ),
            });
            const document = await openImageArchiveStream(archiveBlob, {
              fileName: input.fileName,
              password: input.archivePassword,
            });
            let pagesPrepared = 0;
            return materializeStreamingImageArchiveImport({
              fileName: input.fileName,
              sourceContentHash,
              clientBookId: input.clientBookId,
              document: {
                pages: document.pages,
                comicInfo: document.comicInfo,
                moyaSeries: document.moyaSeries,
                async *consumePages() {
                  for await (const page of document.consumePages()) {
                    throwIfCancelled(input);
                    pagesPrepared += 1;
                    input.onProgress(
                      pipelineProgress(input, input.totalBytes, 'writing', 'staging_chapters', {
                        chaptersDetected: document.pages.length,
                        paragraphsWritten: pagesPrepared,
                        message: `이미지 페이지를 저장하는 중입니다. ${pagesPrepared.toLocaleString()} / ${document.pages.length.toLocaleString()}개`,
                      }),
                    );
                    yield page;
                  }
                },
              },
            });
          })()
        : isPdf
          ? await materializePdfImport({
              fileName: input.fileName,
              sourceBytes: bytes,
              clientBookId: input.clientBookId,
              workerSrc: pdfWorkerUrl,
            })
          : materializeImageArchiveImport({
              fileName: input.fileName,
              sourceBytes: bytes,
              document: await parseImageArchive(new Blob([bytes]), {
                fileName: input.fileName,
                password: input.archivePassword,
              }),
              clientBookId: input.clientBookId,
            });
  throwIfCancelled(input);
  if (comicPackage) sourceBlob = comicPackage.source;
  assertExpectedSourceContentHash(input, parsed.novel.rawTextHash);
  assertExpectedNormalizedTextHash(input, parsed.novel.normalizedTextHash);
  input.buffer = new ArrayBuffer(0);
  input.onProgress(
    pipelineProgress(input, processedBytes, 'writing', 'staging_chapters', {
      chaptersDetected: parsed.chapters.length,
      message: isPdf
        ? 'PDF 문서 정보를 저장하는 중입니다.'
        : isDocumentSeries
          ? '연재 문서의 회차와 원본을 임시 저장하는 중입니다.'
          : '이미지 페이지를 임시 저장하는 중입니다.',
    }),
  );
  await saveParsedNovelImport(parsed, {
    expectedBase: input.expectedBase,
    batchPageCount: BROWSER_IMPORT_WRITE_BATCH_PAGES,
    allowAppendDelta: isDocumentSeries,
    // Reused immutable pages may move when a synced package adds earlier chapters.
    // Publish their new positions with the revision, just like the append path.
    embeddedAssetPageIndexes: comicPackage
      ? Object.fromEntries(
          comicPackage.manifest.sourcePages.map((page, index) => [comicPageAssetId(parsed.novel.id, page), index]),
        )
      : undefined,
    expectedBaseActiveContentRevisionId: input.expectedBaseActiveContentRevisionId,
    preserveExistingEmbeddedAssets: input.preserveExistingEmbeddedAssets,
    preserveExistingCover: input.preserveExistingCover,
    shouldCancel: input.shouldCancel,
    sourceAsset: sourceBlob
      ? {
          blob: sourceBlob,
          fileName: input.fileName,
          contentType: comicPackage
            ? COMIC_SOURCE_CONTENT_TYPE
            : isPdf
              ? 'application/pdf'
              : isDocumentSeries
                ? DOCUMENT_SERIES_CONTENT_TYPE
                : imageArchiveContentType(input.fileName),
          contentHash: parsed.novel.rawTextHash,
        }
      : undefined,
    onProgress: (writeProgress) => {
      throwIfCancelled(input);
      input.onProgress(
        pipelineProgress(input, processedBytes, 'writing', writeProgress.phase, {
          chaptersDetected: writeProgress.totalChapters,
          paragraphsWritten: streamsArchiveEntries ? parsed.novel.totalParagraphs : writeProgress.paragraphsWritten,
          message:
            writeProgress.phase === 'activating_revision'
              ? '문서와 페이지를 최종 적용하는 중입니다.'
              : isDocumentSeries
                ? `회차 본문을 저장하는 중입니다. ${writeProgress.paragraphsWritten.toLocaleString()} / ${writeProgress.totalParagraphs.toLocaleString()}문단`
                : `페이지를 저장하는 중입니다. ${writeProgress.paragraphsWritten.toLocaleString()} / ${writeProgress.totalParagraphs.toLocaleString()}개`,
        }),
      );
    },
  });
  input.onProgress(
    pipelineProgress(input, processedBytes, 'ready', 'complete', {
      chaptersDetected: parsed.chapters.length,
      paragraphsWritten: parsed.novel.totalParagraphs,
      message: `${isPdf ? 'PDF' : isDocumentSeries ? '연재 문서' : '이미지 압축 파일'} 가져오기가 완료되었습니다.`,
    }),
  );
  return { novel: parsed.novel };
}
