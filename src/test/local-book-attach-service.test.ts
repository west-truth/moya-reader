import { describe, expect, it, vi } from 'vitest';
import { Chapter, Novel, Paragraph, ParagraphPage } from '../domain/types';
import { BulkParagraphPageRequest, ReaderRepository } from '../repositories/reader-repository';
import { ImportService } from '../services/import/import-service';
import { createLocalNovelUploadFile, LocalBookAttachService } from '../services/import/local-book-attach-service';
import type { BookContentRevisionHandle } from '../storage/db';

const now = '2026-07-05T00:00:00.000Z';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'novel_local',
    title: '로컬 책',
    sourceFileName: 'local-book.txt',
    sourceEncoding: 'euc-kr',
    rawText: '',
    normalizedText: '',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: now,
    updatedAt: now,
    totalChapters: 2,
    totalCharacters: 100,
    totalParagraphs: 3,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

function chapter(index: number, title: string, overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: `chapter_${index}`,
    novelId: 'novel_local',
    index,
    title,
    normalizedText: '',
    textHash: `chapter-${index}-hash`,
    rawStartOffset: index * 10,
    rawEndOffset: index * 10 + 5,
    characterCount: 5,
    paragraphCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function paragraph(chapterId: string, index: number, text: string): Paragraph {
  return {
    id: `${chapterId}:paragraph:${index}`,
    novelId: 'novel_local',
    chapterId,
    index,
    text,
    startOffsetInChapter: index * 10,
    endOffsetInChapter: index * 10 + text.length,
    textHash: `${chapterId}:${index}:hash`,
  };
}

function page(chapterId: string, pageIndex: number, paragraphs: Paragraph[]): ParagraphPage {
  return {
    id: `page_${chapterId}_${pageIndex}`,
    novelId: 'novel_local',
    chapterId,
    pageIndex,
    startParagraphIndex: paragraphs[0]?.index ?? 0,
    endParagraphIndex: paragraphs[paragraphs.length - 1]?.index ?? 0,
    paragraphs,
    textHash: `page-${chapterId}-${pageIndex}-hash`,
  };
}

function repositoryFixture(input: {
  chapters: Chapter[];
  pagesByChapter?: Record<string, ParagraphPage[]>;
  paragraphsByChapter?: Record<string, Paragraph[]>;
}): ReaderRepository {
  return {
    listChapters: vi.fn(async () => input.chapters),
    iterateParagraphPages: vi.fn(async function* (request: BulkParagraphPageRequest) {
      const storedPages = input.pagesByChapter?.[request.chapterId] ?? [];
      const paragraphs = input.paragraphsByChapter?.[request.chapterId] ?? [];
      const pages = storedPages.length
        ? storedPages
        : paragraphs.length
          ? [page(request.chapterId, 0, paragraphs)]
          : [];
      for (const storedPage of [...pages].sort((left, right) => left.pageIndex - right.pageIndex)) {
        if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        yield storedPage;
      }
    }),
  } as unknown as ReaderRepository;
}

function contentRevisionHandle(
  repository: ReaderRepository,
  pinnedNovel: Novel,
  contentRevisionId = 'content_revision_pinned',
): BookContentRevisionHandle {
  const listParagraphPages = async (chapterId: string) => {
    const pages: ParagraphPage[] = [];
    for await (const storedPage of repository.iterateParagraphPages({
      chapterId,
      signal: new AbortController().signal,
    }))
      pages.push(storedPage);
    return pages;
  };
  return {
    novel: pinnedNovel,
    contentRevisionId,
    listChapters: () => repository.listChapters(pinnedNovel.id),
    listParagraphPages,
    listParagraphs: async (chapterId) =>
      (await listParagraphPages(chapterId)).flatMap((storedPage) => storedPage.paragraphs),
    iterateParagraphPages: (request) => repository.iterateParagraphPages(request),
  };
}

describe('local book server attach', () => {
  it('rebuilds upload text in chapter, page, and paragraph order', async () => {
    const first = chapter(1, '1화');
    const second = chapter(2, '2화');
    const repository = repositoryFixture({
      chapters: [second, first],
      pagesByChapter: {
        [first.id]: [
          page(first.id, 1, [paragraph(first.id, 3, '셋째 문단')]),
          page(first.id, 0, [paragraph(first.id, 2, '둘째 문단'), paragraph(first.id, 1, '첫 문단')]),
        ],
        [second.id]: [page(second.id, 0, [paragraph(second.id, 1, '마지막 문단')])],
      },
    });

    const file = await createLocalNovelUploadFile(repository, novel());

    expect(file.name).toBe('local-book.txt');
    expect(await file.text()).toBe('1화\n\n첫 문단\n\n둘째 문단\n\n셋째 문단\n\n2화\n\n마지막 문단');
  });

  it('does not duplicate the file-title fallback chapter heading', async () => {
    const fallbackNovel = novel({
      title: '단권',
      sourceFileName: '단권',
      totalChapters: 1,
      totalParagraphs: 2,
    });
    const onlyChapter = chapter(1, '단권', { rawStartOffset: 0 });
    const repository = repositoryFixture({
      chapters: [onlyChapter],
      paragraphsByChapter: {
        [onlyChapter.id]: [
          paragraph(onlyChapter.id, 1, '제목처럼 보이는 첫 줄'),
          paragraph(onlyChapter.id, 2, '본문입니다.'),
        ],
      },
    });

    const file = await createLocalNovelUploadFile(repository, fallbackNovel);

    expect(file.name).toBe('단권.txt');
    expect(await file.text()).toBe('제목처럼 보이는 첫 줄\n\n본문입니다.');
  });

  it('uses page-backed text without falling back to chapter-wide paragraph reads', async () => {
    const first = chapter(1, '1화', { paragraphCount: 4 });
    const listParagraphs = vi.fn(async () => []);
    const storedPages = [
      page(first.id, 1, [paragraph(first.id, 4, '넷째 문단'), paragraph(first.id, 3, '셋째 문단')]),
      page(first.id, 0, [paragraph(first.id, 2, '둘째 문단'), paragraph(first.id, 1, '첫 문단')]),
    ];
    const repository = {
      listChapters: vi.fn(async () => [first]),
      listParagraphPages: vi.fn(async () => storedPages),
      listParagraphs,
      iterateParagraphPages: vi.fn(async function* () {
        for (const storedPage of [...storedPages].sort((left, right) => left.pageIndex - right.pageIndex)) {
          yield storedPage;
        }
      }),
    } as unknown as ReaderRepository;
    const progress = vi.fn();

    const file = await createLocalNovelUploadFile(repository, novel({ totalChapters: 1, totalParagraphs: 4 }), {
      onProgress: progress,
    });

    expect(listParagraphs).not.toHaveBeenCalled();
    expect(await file.text()).toBe('1화\n\n첫 문단\n\n둘째 문단\n\n셋째 문단\n\n넷째 문단');
    expect(progress).toHaveBeenLastCalledWith({
      chaptersRead: 1,
      totalChapters: 1,
      paragraphsRead: 4,
      totalParagraphs: 4,
    });
  });

  it('can cancel page-backed rebuilds between page batches', async () => {
    const first = chapter(1, '1화', { paragraphCount: 4 });
    const controller = new AbortController();
    const progress = vi.fn((state: { paragraphsRead: number }) => {
      if (state.paragraphsRead >= 2) controller.abort();
    });
    const repository = repositoryFixture({
      chapters: [first],
      pagesByChapter: {
        [first.id]: [
          page(first.id, 0, [paragraph(first.id, 1, '첫 문단'), paragraph(first.id, 2, '둘째 문단')]),
          page(first.id, 1, [paragraph(first.id, 3, '셋째 문단'), paragraph(first.id, 4, '넷째 문단')]),
        ],
      },
    });

    await expect(
      createLocalNovelUploadFile(repository, novel({ totalChapters: 1, totalParagraphs: 4 }), {
        signal: controller.signal,
        onProgress: progress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({
      chaptersRead: 1,
      totalChapters: 1,
      paragraphsRead: 2,
      totalParagraphs: 4,
    });
  });

  it('uploads rebuilt local text with the local book id and UTF-8 encoding', async () => {
    const localNovel = novel({ id: 'novel_keep_this_id' });
    const onlyChapter = chapter(1, '1화', { novelId: localNovel.id });
    const repository = repositoryFixture({
      chapters: [onlyChapter],
      paragraphsByChapter: {
        [onlyChapter.id]: [paragraph(onlyChapter.id, 1, '서버에 보낼 문단')],
      },
    });
    let uploadedFile: File | undefined;
    const uploadService: ImportService = {
      importFile: vi.fn((input, onProgress) => {
        uploadedFile = input.file;
        expect(input.encoding).toBe('utf-8');
        expect(input.clientBookId).toBe(localNovel.id);
        onProgress({
          jobId: 'remote_job',
          status: 'ready',
          bytesRead: input.file.size,
          totalBytes: input.file.size,
          chaptersDetected: 1,
          paragraphsWritten: 1,
          message: 'done',
        });
        return {
          jobId: 'remote_job',
          promise: Promise.resolve({ novel: localNovel }),
          cancel: vi.fn(),
        };
      }),
    };

    const progress = vi.fn();
    const openRevision = vi.fn(async () => contentRevisionHandle(repository, localNovel));
    const service = new LocalBookAttachService(repository, uploadService, openRevision);
    await service.attachNovel(localNovel, progress).promise;

    expect(openRevision).toHaveBeenCalledTimes(1);
    expect(repository.iterateParagraphPages).toHaveBeenCalled();
    expect(uploadService.importFile).toHaveBeenCalledTimes(1);
    expect(await uploadedFile?.text()).toBe('1화\n\n서버에 보낼 문단');
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.stringMatching(/^local_attach_/),
        status: 'ready',
      }),
    );
  });

  it('streams pinned pages into attach without compatibility list materialization', async () => {
    const localNovel = novel({ totalChapters: 1, totalParagraphs: 2 });
    const onlyChapter = chapter(1, '1화', { paragraphCount: 2 });
    let firstPageConsumed = false;
    const iterateParagraphPages = vi.fn(async function* () {
      yield page(onlyChapter.id, 0, [paragraph(onlyChapter.id, 1, '첫 문단')]);
      expect(firstPageConsumed).toBe(true);
      yield page(onlyChapter.id, 1, [paragraph(onlyChapter.id, 2, '둘째 문단')]);
    });
    const listParagraphPages = vi.fn(async () => {
      throw new Error('compatibility page list must not be used');
    });
    const listParagraphs = vi.fn(async () => {
      throw new Error('compatibility paragraph list must not be used');
    });
    const openRevision = vi.fn(async (): Promise<BookContentRevisionHandle> => ({
      novel: localNovel,
      contentRevisionId: 'revision-streamed',
      listChapters: async () => [onlyChapter],
      listParagraphPages,
      listParagraphs,
      iterateParagraphPages,
    }));
    let uploadedFile: File | undefined;
    const uploadService: ImportService = {
      importFile: vi.fn((input) => {
        uploadedFile = input.file;
        return {
          jobId: 'remote_stream_job',
          promise: Promise.resolve({ novel: localNovel }),
          cancel: vi.fn(),
        };
      }),
    };

    const service = new LocalBookAttachService(repositoryFixture({ chapters: [] }), uploadService, openRevision);
    await service.attachNovel(localNovel, (progress) => {
      if (progress.paragraphsWritten >= 1) firstPageConsumed = true;
    }).promise;

    expect(iterateParagraphPages).toHaveBeenCalledWith({
      chapterId: onlyChapter.id,
      signal: expect.any(AbortSignal),
      batchSize: 10,
    });
    expect(listParagraphPages).not.toHaveBeenCalled();
    expect(listParagraphs).not.toHaveBeenCalled();
    expect(await uploadedFile?.text()).toBe('1화\n\n첫 문단\n\n둘째 문단');
  });

  it('reads every chapter through one immutable content revision handle', async () => {
    const localNovel = novel({ totalChapters: 2, totalParagraphs: 2 });
    const first = chapter(1, '1화');
    const second = chapter(2, '2화');
    let activeRevision = 'revision-old';
    const pagesByRevision: Record<string, Record<string, ParagraphPage[]>> = {
      'revision-old': {
        [first.id]: [page(first.id, 0, [paragraph(first.id, 1, '이전 첫 문단')])],
        [second.id]: [page(second.id, 0, [paragraph(second.id, 1, '이전 둘째 문단')])],
      },
      'revision-new': {
        [first.id]: [page(first.id, 0, [paragraph(first.id, 1, '새 첫 문단')])],
        [second.id]: [page(second.id, 0, [paragraph(second.id, 1, '새 둘째 문단')])],
      },
    };
    const openRevision = vi.fn(async (): Promise<BookContentRevisionHandle> => {
      const pinnedRevision = activeRevision;
      return {
        novel: { ...localNovel, activeContentRevisionId: pinnedRevision },
        contentRevisionId: pinnedRevision,
        listChapters: async () => [first, second],
        listParagraphPages: async (chapterId) => pagesByRevision[pinnedRevision][chapterId] ?? [],
        listParagraphs: async () => [],
        iterateParagraphPages: async function* (request) {
          for (const storedPage of pagesByRevision[pinnedRevision][request.chapterId] ?? []) yield storedPage;
        },
      };
    });
    let uploadedFile: File | undefined;
    const uploadService: ImportService = {
      importFile: vi.fn((input) => {
        uploadedFile = input.file;
        return {
          jobId: 'remote_pin_job',
          promise: Promise.resolve({ novel: localNovel }),
          cancel: vi.fn(),
        };
      }),
    };

    const service = new LocalBookAttachService(repositoryFixture({ chapters: [] }), uploadService, openRevision);
    await service.attachNovel(localNovel, (progress) => {
      if (progress.paragraphsWritten >= 1) activeRevision = 'revision-new';
    }).promise;

    expect(openRevision).toHaveBeenCalledTimes(1);
    expect(await uploadedFile?.text()).toBe('1화\n\n이전 첫 문단\n\n2화\n\n이전 둘째 문단');
  });
});
