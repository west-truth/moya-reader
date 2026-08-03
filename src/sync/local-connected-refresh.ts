import type {
  Bookmark,
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  ReaderHighlight,
  ReaderNote,
  ReaderSettings,
  VoiceProfile,
} from '../domain/types';
import type { ReaderRepository } from '../repositories/reader-repository';
import type { ReadingPosition } from './types';

type LocalConnectedRefreshRepository = Pick<
  ReaderRepository,
  | 'getSettings'
  | 'listNovels'
  | 'getNovel'
  | 'listChapters'
  | 'getChapter'
  | 'listBookmarks'
  | 'listHighlights'
  | 'listNotes'
  | 'getReadingPosition'
  | 'listCharacters'
  | 'listVoiceProfiles'
  | 'listSegments'
>;

export interface LocalConnectedRefreshInput {
  repository: LocalConnectedRefreshRepository;
  selectedNovel?: Novel;
  currentChapter?: Chapter;
}

export type LocalConnectedRefreshSelection =
  | { status: 'none' }
  | { status: 'missing' }
  | {
      status: 'loaded';
      novel: Novel;
      chapters: Chapter[];
      bookmarks: Bookmark[];
      highlights: ReaderHighlight[];
      notes: ReaderNote[];
      readingPosition?: ReadingPosition;
      characters: Character[];
      voiceProfiles: VoiceProfile[];
      currentChapter?: Chapter;
      currentChapterChanged: boolean;
      segments: LabeledSegment[];
    };

export interface LocalConnectedRefreshState {
  settings: ReaderSettings;
  novels: Novel[];
  selection: LocalConnectedRefreshSelection;
}

function chapterContentChanged(previous?: Chapter, next?: Chapter): boolean {
  if (!previous && !next) return false;
  if (previous && !next) return true;
  if (!previous || !next) return false;
  return previous.id !== next.id ||
    previous.textHash !== next.textHash ||
    previous.paragraphCount !== next.paragraphCount;
}

export async function loadLocalConnectedRefreshState(
  input: LocalConnectedRefreshInput,
): Promise<LocalConnectedRefreshState> {
  const [settings, novels] = await Promise.all([
    input.repository.getSettings(),
    input.repository.listNovels(),
  ]);
  if (!input.selectedNovel) return { settings, novels, selection: { status: 'none' } };

  const freshNovel = await input.repository.getNovel(input.selectedNovel.id);
  if (!freshNovel) return { settings, novels, selection: { status: 'missing' } };

  const [
    chapters,
    bookmarks,
    highlights,
    notes,
    readingPosition,
    characters,
    voiceProfiles,
    refreshedCurrentChapter,
  ] = await Promise.all([
    input.repository.listChapters(freshNovel.id),
    input.repository.listBookmarks(freshNovel.id),
    input.repository.listHighlights(freshNovel.id),
    input.repository.listNotes(freshNovel.id),
    input.repository.getReadingPosition(freshNovel.id),
    input.repository.listCharacters(freshNovel.id),
    input.repository.listVoiceProfiles(freshNovel.id),
    input.currentChapter ? input.repository.getChapter(input.currentChapter.id) : Promise.resolve(undefined),
  ]);
  const segments = refreshedCurrentChapter
    ? await input.repository.listSegments(refreshedCurrentChapter.id)
    : [];

  return {
    settings,
    novels,
    selection: {
      status: 'loaded',
      novel: freshNovel,
      chapters,
      bookmarks,
      highlights,
      notes,
      readingPosition,
      characters,
      voiceProfiles,
      currentChapter: refreshedCurrentChapter,
      currentChapterChanged: chapterContentChanged(input.currentChapter, refreshedCurrentChapter),
      segments,
    },
  };
}
