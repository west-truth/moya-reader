import type { Bookmark, Chapter, Novel, ReaderHighlight, ReaderNote } from '../domain/types';
import type { ReaderRepository } from '../repositories/reader-repository';
import type { ReadingPosition } from './types';
import { shouldOfferRemoteReadingPosition, type ReaderView } from './sync-ui';

type RemoteRefreshRepository = Pick<
  ReaderRepository,
  | 'listNovels'
  | 'getNovel'
  | 'getReadingPosition'
  | 'listChapters'
  | 'getChapter'
  | 'listBookmarks'
  | 'listHighlights'
  | 'listNotes'
>;

export interface HostedRemoteRefreshInput {
  repository: RemoteRefreshRepository;
  backendMode: 'local' | 'remote';
  view: ReaderView;
  selectedNovel?: Novel;
  currentChapter?: Chapter;
  currentChapterProgress: number;
}

export type HostedRemoteRefreshSelection =
  | { status: 'none' }
  | { status: 'missing' }
  | {
      status: 'loaded';
      novel: Novel;
      chapters: Chapter[];
      currentChapter?: Chapter;
      currentChapterChanged: boolean;
      bookmarks: Bookmark[];
      highlights: ReaderHighlight[];
      notes: ReaderNote[];
      readingPosition?: ReadingPosition;
      remoteReadingPosition?: ReadingPosition;
    };

export interface HostedRemoteRefreshState {
  novels: Novel[];
  selection: HostedRemoteRefreshSelection;
}

function chapterChanged(previous?: Chapter, next?: Chapter): boolean {
  if (!previous && !next) return false;
  if (!previous || !next) return true;
  return previous.id !== next.id ||
    previous.textHash !== next.textHash ||
    previous.updatedAt !== next.updatedAt ||
    previous.paragraphCount !== next.paragraphCount;
}

export async function loadHostedRemoteRefreshState(input: HostedRemoteRefreshInput): Promise<HostedRemoteRefreshState> {
  const novels = await input.repository.listNovels();
  if (!input.selectedNovel) return { novels, selection: { status: 'none' } };

  const freshNovel = await input.repository.getNovel(input.selectedNovel.id);
  if (!freshNovel) return { novels, selection: { status: 'missing' } };

  const [
    freshReadingPosition,
    chapters,
    bookmarks,
    highlights,
    notes,
    refreshedCurrentChapter,
  ] = await Promise.all([
    input.repository.getReadingPosition(freshNovel.id),
    input.repository.listChapters(freshNovel.id),
    input.repository.listBookmarks(freshNovel.id),
    input.repository.listHighlights(freshNovel.id),
    input.repository.listNotes(freshNovel.id),
    input.currentChapter ? input.repository.getChapter(input.currentChapter.id) : Promise.resolve(undefined),
  ]);
  const currentChapter = input.currentChapter
    ? refreshedCurrentChapter ?? chapters[0]
    : undefined;

  const remoteReadingPosition = shouldOfferRemoteReadingPosition({
    backendMode: input.backendMode,
    view: input.view,
    remotePosition: freshReadingPosition,
    currentChapterId: input.currentChapter?.id,
    currentChapterProgress: input.currentChapterProgress,
    currentPositionUpdatedAt: input.selectedNovel.updatedAt,
  })
    ? freshReadingPosition
    : undefined;

  return {
    novels,
    selection: {
      status: 'loaded',
      novel: freshNovel,
      chapters,
      currentChapter,
      currentChapterChanged: chapterChanged(input.currentChapter, currentChapter),
      bookmarks,
      highlights,
      notes,
      readingPosition: freshReadingPosition,
      remoteReadingPosition,
    },
  };
}
