import { hashSync, stableId } from '../../domain/hash';
import { Chapter, Novel, Paragraph, ParagraphPage } from '../../domain/types';
import { BulkParagraphPageRequest, ReaderRepository } from '../../repositories/reader-repository';
import { BookContentRevisionHandle, openBookContentRevision } from '../../storage/db';
import { ImportController, ImportProgress, ImportResult, ImportService } from './import-service';

export interface LocalNovelUploadBuildProgress {
  chaptersRead: number;
  totalChapters: number;
  paragraphsRead: number;
  totalParagraphs: number;
}

export interface CreateLocalNovelUploadFileOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LocalNovelUploadBuildProgress) => void;
}

export type OpenLocalBookContentRevision = (novelId: string) => Promise<BookContentRevisionHandle>;

interface LocalNovelContentSource {
  listChapters(): Promise<Chapter[]>;
  iterateParagraphPages(request: BulkParagraphPageRequest): AsyncIterable<ParagraphPage>;
}

interface RevisionCapableReaderRepository extends ReaderRepository {
  openContentRevision?(novelId: string): Promise<BookContentRevisionHandle>;
}

const TEXT_FILE_EXTENSION = /\.(txt|md|markdown)$/i;
const ATTACH_PAGE_BATCH_SIZE = 10;
const idleSignal = new AbortController().signal;

function abortError(): DOMException {
  return new DOMException('Local book upload cancelled', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function localNovelUploadFileName(novel: Novel): string {
  const sourceName = novel.sourceFileName?.trim() || `${novel.title || 'book'}.txt`;
  return TEXT_FILE_EXTENSION.test(sourceName) ? sourceName : `${sourceName}.txt`;
}

function localNovelUploadLastModified(novel: Novel): number {
  const seed = `${novel.id}:${novel.normalizedTextHash || novel.rawTextHash}:${novel.totalCharacters}:${novel.totalParagraphs}`;
  return Number.parseInt(hashSync(seed), 16);
}

function shouldIncludeChapterTitle(novel: Novel, chapters: Chapter[], chapter: Chapter): boolean {
  if (!chapter.title.trim()) return false;
  const isSingleFallbackChapter =
    chapters.length === 1 &&
    chapter.index === 1 &&
    chapter.rawStartOffset === 0 &&
    chapter.title.trim() === novel.title.trim();
  return !isSingleFallbackChapter;
}

function appendTextPart(parts: BlobPart[], text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (parts.length) parts.push('\n\n');
  parts.push(trimmed);
  return true;
}

function sortedParagraphs(paragraphs: Paragraph[]): Paragraph[] {
  return [...paragraphs].sort((a, b) => a.index - b.index);
}

async function appendChapterTextParts(
  source: LocalNovelContentSource,
  chapterId: string,
  parts: BlobPart[],
  options: {
    signal?: AbortSignal;
    onParagraphsAppended?: (paragraphsAppended: number) => void;
  } = {},
): Promise<number> {
  const signal = options.signal ?? idleSignal;
  let paragraphsRead = 0;
  for await (const page of source.iterateParagraphPages({
    chapterId,
    signal,
    batchSize: ATTACH_PAGE_BATCH_SIZE,
  })) {
    throwIfAborted(options.signal);
    for (const paragraph of sortedParagraphs(page.paragraphs)) {
      appendTextPart(parts, paragraph.text);
      paragraphsRead += 1;
    }
    options.onParagraphsAppended?.(paragraphsRead);
    throwIfAborted(options.signal);
    await yieldToBrowser();
  }
  throwIfAborted(options.signal);
  return paragraphsRead;
}

async function createLocalNovelUploadFileFromSource(
  source: LocalNovelContentSource,
  novel: Novel,
  options: CreateLocalNovelUploadFileOptions = {},
): Promise<File> {
  const chapters = (await source.listChapters()).sort((a, b) => a.index - b.index);
  const parts: BlobPart[] = [];
  let paragraphsRead = 0;

  for (const [chapterOffset, chapter] of chapters.entries()) {
    throwIfAborted(options.signal);
    if (shouldIncludeChapterTitle(novel, chapters, chapter)) appendTextPart(parts, chapter.title);
    const chapterParagraphsRead = await appendChapterTextParts(source, chapter.id, parts, {
      signal: options.signal,
      onParagraphsAppended: (chapterParagraphsRead) => {
        options.onProgress?.({
          chaptersRead: chapterOffset + 1,
          totalChapters: chapters.length,
          paragraphsRead: paragraphsRead + chapterParagraphsRead,
          totalParagraphs: novel.totalParagraphs,
        });
      },
    });
    paragraphsRead += chapterParagraphsRead;
    await yieldToBrowser();
  }

  if (!parts.length && novel.normalizedText) parts.push(novel.normalizedText);
  throwIfAborted(options.signal);

  return new File(parts, localNovelUploadFileName(novel), {
    type: 'text/plain;charset=utf-8',
    lastModified: localNovelUploadLastModified(novel),
  });
}

export function createLocalNovelUploadFile(
  repository: ReaderRepository,
  novel: Novel,
  options: CreateLocalNovelUploadFileOptions = {},
): Promise<File> {
  return createLocalNovelUploadFileFromSource(
    {
      listChapters: () => repository.listChapters(novel.id),
      iterateParagraphPages: (request) => repository.iterateParagraphPages(request),
    },
    novel,
    options,
  );
}

export class LocalBookAttachService {
  private readonly openContentRevision: OpenLocalBookContentRevision;

  constructor(
    repository: ReaderRepository,
    private readonly uploadService: ImportService,
    openContentRevision?: OpenLocalBookContentRevision,
  ) {
    const revisionCapable = repository as RevisionCapableReaderRepository;
    this.openContentRevision =
      openContentRevision ?? revisionCapable.openContentRevision?.bind(revisionCapable) ?? openBookContentRevision;
  }

  attachNovel(novel: Novel, onProgress: (progress: ImportProgress) => void): ImportController {
    const jobId = stableId('local_attach', `${novel.id}:${Date.now()}`, 12);
    const abortController = new AbortController();
    let remoteController: ImportController | undefined;

    const promise = (async (): Promise<ImportResult> => {
      onProgress({
        jobId,
        status: 'reading',
        bytesRead: 0,
        totalBytes: Math.max(1, novel.totalParagraphs),
        chaptersDetected: 0,
        paragraphsWritten: 0,
        message: '서버 업로드용 본문을 준비하고 있습니다.',
      });

      const contentRevision = await this.openContentRevision(novel.id);
      const pinnedNovel = contentRevision.novel;
      const file = await createLocalNovelUploadFileFromSource(contentRevision, pinnedNovel, {
        signal: abortController.signal,
        onProgress: (progress) => {
          onProgress({
            jobId,
            status: 'reading',
            bytesRead: progress.paragraphsRead,
            totalBytes: Math.max(progress.totalParagraphs, 1),
            chaptersDetected: progress.chaptersRead,
            paragraphsWritten: progress.paragraphsRead,
            message: `로컬 본문 재구성 중 ${progress.chaptersRead}/${progress.totalChapters}`,
          });
        },
      });

      throwIfAborted(abortController.signal);
      remoteController = this.uploadService.importFile(
        {
          file,
          encoding: 'utf-8',
          clientBookId: pinnedNovel.id,
        },
        (progress) => onProgress({ ...progress, jobId }),
      );
      return remoteController.promise;
    })();

    return {
      jobId,
      promise,
      cancel: () => {
        abortController.abort();
        remoteController?.cancel();
      },
    };
  }
}
