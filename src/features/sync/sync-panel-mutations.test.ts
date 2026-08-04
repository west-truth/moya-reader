import { describe, expect, it, vi } from 'vitest';
import type {
  Bookmark,
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  ReaderHighlight,
  ReaderNote,
  VoiceProfile,
} from '../../domain/types';
import type { CharacterRelation } from '../../providers/ai';
import { aiTtsFieldDiffKey } from '../../sync/ai-tts-sync-apply';
import { summarizeAiTtsSyncConflictGroups, type AiTtsSyncConflictGroup } from '../../sync/sync-ui';
import type { JsonValue, ReadingPosition, SyncEvent, SyncOutboxItem, SyncState } from '../../sync/types';
import {
  acceptRemoteSyncState,
  applyAiTtsRemoteSnapshotGroup,
  applyAiTtsSelectedLocalFields,
  discardSyncOutboxIds,
  type SyncPanelAiTtsMutationRepository,
  type SyncPanelRemoteStateRepository,
} from './sync-panel-mutations';

const NOW = '2026-07-10T00:00:00.000Z';

function syncState(patch: Partial<SyncState> = {}): SyncState {
  return {
    id: 'sync-state',
    mode: 'connected',
    status: 'idle',
    pendingCount: 0,
    nextSequence: 3,
    updatedAt: NOW,
    ...patch,
  };
}

function novel(id = 'book_1'): Novel {
  return {
    id,
    title: 'Book',
    sourceFileName: 'book.txt',
    rawText: '',
    normalizedText: '',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: NOW,
    updatedAt: NOW,
    totalChapters: 1,
    totalCharacters: 10,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'ready',
  };
}

