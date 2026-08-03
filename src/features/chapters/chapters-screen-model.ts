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
}

export function buildChapterListModel(input: BuildChapterListInput): ChapterListModel {
  const query = input.query.trim().toLocaleLowerCase();
  const rows = input.chapters
    .filter((chapter) => {
      const isRead = input.currentChapter !== undefined && chapter.index < input.currentChapter.index;
      if (input.readFilter === 'read' && !isRead) return false;
      if (input.readFilter === 'unread' && isRead) return false;
      if (!query) return true;
      return `${chapter.index} ${chapter.title}`.toLocaleLowerCase().includes(query);
    })
    .sort((a, b) => (input.sort === 'asc' ? a.index - b.index : b.index - a.index))
    .map((chapter) => ({
      chapter,
      subtitle: `${chapter.index}화 · ${formatCount(chapter.characterCount)}자 · ${chapter.paragraphCount}문단`,
      isCurrent: input.currentChapter?.id === chapter.id,
      isRead: input.currentChapter !== undefined && chapter.index < input.currentChapter.index,
      annotationCounts: input.annotationCounts.get(chapter.id),
    }));

  return { rows, totalCount: input.chapters.length };
}
