import { decodeNovelTextWithEncoding } from '../../domain/parser';
import { sha256 } from '../../domain/hash';
import type { ChapterSplitMode, EncodingMode } from '../../domain/types';
import { saveParsedNovelImport } from '../../storage/db';
import { hashBlobInChunks } from './chunked-file-reader';
import {
  parseDecodedNovelTextForImportCooperatively,
  type CooperativeImportParseProgress,
} from './cooperative-import-parser';
import type { ImportProgress, ImportProgressSubphase, ImportResult } from './import-service';

export const BROWSER_IMPORT_WRITE_BATCH_PAGES = 4;

export interface BrowserImportPipelineInput {
  jobId: string;
  fileName: string;
  buffer: ArrayBuffer;
  sourceBlob?: Blob;
  totalBytes: number;
  encoding: EncodingMode;
  chapterSplitMode?: ChapterSplitMode;
  clientBookId?: string;
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

  input.onProgress(
    pipelineProgress(input, bytesRead, 'writing', 'staging_chapters', {
      chaptersDetected: parsed.chapters.length,
      message: '장 메타데이터를 임시 저장하는 중입니다.',
    }),
  );

  await saveParsedNovelImport(parsed, {
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
  input.buffer = new ArrayBuffer(0);
  input.onProgress(
    pipelineProgress(input, bytes.byteLength, 'writing', 'staging_chapters', {
      chaptersDetected: parsed.chapters.length,
      message: 'EPUB 본문과 내장 이미지를 임시 저장하는 중입니다.',
    }),
  );
  await saveParsedNovelImport(parsed, {
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
  const bytes = new Uint8Array(input.buffer);
  const isPdf = /\.pdf$/i.test(input.fileName);
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
        message: isPdf ? 'PDF 페이지 구조를 해석하는 중입니다.' : '이미지 압축 파일의 페이지를 검사하는 중입니다.',
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
  const parsed = streamsArchiveEntries
    ? await (async () => {
        const sourceBlob = input.sourceBlob!;
        const sourceContentHash = await hashBlobInChunks(sourceBlob, {
          shouldCancel: input.shouldCancel,
          onProgress: ({ bytesRead }) =>
            input.onProgress(
              pipelineProgress(input, bytesRead, 'decoding', 'hashing_source', {
                message: `압축 원본을 확인하는 중입니다. ${bytesRead.toLocaleString()} / ${input.totalBytes.toLocaleString()} 바이트`,
              }),
            ),
        });
        const document = await openImageArchiveStream(sourceBlob, {
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
  input.buffer = new ArrayBuffer(0);
  input.onProgress(
    pipelineProgress(input, processedBytes, 'writing', 'staging_chapters', {
      chaptersDetected: parsed.chapters.length,
      message: isPdf ? 'PDF 문서 정보를 저장하는 중입니다.' : '이미지 페이지를 임시 저장하는 중입니다.',
    }),
  );
  await saveParsedNovelImport(parsed, {
    batchPageCount: BROWSER_IMPORT_WRITE_BATCH_PAGES,
    shouldCancel: input.shouldCancel,
    sourceAsset: input.sourceBlob
      ? {
          blob: input.sourceBlob,
          fileName: input.fileName,
          contentType: isPdf ? 'application/pdf' : imageArchiveContentType(input.fileName),
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
              : `페이지를 저장하는 중입니다. ${writeProgress.paragraphsWritten.toLocaleString()} / ${writeProgress.totalParagraphs.toLocaleString()}개`,
        }),
      );
    },
  });
  input.onProgress(
    pipelineProgress(input, processedBytes, 'ready', 'complete', {
      chaptersDetected: parsed.chapters.length,
      paragraphsWritten: parsed.novel.totalParagraphs,
      message: `${isPdf ? 'PDF' : '이미지 압축 파일'} 가져오기가 완료되었습니다.`,
    }),
  );
  return { novel: parsed.novel };
}
