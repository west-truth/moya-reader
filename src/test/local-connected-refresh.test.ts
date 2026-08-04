import { describe, expect, it, vi } from 'vitest';
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
import { defaultSettings } from '../repositories/reader-defaults';
import { loadLocalConnectedRefreshState } from '../sync/local-connected-refresh';
import type { ReadingPosition } from '../sync/types';

const now = '2026-07-06T00:00:00.000Z';

function settings(overrides: Partial<ReaderSettings> = {}): ReaderSettings {
  return {
    id: 'reader-settings',
    theme: 'light',
    font: 'serif',
    fontSize: 18,
    lineHeight: 1.7,
    paragraphSpacing: 1,
    marginX: 32,
    marginY: 24,
    contentWidth: 760,
    flow: 'scroll',
    ttsSpeed: 1,
    keepScreenChrome: false,
    ...overrides,
    ttsPlayback: overrides.ttsPlayback ?? defaultSettings.ttsPlayback,
    readingProfile: overrides.readingProfile ?? defaultSettings.readingProfile,
    gestureBindings: overrides.gestureBindings ?? defaultSettings.gestureBindings,
  };
}

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'novel_1',
    title: 'Connected Book',
    sourceFileName: 'connected.txt',
    sourceEncoding: 'utf-8',
    rawText: '',
    normalizedText: '',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: now,
    updatedAt: now,
    totalChapters: 1,
    totalCharacters: 100,
    totalParagraphs: 10,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'chapter_1',
    novelId: 'novel_1',
    index: 1,
    title: 'Chapter 1',
    normalizedText: '',
    textHash: 'chapter-hash',
    rawStartOffset: 0,
    rawEndOffset: 100,
    characterCount: 100,
    paragraphCount: 10,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function repository(overrides: Partial<ReaderRepository>): ReaderRepository {
  return overrides as ReaderRepository;
}

