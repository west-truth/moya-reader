import { parseDecodedNovelTextForImport } from '../../domain/parser';
import { hashSync, stableId } from '../../domain/hash';
import type { Paragraph, ParagraphPage, ReaderSettings, Chapter } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { readSourceStreamPosition, saveSourceStreamPosition } from '../../external-sources/source-stream-history';
import type { ReadingPosition } from '../../sync/types';

/** An in-memory body for the normal text reader. Library writes remain with the download queue. */
export async function sourceTextDocument(input: {
  text: string;
  title: string;
  workId: string;
  episodeId: string;
  historyKey: string;
  settings: ReaderSettings;
  fromStart?: boolean;
  onPosition?: (position: { paragraphIndex: number; offset: number; textHash: string; count: number }) => Promise<void>;
}) {
  const hash = hashSync(input.text);
  const parsed = await parseDecodedNovelTextForImport(
    `${input.title}.txt`,
    { text: input.text, encoding: 'utf-8' },
    hash,
    { chapterSplitMode: 'single' },
  );
  const id = stableId('source_text', input.workId);
  const chapterId = stableId('source_text_chapter', `${input.workId}:${input.episodeId}`);
  const revision = stableId('source_text_revision', `${chapterId}:${hash}`);
  let entry;
  for await (const value of parsed.consumeChapterParagraphs()) {
    entry = value;
    break;
  }
  if (!entry || !entry.chapter.paragraphCount) throw new Error('회차 본문이 비어 있습니다.');
  const chapter: Chapter = {
    ...entry.chapter,
    id: chapterId,
    novelId: id,
    title: input.title,
    documentSectionId: chapterId,
    documentSectionTitle: input.title,
    index: 2,
  };
  const paragraphs: Paragraph[] = [...entry.paragraphs].map((p) => ({
    ...p,
    id: stableId('source_text_paragraph', `${chapterId}:${hash}:${p.index}`),
    novelId: id,
    chapterId,
  }));
  const novel = { ...parsed.novel, id, title: input.title, activeContentRevisionId: revision, totalChapters: 3 };
  // Include the body hash so an edited chapter cannot restore an unrelated offset.
  const historyKey = `${input.historyKey}:text:${hash}`;
  const saved = input.fromStart ? undefined : readSourceStreamPosition(historyKey);
  let position: ReadingPosition | undefined = saved
    ? {
        id: chapterId,
        deviceId: 'reader',
        novelId: id,
        chapterId,
        paragraphIndex: saved.page + 1,
        paragraphId: paragraphs[saved.page]?.id,
        offsetInParagraph: Math.round(saved.fraction * (paragraphs[saved.page]?.text.length ?? 0)),
        chapterProgress: saved.page / paragraphs.length,
        scrollTop: 0,
        updatedAt: new Date(saved.updatedAt).toISOString(),
      }
    : undefined;
  const repository: ReaderBodyRepository = {
    getChapter: async (key) => (key === chapterId ? chapter : undefined),
    getParagraph: async (key, signal) => {
      signal?.throwIfAborted();
      return paragraphs.find((p) => p.id === key);
    },
    getParagraphPage: async (key, pageIndex, signal) => {
      signal?.throwIfAborted();
      if (key !== chapterId || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return undefined;
      const page = paragraphs.slice(pageIndex * PARAGRAPHS_PER_PAGE, (pageIndex + 1) * PARAGRAPHS_PER_PAGE);
      if (!page.length) return undefined;
      return {
        id: `${chapterId}:${pageIndex}`,
        novelId: id,
        chapterId,
        pageIndex,
        startParagraphIndex: page[0].index,
        endParagraphIndex: page.at(-1)!.index,
        paragraphs: page,
        textHash: hash,
      } satisfies ParagraphPage;
    },
    getReadingPosition: async (key) => (key === id ? position : undefined),
    getSettings: async () => input.settings,
    searchParagraphPage: async (request) => {
      request.signal.throwIfAborted();
      if (request.scope === 'book') throw new Error('스트리밍에서는 현재 회차 안에서 검색할 수 있습니다.');
      const query = request.query.trim().toLocaleLowerCase();
      const start = Number(request.cursor ?? 0);
      if (!Number.isSafeInteger(start) || start < 0) throw new Error('검색 위치가 올바르지 않습니다.');
      const matches =
        request.chapterId === chapterId && query
          ? paragraphs.filter((p) => p.text.toLocaleLowerCase().includes(query))
          : [];
      const end = start + Math.min(80, Math.max(1, request.pageSize ?? 40));
      return {
        paragraphs: matches.slice(start, end),
        nextCursor: end < matches.length ? String(end) : undefined,
        capped: false,
        scannedRows: paragraphs.length,
        scannedTextCharacters: input.text.length,
      };
    },
    saveReadingPosition: async (value) => {
      if (
        value.novelId !== id ||
        value.chapterId !== chapterId ||
        (value.expectedContentRevisionId && value.expectedContentRevisionId !== revision)
      )
        return;
      position = {
        ...value,
        offsetInParagraph: value.offsetInParagraph ?? 0,
        id: chapterId,
        deviceId: 'reader',
        updatedAt: new Date().toISOString(),
      };
      const index = Math.max(0, Math.min(paragraphs.length - 1, value.paragraphIndex - 1));
      await input.onPosition?.({
        paragraphIndex: index + 1,
        offset: value.offsetInParagraph ?? 0,
        textHash: paragraphs[index].textHash,
        count: paragraphs.length,
      });
      saveSourceStreamPosition(historyKey, {
        page: index,
        count: paragraphs.length,
        fraction: Math.min(
          0.999999,
          Math.max(0, (value.offsetInParagraph ?? 0) / Math.max(1, paragraphs[index].text.length)),
        ),
        ratio: 1,
      });
    },
  };
  return {
    novel,
    chapter,
    repository,
    position,
    flushSavedPosition: async () => {
      if (position) await repository.saveReadingPosition(position);
    },
  };
}
