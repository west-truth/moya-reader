import type { Chapter } from '../../domain/types';
import { formatCount } from '../../utils/format';

export type ChapterReadFilter = 'all' | 'unread' | 'read';
export type ChapterSort = 'asc' | 'desc';

export interface ChapterAnnotationCounts {
  bookmarks: number;
  highlights: number;
  notes: number;
}

export interface ChapterListRowModel {
  chapter: Chapter;
  subtitle: string;
  characterCountLabel: string;
  paragraphCountLabel: string;
  ttsDuration: ChapterTtsDuration;
  isCurrent: boolean;
  isRead: boolean;
  annotationCounts?: ChapterAnnotationCounts;
}

export interface ChapterListModel {
  rows: ChapterListRowModel[];
  totalCount: number;
}

export interface BuildChapterListInput {
  chapters: readonly Chapter[];
  query: string;
  readFilter: ChapterReadFilter;
  sort: ChapterSort;
  currentChapter?: Pick<Chapter, 'id' | 'index'>;
  annotationCounts: ReadonlyMap<string, ChapterAnnotationCounts>;
  actualTtsDurationSeconds?: ReadonlyMap<string, number>;
}

export interface ChapterTtsDuration {
  seconds: number;
  label: string;
  source: 'actual' | 'estimated';
}

export interface ChapterPageModel {
  page: number;
  pageCount: number;
  pageSize: number;
  rows: ChapterListRowModel[];
  rangeStart: number;
  rangeEnd: number;
  resultCount: number;
}

export const CHAPTER_PAGE_SIZE = 10;
const DEFAULT_TTS_CHARACTERS_PER_MINUTE = 300;

function formatTtsMinutes(seconds: number): string {
  const minutes = seconds <= 0 ? 0 : Math.max(1, Math.ceil(seconds / 60));
  return `${formatCount(minutes)}분`;
}

export function projectChapterTtsDuration(characterCount: number, actualSeconds?: number): ChapterTtsDuration {
  const hasActualDuration = actualSeconds !== undefined && Number.isFinite(actualSeconds) && actualSeconds >= 0;
  const seconds = hasActualDuration
    ? Math.round(actualSeconds)
    : Math.ceil((Math.max(0, characterCount) / DEFAULT_TTS_CHARACTERS_PER_MINUTE) * 60);
  return {
    seconds,
    label: `${hasActualDuration ? '' : '예상 '}${formatTtsMinutes(seconds)}`,
    source: hasActualDuration ? 'actual' : 'estimated',
  };
}

export function initialChapterPage(rows: readonly ChapterListRowModel[], pageSize = CHAPTER_PAGE_SIZE): number {
  const currentIndex = rows.findIndex((row) => row.isCurrent);
  return currentIndex < 0 ? 1 : Math.floor(currentIndex / Math.max(1, pageSize)) + 1;
}

export function paginateChapterRows(
  rows: readonly ChapterListRowModel[],
  requestedPage: number,
  pageSize = CHAPTER_PAGE_SIZE,
): ChapterPageModel {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage) || 1));
  const rangeStart = rows.length === 0 ? 0 : (page - 1) * safePageSize + 1;
  const rangeEnd = Math.min(page * safePageSize, rows.length);
  return {
    page,
    pageCount,
    pageSize: safePageSize,
    rows: rows.slice((page - 1) * safePageSize, page * safePageSize),
    rangeStart,
    rangeEnd,
    resultCount: rows.length,
  };
}

export function buildChapterListModel(input: BuildChapterListInput): ChapterListModel {
  const query = input.query.trim().toLocaleLowerCase();
  const rows = input.chapters
    .filter((chapter) => {
      const isRead = Boolean(chapter.documentSectionReadAt);
      if (input.readFilter === 'read' && !isRead) return false;
      if (input.readFilter === 'unread' && isRead) return false;
      if (!query) return true;
      return `${chapter.index} ${chapter.title}`.toLocaleLowerCase().includes(query);
    })
    .sort((a, b) => (input.sort === 'asc' ? a.index - b.index : b.index - a.index))
    .map((chapter) => ({
      chapter,
      subtitle: `${chapter.index}화 · ${formatCount(chapter.characterCount)}자 · ${chapter.paragraphCount}문단`,
      characterCountLabel: `${formatCount(chapter.characterCount)}자`,
      paragraphCountLabel: `${formatCount(chapter.paragraphCount)}문단`,
      ttsDuration: projectChapterTtsDuration(chapter.characterCount, input.actualTtsDurationSeconds?.get(chapter.id)),
      isCurrent: input.currentChapter?.id === chapter.id,
      isRead: Boolean(chapter.documentSectionReadAt),
      annotationCounts: input.annotationCounts.get(chapter.id),
    }));

  return { rows, totalCount: input.chapters.length };
}