describe('local connected refresh state', () => {
  it('refreshes settings and library without fetching selection state when no book is selected', async () => {
    const freshSettings = settings({ fontSize: 20 });
    const listed = [novel()];
    const repo = repository({
      getSettings: vi.fn(async () => freshSettings),
      listNovels: vi.fn(async () => listed),
      getNovel: vi.fn(),
    });

    const state = await loadLocalConnectedRefreshState({ repository: repo });

    expect(state).toEqual({ settings: freshSettings, novels: listed, selection: { status: 'none' } });
    expect(repo.getNovel).not.toHaveBeenCalled();
  });

  it('loads connected book, reader data, AI/TTS data, current chapter, and current segments', async () => {
    const selected = novel({ title: 'Old title' });
    const currentChapter = chapter({ textHash: 'old-hash' });
    const freshNovel = novel({ title: 'Remote title' });
    const freshChapter = chapter({ textHash: 'new-hash', paragraphCount: 12 });
    const chapters = [freshChapter];
    const bookmarks: Bookmark[] = [
      {
        id: 'bookmark_1',
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        label: 'Remote bookmark',
        progress: 0.5,
        scrollTop: 120,
        createdAt: now,
      },
    ];
    const highlights: ReaderHighlight[] = [
      {
        id: 'highlight_1',
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        quote: 'highlight',
        color: 'yellow',
        progress: 0.5,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const notes: ReaderNote[] = [
      {
        id: 'note_1',
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        body: 'Remote note',
        progress: 0.5,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const readingPosition: ReadingPosition = {
      id: 'reading_position_novel_1',
      novelId: 'novel_1',
      chapterId: 'chapter_1',
      paragraphIndex: 3,
      offsetInParagraph: 0,
      chapterProgress: 0.5,
      scrollTop: 300,
      deviceId: 'server',
      updatedAt: now,
    };
    const characters: Character[] = [
      {
        id: 'character_1',
        novelId: 'novel_1',
        canonicalName: 'Remote Character',
        aliases: [],
        color: '#123456',
        confidence: 0.9,
        isUserConfirmed: false,
      },
    ];
    const voiceProfiles: VoiceProfile[] = [
      {
        id: 'voice_1',
        novelId: 'novel_1',
        characterId: 'character_1',
        role: 'character',
        providerId: 'system',
        providerVoiceId: 'system-default',
        label: 'Remote voice',
        speed: 1,
        isUserSelected: true,
      },
    ];
    const segments: LabeledSegment[] = [
      {
        id: 'segment_1',
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        segmentIndex: 0,
        startOffset: 0,
        endOffset: 5,
        segmentTextHash: 'segment-hash',
        type: 'quoted_dialogue',
        speakerId: 'character_1',
        candidateSpeakers: ['character_1'],
        listenerIds: [],
        emotion: 'neutral',
        confidence: 0.8,
        isUserCorrected: false,
      },
    ];
    const repo = repository({
      getSettings: vi.fn(async () => settings({ theme: 'dark' })),
      listNovels: vi.fn(async () => [freshNovel]),
      getNovel: vi.fn(async () => freshNovel),
      listChapters: vi.fn(async () => chapters),
      getChapter: vi.fn(async () => freshChapter),
      listBookmarks: vi.fn(async () => bookmarks),
      listHighlights: vi.fn(async () => highlights),
      listNotes: vi.fn(async () => notes),
      getReadingPosition: vi.fn(async () => readingPosition),
      listCharacters: vi.fn(async () => characters),
      listVoiceProfiles: vi.fn(async () => voiceProfiles),
      listSegments: vi.fn(async () => segments),
    });

    const state = await loadLocalConnectedRefreshState({
      repository: repo,
      selectedNovel: selected,
      currentChapter,
    });

    expect(state.selection).toMatchObject({
      status: 'loaded',
      novel: { title: 'Remote title' },
      chapters,
      bookmarks,
      highlights,
      notes,
      readingPosition,
      characters,
      voiceProfiles,
      currentChapter: { textHash: 'new-hash' },
      currentChapterChanged: true,
      segments,
    });
    expect(repo.listSegments).toHaveBeenCalledWith('chapter_1');
  });

  it('marks the selection missing when the connected server removed the selected book', async () => {
    const repo = repository({
      getSettings: vi.fn(async () => settings()),
      listNovels: vi.fn(async () => []),
      getNovel: vi.fn(async () => undefined),
      listChapters: vi.fn(),
      listSegments: vi.fn(),
    });

    const state = await loadLocalConnectedRefreshState({
      repository: repo,
      selectedNovel: novel(),
      currentChapter: chapter(),
    });

    expect(state.selection).toEqual({ status: 'missing' });
    expect(repo.listChapters).not.toHaveBeenCalled();
    expect(repo.listSegments).not.toHaveBeenCalled();
  });

  it('does not reuse stale segments when the open chapter is gone after sync', async () => {
    const freshNovel = novel();
    const repo = repository({
      getSettings: vi.fn(async () => settings()),
      listNovels: vi.fn(async () => [freshNovel]),
      getNovel: vi.fn(async () => freshNovel),
      listChapters: vi.fn(async () => []),
      getChapter: vi.fn(async () => undefined),
      listBookmarks: vi.fn(async () => []),
      listHighlights: vi.fn(async () => []),
      listNotes: vi.fn(async () => []),
      getReadingPosition: vi.fn(async () => undefined),
      listCharacters: vi.fn(async () => []),
      listVoiceProfiles: vi.fn(async () => []),
      listSegments: vi.fn(),
    });

    const state = await loadLocalConnectedRefreshState({
      repository: repo,
      selectedNovel: freshNovel,
      currentChapter: chapter(),
    });

    expect(state.selection).toMatchObject({
      status: 'loaded',
      currentChapter: undefined,
      currentChapterChanged: true,
      segments: [],
    });
    expect(repo.listSegments).not.toHaveBeenCalled();
  });
});
