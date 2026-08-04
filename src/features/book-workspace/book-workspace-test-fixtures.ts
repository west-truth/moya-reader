import type { Chapter, Novel } from '../../domain/types';
import type { ReadingPosition } from '../../sync/types';
import type { SaveReadingPositionInput } from '../../repositories/reader-repository';
import {
  INITIAL_BOOK_WORKSPACE_STATE,
  type BookWorkspaceNoticeTone,
  type BookWorkspacePorts,
  type BookWorkspaceState,
} from './book-workspace-contract';

export function testNovel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '테스트 소설',
    sourceFileName: 'book.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    totalChapters: 3,
    totalCharacters: 300,
    totalParagraphs: 30,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

export function testChapter(index: number, overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: `chapter-${index}`,
    novelId: 'book-1',
    index,
    title: `${index}화`,
    normalizedText: `본문 ${index}`,
    textHash: `chapter-hash-${index}`,
    rawStartOffset: (index - 1) * 100,
    rawEndOffset: index * 100,
    characterCount: 100,
    paragraphCount: 10,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

export function testPosition(overrides: Partial<ReadingPosition> = {}): ReadingPosition {
  return {
    id: 'reading_position_book-1',
    novelId: 'book-1',
    chapterId: 'chapter-2',
    paragraphId: 'paragraph-4',
    paragraphIndex: 4,
    offsetInParagraph: 0,
    chapterProgress: 0.4,
    scrollTop: 240,
    deviceId: 'test-device',
    updatedAt: '2026-07-11T01:00:00.000Z',
    ...overrides,
  };
}

export function testWorkspaceState(overrides: Partial<BookWorkspaceState> = {}): BookWorkspaceState {
  return {
    ...INITIAL_BOOK_WORKSPACE_STATE,
    novels: overrides.novels ?? [],
    chapters: overrides.chapters ?? [],
    ...overrides,
  };
}

export interface BookWorkspaceTestHarness {
  readonly ports: BookWorkspacePorts;
  readonly calls: string[];
  readonly notices: Array<{ message: string; tone?: BookWorkspaceNoticeTone }>;
  readonly preparedOpens: Array<{ chapterId: string; options: Record<string, unknown> }>;
  readonly progressUpdates: SaveReadingPositionInput[];
}

export function createBookWorkspaceTestHarness(
  input: {
    novel?: Novel;
    chapters?: Chapter[];
    position?: ReadingPosition;
    confirm?: boolean;
    conflict?: unknown;
  } = {},
): BookWorkspaceTestHarness {
  const calls: string[] = [];
  const notices: Array<{ message: string; tone?: BookWorkspaceNoticeTone }> = [];
  const preparedOpens: Array<{ chapterId: string; options: Record<string, unknown> }> = [];
  const progressUpdates: SaveReadingPositionInput[] = [];
  const novel = input.novel ?? testNovel();
  const chapters = input.chapters ?? [testChapter(1), testChapter(2), testChapter(3)];

  const ports: BookWorkspacePorts = {
    repository: {
      listChapters: async () => {
        calls.push('repository.listChapters');
        return chapters;
      },
      getNovel: async () => {
        calls.push('repository.getNovel');
        return novel;
      },
      getReadingPosition: async () => {
        calls.push('repository.getReadingPosition');
        return input.position;
      },
      patchNovelMetadata: async () => {
        calls.push('repository.patchNovelMetadata');
      },
      deleteNovel: async () => {
        calls.push('repository.deleteNovel');
      },
      clearReadingPosition: async () => {
        calls.push('repository.clearReadingPosition');
        if (input.conflict) throw input.conflict;
      },
      saveReadingPosition: async (request) => {
        calls.push('repository.saveReadingPosition');
        progressUpdates.push(request);
        if (input.conflict) throw input.conflict;
      },
    },
    transition: {
      flushReaderSession: async () => {
        calls.push('transition.flushReaderSession');
      },
      resetAnalysis: () => calls.push('transition.resetAnalysis'),
      stopChapterTTS: () => calls.push('transition.stopChapterTTS'),
      stopReaderTTS: () => calls.push('transition.stopReaderTTS'),
      activateChapter: (chapterId) => calls.push(`transition.activateChapter:${chapterId}`),
      prepareReaderOpen: (chapterId, options) => {
        calls.push(`transition.prepareReaderOpen:${chapterId}`);
        preparedOpens.push({ chapterId, options });
        return { sequence: 7 };
      },
    },
    adjacent: {
      loadBookAnnotations: async () => {
        calls.push('adjacent.loadBookAnnotations');
        return { bookmarks: [], highlights: [], notes: [] };
      },
      applyBookAnnotations: () => calls.push('adjacent.applyBookAnnotations'),
      loadReaderArtifacts: async (chapterId) => {
        calls.push(`adjacent.loadReaderArtifacts:${chapterId}`);
        return { segments: [], characters: [], voiceProfiles: [] };
      },
      applyReaderArtifacts: () => calls.push('adjacent.applyReaderArtifacts'),
      resetCorrection: () => calls.push('adjacent.resetCorrection'),
      resetAnnotationEditor: () => calls.push('adjacent.resetAnnotationEditor'),
      refreshNovels: async () => calls.push('adjacent.refreshNovels'),
      refreshAfterLocalMutation: async () => calls.push('adjacent.refreshAfterLocalMutation'),
      refreshSyncState: async () => calls.push('adjacent.refreshSyncState'),
      refreshAfterLocationConflict: () => calls.push('adjacent.refreshAfterLocationConflict'),
    },
    environment: {
      confirm: () => input.confirm ?? true,
      notify: (message, tone) => {
        calls.push(`environment.notify:${tone ?? 'info'}`);
        notices.push({ message, tone });
      },
      isMutationConflict: (error) => error === input.conflict,
    },
  };

  return { ports, calls, notices, preparedOpens, progressUpdates };
}