function chapter(id = 'chapter_1', novelId = 'book_1'): Chapter {
  return {
    id,
    novelId,
    index: 0,
    title: 'Chapter',
    normalizedText: '',
    textHash: 'chapter-hash',
    rawStartOffset: 0,
    rawEndOffset: 10,
    characterCount: 10,
    paragraphCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function segment(id = 'segment_1', chapterId = 'chapter_1'): LabeledSegment {
  return {
    id,
    novelId: 'book_1',
    chapterId,
    paragraphId: 'paragraph_1',
    segmentIndex: 0,
    startOffset: 0,
    endOffset: 4,
    segmentTextHash: 'segment-hash',
    type: 'quoted_dialogue',
    speakerId: 'character_1',
    candidateSpeakers: ['character_1'],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.9,
    isUserCorrected: true,
  };
}

function outboxItem(input: {
  id: string;
  type: SyncOutboxItem['event']['type'];
  payload: JsonValue;
  status?: SyncOutboxItem['status'];
  localSequence?: number;
  entityId?: string;
}): SyncOutboxItem {
  return {
    id: input.id,
    event: {
      id: `event-${input.id}`,
      type: input.type,
      deviceId: 'local-device',
      novelId: 'book_1',
      entityId: input.entityId ?? `${input.type}-book_1`,
      payload: input.payload,
      createdAt: NOW,
    },
    status: input.status ?? 'failed',
    localSequence: input.localSequence ?? 1,
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function conflictGroup(...items: SyncOutboxItem[]): AiTtsSyncConflictGroup {
  const group = summarizeAiTtsSyncConflictGroups(items)[0];
  if (!group) throw new Error('Expected an AI/TTS conflict group');
  return group;
}

function remoteStateRepository() {
  const freshNovel = novel();
  const freshChapter = chapter();
  const bookmark: Bookmark = {
    id: 'bookmark_1',
    novelId: freshNovel.id,
    chapterId: freshChapter.id,
    label: 'Bookmark',
    progress: 0.2,
    scrollTop: 20,
    createdAt: NOW,
  };
  const highlight: ReaderHighlight = {
    id: 'highlight_1',
    novelId: freshNovel.id,
    chapterId: freshChapter.id,
    paragraphId: 'paragraph_1',
    quote: 'Quote',
    color: 'yellow',
    progress: 0.2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const note: ReaderNote = {
    id: 'note_1',
    novelId: freshNovel.id,
    chapterId: freshChapter.id,
    body: 'Note',
    progress: 0.2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const position: ReadingPosition = {
    id: 'position_1',
    novelId: freshNovel.id,
    chapterId: freshChapter.id,
    paragraphIndex: 0,
    offsetInParagraph: 0,
    chapterProgress: 0.2,
    scrollTop: 20,
    deviceId: 'local-device',
    updatedAt: NOW,
  };
  const repository = {
    listSyncOutbox: vi.fn(async (): Promise<SyncOutboxItem[]> => []),
    listNovels: vi.fn(async (): Promise<Novel[]> => [freshNovel]),
    getNovel: vi.fn(async (_id: string): Promise<Novel | undefined> => freshNovel),
    listChapters: vi.fn(async (_novelId: string): Promise<Chapter[]> => [freshChapter]),
    listBookmarks: vi.fn(async (_novelId: string): Promise<Bookmark[]> => [bookmark]),
    listHighlights: vi.fn(async (_novelId: string): Promise<ReaderHighlight[]> => [highlight]),
    listNotes: vi.fn(async (_novelId: string): Promise<ReaderNote[]> => [note]),
    getReadingPosition: vi.fn(async (_novelId: string): Promise<ReadingPosition | undefined> => position),
    getChapter: vi.fn(async (_id: string): Promise<Chapter | undefined> => freshChapter),
    listCharacters: vi.fn(async (): Promise<Character[]> => []),
    listVoiceProfiles: vi.fn(async (): Promise<VoiceProfile[]> => []),
    listSegments: vi.fn(async (): Promise<LabeledSegment[]> => []),
  } satisfies SyncPanelRemoteStateRepository;
  return { repository, freshNovel, freshChapter, bookmark, highlight, note, position };
}

function aiTtsRepository() {
  const loadedCharacters: Character[] = [
    {
      id: 'character_1',
      novelId: 'book_1',
      canonicalName: 'Loaded Character',
      aliases: [],
      color: '#123456',
      confidence: 1,
      isUserConfirmed: true,
    },
  ];
  const loadedVoiceProfiles: VoiceProfile[] = [
    {
      id: 'voice_loaded',
      novelId: 'book_1',
      characterId: 'character_1',
      role: 'character',
      providerId: 'provider',
      providerVoiceId: 'voice',
      label: 'Loaded Voice',
      speed: 1,
      isUserSelected: true,
    },
  ];
  const loadedSegments = [segment('segment_loaded')];
  const afterState = syncState({ pendingCount: 1 });
  const afterOutbox = [
    outboxItem({
      id: 'new-merge-event',
      type: 'voice_profiles_updated',
      payload: { voiceProfiles: [] },
      status: 'pending',
    }),
  ];
  const repository = {
    capabilities: {
      backend: 'indexeddb',
      readingTimePersistence: 'persistent',
      syncStorage: 'local_outbox',
      remoteEventApply: true,
      parsedNovelImport: 'snapshot',
    } as const,
    saveVoiceProfiles: vi.fn(async (_novelId: string, _profiles: VoiceProfile[]): Promise<void> => undefined),
    saveCharacterGraph: vi.fn(
      async (_novelId: string, _graph: { characters: Character[]; relations: CharacterRelation[] }): Promise<void> =>
        undefined,
    ),
    saveSegments: vi.fn(async (_chapterId: string, _segments: LabeledSegment[]): Promise<void> => undefined),
    applyRemoteSyncEvents: vi.fn(async (_events: SyncEvent[]): Promise<void> => undefined),
    discardSyncOutboxItems: vi.fn(async (_ids: string[]): Promise<SyncState> => afterState),
    listSyncOutbox: vi.fn(async (): Promise<SyncOutboxItem[]> => afterOutbox),
    listCharacters: vi.fn(async (_novelId: string): Promise<Character[]> => loadedCharacters),
    listCharacterRelations: vi.fn(async (_novelId: string): Promise<CharacterRelation[]> => []),
    listVoiceProfiles: vi.fn(async (_novelId: string): Promise<VoiceProfile[]> => loadedVoiceProfiles),
    listSegments: vi.fn(async (_chapterId: string): Promise<LabeledSegment[]> => loadedSegments),
  } satisfies SyncPanelAiTtsMutationRepository;
  return { repository, afterState, afterOutbox, loadedCharacters, loadedVoiceProfiles, loadedSegments };
}

describe('sync panel mutations', () => {
  it('discards explicit outbox ids and returns the refreshed state and outbox', async () => {
    const state = syncState();
    const outbox = [outboxItem({ id: 'remaining', type: 'voice_profiles_updated', payload: { voiceProfiles: [] } })];
    const repository = {
      capabilities: {
        backend: 'indexeddb',
        readingTimePersistence: 'persistent',
        syncStorage: 'local_outbox',
        remoteEventApply: true,
        parsedNovelImport: 'snapshot',
      } as const,
      discardSyncOutboxItems: vi.fn(async (_ids: string[]): Promise<SyncState> => state),
      listSyncOutbox: vi.fn(async (): Promise<SyncOutboxItem[]> => outbox),
    };

    await expect(discardSyncOutboxIds({ repository, ids: ['outbox_1', 'outbox_2'] })).resolves.toEqual({
      state,
      outbox,
    });
    expect(repository.discardSyncOutboxItems).toHaveBeenCalledWith(['outbox_1', 'outbox_2']);
    expect(repository.discardSyncOutboxItems.mock.invocationCallOrder[0]).toBeLessThan(
      repository.listSyncOutbox.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects local outbox commands when the backend does not expose that capability', async () => {
    const repository = {
      capabilities: {
        backend: 'hosted',
        readingTimePersistence: 'session_only',
        syncStorage: 'remote_backend',
        remoteEventApply: false,
        parsedNovelImport: 'upload_reparse',
      } as const,
      listSyncOutbox: vi.fn(async (): Promise<SyncOutboxItem[]> => []),
    };

    await expect(discardSyncOutboxIds({ repository, ids: ['outbox_1'] })).rejects.toMatchObject({
      name: 'UnsupportedRepositoryCapabilityError',
      operation: 'discardSyncOutboxItems',
    });
  });

  it('returns none without selected-book loads after accepting remote state', async () => {
    const { repository, freshNovel } = remoteStateRepository();
    const state = syncState();
    const remoteState = { acceptRemoteState: vi.fn(async () => state) };

    const result = await acceptRemoteSyncState({ repository, remoteState });

    expect(result).toEqual({ state, outbox: [], novels: [freshNovel], selection: { status: 'none' } });
    expect(repository.getNovel).not.toHaveBeenCalled();
  });

  it('returns missing without child loads when the selected book disappeared', async () => {
    const { repository } = remoteStateRepository();
    repository.getNovel.mockResolvedValueOnce(undefined);

    const result = await acceptRemoteSyncState({
      repository,
      remoteState: { acceptRemoteState: async () => syncState() },
      selectedNovelId: 'missing-book',
      currentChapterId: 'missing-chapter',
    });

    expect(result.selection).toEqual({ status: 'missing' });
    expect(repository.listChapters).not.toHaveBeenCalled();
    expect(repository.getChapter).not.toHaveBeenCalled();
  });

  it('returns fresh chapters, annotations, position, and current chapter for a loaded selection', async () => {
    const { repository, freshNovel, freshChapter, bookmark, highlight, note, position } = remoteStateRepository();

    const result = await acceptRemoteSyncState({
      repository,
      remoteState: { acceptRemoteState: async () => syncState() },
      selectedNovelId: freshNovel.id,
      currentChapterId: freshChapter.id,
    });

    expect(result.selection).toEqual({
      status: 'loaded',
      novel: freshNovel,
      chapters: [freshChapter],
      bookmarks: [bookmark],
      highlights: [highlight],
      notes: [note],
      readingPosition: position,
      currentChapter: freshChapter,
      characters: [],
      voiceProfiles: [],
      segments: [],
    });
    expect(repository.getChapter).toHaveBeenCalledWith(freshChapter.id);
  });

  it('saves a selected-local voice merge, settles the group, and reloads the selected book', async () => {
    const { repository, afterState, afterOutbox, loadedCharacters, loadedVoiceProfiles, loadedSegments } =
      aiTtsRepository();
    const payload = {
      voiceProfiles: [
        {
          id: 'voice_1',
          novelId: 'book_1',
          role: 'character',
          providerId: 'local-provider',
          providerVoiceId: 'local-voice',
          label: 'Local Voice',
          speed: 1,
          isUserSelected: true,
        },
      ],
    };
    const group = conflictGroup(
      outboxItem({ id: 'voice-failed', type: 'voice_profiles_updated', payload, localSequence: 2 }),
    );

    const result = await applyAiTtsSelectedLocalFields({
      repository,
      group,
      remoteSnapshot: {
        voiceProfiles: [
          {
            id: 'voice_1',
            novelId: 'book_1',
            role: 'character',
            providerId: 'remote-provider',
            providerVoiceId: 'remote-voice',
            label: 'Remote Voice',
            speed: 0.9,
            isUserSelected: false,
          },
        ],
      },
      selectedKeys: [aiTtsFieldDiffKey({ itemId: 'voice_1', field: 'providerVoiceId' })],
      artifactSelection: { selectedNovelId: 'book_1', currentChapterId: 'chapter_1' },
    });

    expect(repository.saveVoiceProfiles).toHaveBeenCalledWith(
      'book_1',
      [expect.objectContaining({ providerId: 'remote-provider', providerVoiceId: 'local-voice' })],
      { expectedRevision: expect.any(String) },
    );
    expect(repository.discardSyncOutboxItems).toHaveBeenCalledWith(['voice-failed']);
    expect(result).toEqual({
      state: afterState,
      outbox: afterOutbox,
      settledOutboxIds: ['voice-failed'],
      artifactReload: {
        status: 'loaded',
        novelId: 'book_1',
        characters: loadedCharacters,
        voiceProfiles: loadedVoiceProfiles,
        segments: loadedSegments,
      },
    });
  });

  it('rejects snapshot replacement while any group row is sending', async () => {
    const { repository } = aiTtsRepository();
    const payload = { voiceProfiles: [] };
    const group = conflictGroup(
      outboxItem({ id: 'voice-sending', type: 'voice_profiles_updated', payload, status: 'sending' }),
      outboxItem({ id: 'voice-failed', type: 'voice_profiles_updated', payload, localSequence: 2 }),
    );

    await expect(
      applyAiTtsSelectedLocalFields({ repository, group, remoteSnapshot: { voiceProfiles: [] }, selectedKeys: [] }),
    ).rejects.toThrow('currently sending');
    expect(repository.saveVoiceProfiles).not.toHaveBeenCalled();
    expect(repository.discardSyncOutboxItems).not.toHaveBeenCalled();
  });

  it('returns a settled mutation when artifact reload fails after durable writes', async () => {
    const { repository, afterState, afterOutbox } = aiTtsRepository();
    repository.listCharacters.mockRejectedValueOnce(new Error('reload unavailable'));
    const payload = { voiceProfiles: [] };
    const group = conflictGroup(outboxItem({ id: 'voice-failed', type: 'voice_profiles_updated', payload }));

    const result = await applyAiTtsSelectedLocalFields({
      repository,
      group,
      remoteSnapshot: { voiceProfiles: [] },
      selectedKeys: [],
      artifactSelection: { selectedNovelId: 'book_1' },
    });

    expect(result.state).toBe(afterState);
    expect(result.outbox).toBe(afterOutbox);
    expect(result.artifactReload).toEqual({ status: 'failed', error: 'reload unavailable' });
  });

  it('saves selected-local graph fields and skips reload for a different selected book', async () => {
    const { repository } = aiTtsRepository();
    const group = conflictGroup(
      outboxItem({
        id: 'graph-failed',
        type: 'character_graph_updated',
        payload: {
          mode: 'replace',
          characters: [
            {
              id: 'character_1',
              novelId: 'book_1',
              canonicalName: 'Local Name',
              aliases: [],
              color: '#111111',
              confidence: 0.8,
              isUserConfirmed: true,
            },
          ],
          relations: [],
        },
      }),
    );

    const result = await applyAiTtsSelectedLocalFields({
      repository,
      group,
      remoteSnapshot: {
        characters: [
          {
            id: 'character_1',
            novelId: 'book_1',
            canonicalName: 'Remote Name',
            aliases: ['Remote'],
            color: '#222222',
            confidence: 0.9,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      },
      selectedKeys: [
        aiTtsFieldDiffKey({ itemId: 'character:character_1', field: 'canonicalName' }),
        aiTtsFieldDiffKey({ itemId: 'character:character_1', field: 'isUserConfirmed' }),
      ],
      artifactSelection: { selectedNovelId: 'book_2', currentChapterId: 'chapter_2' },
    });

    expect(repository.saveCharacterGraph).toHaveBeenCalledWith(
      'book_1',
      {
        characters: [expect.objectContaining({ canonicalName: 'Local Name', isUserConfirmed: true })],
        relations: [],
      },
      { expectedRevision: expect.any(String) },
    );
    expect(result.artifactReload).toEqual({ status: 'skipped' });
    expect(repository.listCharacters).toHaveBeenCalledWith('book_1');
    expect(repository.listCharacterRelations).toHaveBeenCalledWith('book_1');
    expect(repository.listVoiceProfiles).not.toHaveBeenCalled();
    expect(repository.listSegments).not.toHaveBeenCalled();
  });

  it('saves selected-local segments with the group chapter id and preserves the current segment fallback', async () => {
    const { repository, loadedCharacters, loadedVoiceProfiles } = aiTtsRepository();
    const currentSegments = [segment('current-segment')];
    const localSegment = { ...segment(), speakerId: 'local-speaker', isUserCorrected: true };
    const group = conflictGroup(
      outboxItem({
        id: 'segments-failed',
        type: 'chapter_segments_updated',
        entityId: 'chapter_segments_chapter_1',
        payload: { chapterId: 'chapter_1', segments: [localSegment] },
      }),
    );

    const result = await applyAiTtsSelectedLocalFields({
      repository,
      group,
      remoteSnapshot: {
        segments: [{ ...localSegment, speakerId: 'remote-speaker', isUserCorrected: false }],
      },
      selectedKeys: [
        aiTtsFieldDiffKey({ itemId: localSegment.id, field: 'speakerId' }),
        aiTtsFieldDiffKey({ itemId: localSegment.id, field: 'isUserCorrected' }),
      ],
      artifactSelection: { selectedNovelId: 'book_1', currentSegments },
    });

    expect(repository.saveSegments).toHaveBeenCalledWith(
      'chapter_1',
      [expect.objectContaining({ speakerId: 'local-speaker', isUserCorrected: true })],
      { expectedRevision: expect.any(String) },
    );
    expect(result.artifactReload).toEqual({
      status: 'loaded',
      novelId: 'book_1',
      characters: loadedCharacters,
      voiceProfiles: loadedVoiceProfiles,
      segments: currentSegments,
    });
    expect(repository.listSegments).toHaveBeenCalledWith('chapter_1');
  });

  it('rejects a selected-local segment merge with no chapter id before saving or settling', async () => {
    const { repository } = aiTtsRepository();
    const group = conflictGroup(
      outboxItem({
        id: 'segments-missing-chapter',
        type: 'chapter_segments_updated',
        payload: { segments: [{ id: 'segment_1', speakerId: 'local' }] },
      }),
    );

    await expect(
      applyAiTtsSelectedLocalFields({
        repository,
        group,
        remoteSnapshot: { segments: [{ id: 'segment_1', speakerId: 'remote' }] },
        selectedKeys: [aiTtsFieldDiffKey({ itemId: 'segment_1', field: 'speakerId' })],
      }),
    ).rejects.toThrow('Merged chapter segment snapshot is missing a chapter id');
    expect(repository.saveSegments).not.toHaveBeenCalled();
    expect(repository.discardSyncOutboxItems).not.toHaveBeenCalled();
  });

  it('applies a remote snapshot event, settles the group, and reloads selected artifacts', async () => {
    const { repository, loadedCharacters, loadedVoiceProfiles, loadedSegments } = aiTtsRepository();
    const payload = { mode: 'replace', characters: [], relations: [] };
    const group = conflictGroup(
      outboxItem({ id: 'graph-failed', type: 'character_graph_updated', payload, localSequence: 2 }),
    );

    const result = await applyAiTtsRemoteSnapshotGroup({
      repository,
      group,
      remoteSnapshot: {
        characters: [
          {
            id: 'character_1',
            novelId: 'book_1',
            canonicalName: 'Remote Character',
            aliases: [],
            color: '#123456',
            confidence: 0.9,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      },
      artifactSelection: { selectedNovelId: 'book_1', currentChapterId: 'chapter_1' },
    });

    expect(repository.applyRemoteSyncEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'character_graph_updated',
        novelId: 'book_1',
        payload: {
          mode: 'replace',
          characters: [expect.objectContaining({ canonicalName: 'Remote Character' })],
          relations: [],
        },
      }),
    ]);
    expect(repository.discardSyncOutboxItems).toHaveBeenCalledWith(['graph-failed']);
    expect(result.settledOutboxIds).toEqual(['graph-failed']);
    expect(result.artifactReload).toEqual({
      status: 'loaded',
      novelId: 'book_1',
      characters: loadedCharacters,
      voiceProfiles: loadedVoiceProfiles,
      segments: loadedSegments,
    });
  });
});
