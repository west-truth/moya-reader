import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalOutboxSyncService, SyncEventSource } from '../sync/local-outbox-sync-service';
import {
  applyRemoteSyncEvents,
  discardSyncOutboxItems,
  getBookmarks,
  getCharacters,
  getCorrections,
  getHighlights,
  getNotes,
  getReadingPosition,
  getSettings,
  getSegments,
  getVoiceProfiles,
  listSyncOutbox,
  resetReaderDbForTests,
  saveCharacters,
  saveCorrection,
  saveHighlight,
  saveImportedNovel,
  patchNovelMetadata,
  saveSegments,
  saveSettings,
  saveVoiceProfiles,
  updateSyncOutboxItems,
  saveReadingPosition,
} from '../storage/db';
import { Character, LabeledSegment, ParsedNovel } from '../domain/types';
import { integrityHash } from '../domain/id-hash-contract';
import { RemoteBookSnapshot, SyncEvent } from '../sync/types';

function parsedNovel(id: string): ParsedNovel {
  const now = '2026-07-04T00:00:00.000Z';
  return {
    novel: {
      id,
      title: 'Sync Test',
      sourceFileName: 'sync-test.txt',
      sourceEncoding: 'utf-8',
      rawText: 'body',
      normalizedText: 'body',
      rawTextHash: `${id}:raw`,
      normalizedTextHash: `${id}:normalized`,
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters: 4,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: `${id}:chapter:1`,
        novelId: id,
        index: 1,
        title: '1화',
        normalizedText: 'body',
        textHash: `${id}:chapter-hash`,
        rawStartOffset: 0,
        rawEndOffset: 4,
        characterCount: 4,
        paragraphCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs: [
      {
        id: `${id}:paragraph:1`,
        novelId: id,
        chapterId: `${id}:chapter:1`,
        index: 1,
        text: 'body',
        startOffsetInChapter: 0,
        endOffsetInChapter: 4,
        textHash: `${id}:paragraph-1`,
      },
    ],
  };
}

describe('LocalOutboxSyncService', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('marks pending outbox events as sent after a successful flush', async () => {
    await saveImportedNovel(parsedNovel('novel-sync'));
    const sent: SyncEvent[] = [];
    const source: SyncEventSource = {
      async pushSync(events) {
        sent.push(...events);
        return { accepted: events.length };
      },
      async pullSync() {
        return { cursor: 0, events: [] };
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(sent.map((event) => event.type)).toEqual(['book_imported']);
    expect((await listSyncOutbox('sent')).map((item) => item.event.type)).toEqual(['book_imported']);
    expect(await listSyncOutbox('pending')).toEqual([]);
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', pendingCount: 0 });
  });

  it('marks outbox events as failed when the server push fails', async () => {
    await saveImportedNovel(parsedNovel('novel-fail'));
    const source: SyncEventSource = {
      async pushSync() {
        throw new Error('network down');
      },
      async pullSync() {
        throw new Error('pull should not run after push failure');
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();
    const failed = await listSyncOutbox('failed');

    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ attempts: 1, lastError: 'network down' });
    expect(state).toMatchObject({ mode: 'connected', status: 'failed', pendingCount: 1, lastError: 'network down' });
  });

  it('can discard one failed outbox event and clear idle state when the queue is empty', async () => {
    await saveImportedNovel(parsedNovel('novel-discard-failed'));
    const source: SyncEventSource = {
      async pushSync() {
        throw new Error('network down');
      },
      async pullSync() {
        throw new Error('pull should not run after push failure');
      },
    };

    await new LocalOutboxSyncService(source).flushPending();
    const failed = await listSyncOutbox('failed');
    expect(failed).toHaveLength(1);

    const state = await discardSyncOutboxItems([failed[0].id]);

    expect(await listSyncOutbox('failed')).toEqual([]);
    expect((await listSyncOutbox('sent')).map((item) => item.event.type)).toEqual(['book_imported']);
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', pendingCount: 0 });
    expect(state.lastError).toBeUndefined();
  });

  it('marks sync as offline when the server cannot be reached', async () => {
    await saveImportedNovel(parsedNovel('novel-offline'));
    const source: SyncEventSource = {
      async pushSync() {
        throw new TypeError('Failed to fetch');
      },
      async pullSync() {
        throw new Error('pull should not run after push failure');
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(await listSyncOutbox('failed')).toHaveLength(1);
    expect(state).toMatchObject({
      mode: 'connected',
      status: 'offline',
      pendingCount: 1,
      lastError: 'Failed to fetch',
    });
  });

  it('marks sync as conflict when the server rejects an event with 409', async () => {
    await saveImportedNovel(parsedNovel('novel-conflict'));
    const conflictError = new Error('remote revision conflict') as Error & { status: number };
    conflictError.status = 409;
    const source: SyncEventSource = {
      async pushSync() {
        throw conflictError;
      },
      async pullSync() {
        throw new Error('pull should not run after push failure');
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(await listSyncOutbox('failed')).toHaveLength(1);
    expect(state).toMatchObject({
      mode: 'connected',
      status: 'conflict',
      pendingCount: 1,
      lastError: 'remote revision conflict',
    });
  });

  it('keeps only server-rejected events in conflict when a push response includes rejected ids', async () => {
    await saveImportedNovel(parsedNovel('novel-partial-reject'));
    await saveSettings({ ...(await getSettings()), fontSize: 23 });
    const source: SyncEventSource = {
      async pushSync(events) {
        expect(events.map((event) => event.type)).toEqual(['book_imported', 'settings_updated']);
        return {
          accepted: 1,
          acceptedIds: [events[0].id],
          rejected: [
            {
              id: events[1].id,
              reason: 'stale',
              message: 'server has newer settings',
            },
          ],
        };
      },
      async pullSync() {
        throw new Error('pull should wait until the conflict is resolved');
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();
    const sent = await listSyncOutbox('sent');
    const failed = await listSyncOutbox('failed');

    expect(sent).toHaveLength(1);
    expect(sent[0].event.type).toBe('book_imported');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      event: expect.objectContaining({ type: 'settings_updated' }),
      lastError: 'Server rejected 1 sync event: server has newer settings',
    });
    expect(state).toMatchObject({
      mode: 'connected',
      status: 'conflict',
      pendingCount: 1,
      lastError: 'Server rejected 1 sync event: server has newer settings',
    });
  });

  it('pulls attached book snapshots before retrying pre-attach child events and remaps child ids', async () => {
    const parsed = parsedNovel('novel-attach-remap');
    const localChapter = parsed.chapters[0];
    const localParagraph = parsed.paragraphs[0];
    await saveImportedNovel(parsed);
    await saveReadingPosition({
      novelId: parsed.novel.id,
      chapterId: localChapter.id,
      scrollTop: 120,
      chapterProgress: 0.42,
      paragraphId: localParagraph.id,
      paragraphIndex: localParagraph.index,
      offsetInParagraph: 1,
    });
    await saveHighlight({
      id: 'highlight-attach-remap',
      novelId: parsed.novel.id,
      chapterId: localChapter.id,
      paragraphId: localParagraph.id,
      quote: 'body',
      color: 'yellow',
      progress: 0.42,
      createdAt: '2026-07-04T00:02:00.000Z',
      updatedAt: '2026-07-04T00:02:00.000Z',
    });

    const remoteChapter = {
      ...localChapter,
      id: 'server-chapter-1',
      novelId: parsed.novel.id,
    };
    const remoteParagraph = {
      ...localParagraph,
      id: 'server-paragraph-1',
      novelId: parsed.novel.id,
      chapterId: remoteChapter.id,
    };
    const snapshot: RemoteBookSnapshot = {
      novel: {
        ...parsed.novel,
        lastReadChapterId: remoteChapter.id,
        lastReadParagraphId: undefined,
      },
      chapters: [remoteChapter],
      paragraphPages: [
        {
          id: 'server-page-0',
          novelId: parsed.novel.id,
          chapterId: remoteChapter.id,
          pageIndex: 0,
          startParagraphIndex: remoteParagraph.index,
          endParagraphIndex: remoteParagraph.index,
          paragraphs: [remoteParagraph],
          textHash: 'server-page-hash',
        },
      ],
    };

    const service = new LocalOutboxSyncService({
      async pushSync(events) {
        if (events.some((event) => event.payload && JSON.stringify(event.payload).includes('server-chapter-1'))) {
          expect(events.map((event) => event.type)).toEqual(['reading_position_updated', 'highlight_created']);
          expect(events.find((event) => event.type === 'reading_position_updated')?.payload).toMatchObject({
            position: {
              chapterId: remoteChapter.id,
              paragraphId: remoteParagraph.id,
            },
          });
          expect(events.find((event) => event.type === 'highlight_created')?.payload).toMatchObject({
            highlight: {
              chapterId: remoteChapter.id,
              paragraphId: remoteParagraph.id,
            },
          });
          return { accepted: events.length, acceptedIds: events.map((event) => event.id) };
        }

        expect(events.map((event) => event.type)).toEqual([
          'book_imported',
          'reading_position_updated',
          'highlight_created',
        ]);
        expect(events.find((event) => event.type === 'reading_position_updated')?.payload).toMatchObject({
          position: {
            chapterId: localChapter.id,
            paragraphId: localParagraph.id,
          },
        });
        const rejected = events
          .filter((event) => event.type !== 'book_imported')
          .map((event) => ({
            id: event.id,
            reason: 'invalid' as const,
            message: 'server book does not exist yet; upload or attach the book before syncing this event',
          }));
        return {
          accepted: 1,
          acceptedIds: [events[0].id],
          rejected,
        };
      },
      async pullSync(since) {
        if (since === 0) {
          return {
            cursor: 33,
            events: [
              {
                id: 'remote-attached-book-imported',
                type: 'book_imported',
                deviceId: 'server',
                novelId: parsed.novel.id,
                entityId: parsed.novel.id,
                payload: { bookId: parsed.novel.id },
                createdAt: '2026-07-04T00:03:00.000Z',
              },
            ],
          };
        }
        expect(since).toBe(33);
        return { cursor: 33, events: [] };
      },
      async getBookSnapshot(bookId) {
        expect(bookId).toBe(parsed.novel.id);
        return snapshot;
      },
    });

    const conflict = await service.flushPending();
    expect(conflict).toMatchObject({
      mode: 'connected',
      status: 'conflict',
      pendingCount: 2,
      lastError:
        'Server rejected 2 sync events: server book does not exist yet; upload or attach the book before syncing this event',
    });
    expect((await listSyncOutbox('failed')).map((item) => item.event.type)).toEqual([
      'reading_position_updated',
      'highlight_created',
    ]);

    const state = await service.flushPending();

    expect(await getReadingPosition(parsed.novel.id)).toMatchObject({
      chapterId: remoteChapter.id,
      paragraphId: remoteParagraph.id,
    });
    expect(await getHighlights(parsed.novel.id)).toMatchObject([
      {
        chapterId: remoteChapter.id,
        paragraphId: remoteParagraph.id,
      },
    ]);
    expect(await listSyncOutbox('pending')).toEqual([]);
    expect(await listSyncOutbox('failed')).toEqual([]);
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', pendingCount: 0, lastRemoteCursor: 33 });
  });

  it('preserves local reading position when an attached snapshot keeps the same child ids', async () => {
    const parsed = parsedNovel('novel-attach-same-ids');
    const chapter = parsed.chapters[0];
    const paragraph = parsed.paragraphs[0];
    await saveImportedNovel(parsed);
    await saveReadingPosition({
      novelId: parsed.novel.id,
      chapterId: chapter.id,
      scrollTop: 80,
      chapterProgress: 0.33,
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index,
      offsetInParagraph: 2,
    });

    const snapshot: RemoteBookSnapshot = {
      novel: parsed.novel,
      chapters: parsed.chapters,
      paragraphPages: [
        {
          id: 'same-id-page-0',
          novelId: parsed.novel.id,
          chapterId: chapter.id,
          pageIndex: 0,
          startParagraphIndex: paragraph.index,
          endParagraphIndex: paragraph.index,
          paragraphs: [paragraph],
          textHash: 'same-id-page-hash',
        },
      ],
    };
    const source: SyncEventSource = {
      async pushSync(events) {
        return { accepted: events.length, acceptedIds: events.map((event) => event.id) };
      },
      async pullSync() {
        return {
          cursor: 34,
          events: [
            {
              id: 'remote-same-id-book-imported',
              type: 'book_imported',
              deviceId: 'server',
              novelId: parsed.novel.id,
              entityId: parsed.novel.id,
              payload: { bookId: parsed.novel.id },
              createdAt: '2026-07-04T00:04:00.000Z',
            },
          ],
        };
      },
      async getBookSnapshot() {
        return snapshot;
      },
    };

    await new LocalOutboxSyncService(source).flushPending();

    expect(await getReadingPosition(parsed.novel.id)).toMatchObject({
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index,
      offsetInParagraph: 2,
    });
  });

  it('compacts superseded reading position and settings events before pushing', async () => {
    await saveImportedNovel(parsedNovel('novel-compact-outbox'));
    await saveReadingPosition({
      novelId: 'novel-compact-outbox',
      chapterId: 'novel-compact-outbox:chapter:1',
      scrollTop: 10,
      chapterProgress: 0.1,
      paragraphId: 'novel-compact-outbox:paragraph:1',
      paragraphIndex: 1,
      offsetInParagraph: 0,
    });
    await saveReadingPosition({
      novelId: 'novel-compact-outbox',
      chapterId: 'novel-compact-outbox:chapter:1',
      scrollTop: 90,
      chapterProgress: 0.9,
      paragraphId: 'novel-compact-outbox:paragraph:1',
      paragraphIndex: 1,
      offsetInParagraph: 2,
    });
    await saveSettings({ ...(await getSettings()), fontSize: 21 });
    await saveSettings({ ...(await getSettings()), fontSize: 25 });
    const pushed: SyncEvent[] = [];
    const source: SyncEventSource = {
      async pushSync(events) {
        pushed.push(...events);
        return { accepted: events.length, acceptedIds: events.map((event) => event.id) };
      },
      async pullSync() {
        return { cursor: 0, events: [] };
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(pushed.map((event) => event.type)).toEqual([
      'book_imported',
      'reading_position_updated',
      'settings_updated',
    ]);
    expect(pushed.find((event) => event.type === 'reading_position_updated')?.payload).toMatchObject({
      position: {
        chapterProgress: 0.9,
        scrollTop: 90,
        offsetInParagraph: 2,
      },
    });
    expect(pushed.find((event) => event.type === 'settings_updated')?.payload).toMatchObject({
      settings: { fontSize: 25 },
    });
    expect((await listSyncOutbox('sent')).map((item) => item.event.type)).toEqual([
      'book_imported',
      'reading_position_updated',
      'reading_position_updated',
      'settings_updated',
      'settings_updated',
    ]);
    expect(await listSyncOutbox('pending')).toEqual([]);
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', pendingCount: 0 });
  });

  it('keeps all book metadata fields when compacting consecutive patches', async () => {
    await saveImportedNovel(parsedNovel('novel-compact-metadata'));
    await patchNovelMetadata('novel-compact-metadata', { favorite: true });
    await patchNovelMetadata('novel-compact-metadata', { title: 'Compacted title' });
    const pushed: SyncEvent[] = [];
    const source: SyncEventSource = {
      async pushSync(events) {
        pushed.push(...events);
        return { accepted: events.length, acceptedIds: events.map((event) => event.id) };
      },
      async pullSync() {
        return { cursor: 0, events: [] };
      },
    };

    await new LocalOutboxSyncService(source).flushPending();

    const updates = pushed.filter((event) => event.type === 'book_updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      novel: {
        title: 'Compacted title',
        favorite: true,
        analysisStatus: 'not_analyzed',
      },
    });
  });

  it('syncs local AI/TTS voice profile and user correction events', async () => {
    await saveImportedNovel(parsedNovel('novel-ai-sync'));
    await saveVoiceProfiles('novel-ai-sync', [
      {
        id: 'voice_narrator',
        novelId: 'novel-ai-sync',
        role: 'narrator',
        providerId: 'system',
        providerVoiceId: 'ko-KR-local',
        label: 'Narrator',
        speed: 1,
        isUserSelected: true,
      },
    ]);
    await saveVoiceProfiles('novel-ai-sync', [
      {
        id: 'voice_narrator',
        novelId: 'novel-ai-sync',
        role: 'narrator',
        providerId: 'system',
        providerVoiceId: 'ko-KR-local-updated',
        label: 'Narrator Updated',
        speed: 1.05,
        isUserSelected: true,
      },
    ]);
    await saveCorrection({
      id: 'correction_local_1',
      novelId: 'novel-ai-sync',
      chapterId: 'novel-ai-sync:chapter:1',
      paragraphId: 'novel-ai-sync:paragraph:1',
      segmentId: 'segment_1',
      correctionType: 'speaker',
      beforeJson: JSON.stringify({ speakerId: 'unknown' }),
      afterJson: JSON.stringify({ speakerId: 'char_1' }),
      applyScope: 'future_pattern',
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    const pushed: SyncEvent[] = [];
    const source: SyncEventSource = {
      async pushSync(events) {
        pushed.push(...events);
        return { accepted: events.length, acceptedIds: events.map((event) => event.id) };
      },
      async pullSync() {
        return { cursor: 0, events: [] };
      },
    };

    await new LocalOutboxSyncService(source).flushPending();

    expect(pushed.map((event) => event.type)).toEqual([
      'book_imported',
      'voice_profiles_updated',
      'user_correction_created',
    ]);
    expect(pushed.find((event) => event.type === 'voice_profiles_updated')?.payload).toMatchObject({
      voiceProfiles: [expect.objectContaining({ providerVoiceId: 'ko-KR-local-updated' })],
    });
    expect(pushed.find((event) => event.type === 'user_correction_created')?.payload).toMatchObject({
      correction: expect.objectContaining({ id: 'correction_local_1', correctionType: 'speaker' }),
    });
  });

  it('can resolve a conflict by discarding queued local events and applying remote state', async () => {
    await saveImportedNovel(parsedNovel('novel-remote-wins'));
    const conflictError = new Error('remote revision conflict') as Error & { status: number };
    conflictError.status = 409;
    const source: SyncEventSource = {
      async pushSync() {
        throw conflictError;
      },
      async pullSync() {
        return {
          cursor: 9,
          events: [
            {
              id: 'remote-settings-conflict-resolution',
              type: 'settings_updated',
              deviceId: 'server',
              entityId: 'reader-settings',
              payload: { settings: { id: 'reader-settings', fontSize: 24, theme: 'dark' } },
              createdAt: '2026-07-04T00:01:00.000Z',
            },
          ],
        };
      },
    };
    const service = new LocalOutboxSyncService(source);
    await service.flushPending();

    const state = await service.acceptRemoteState();
    const settings = await getSettings();

    expect(await listSyncOutbox('failed')).toEqual([]);
    expect(await listSyncOutbox('sent')).toHaveLength(1);
    expect(settings).toMatchObject({ fontSize: 24, theme: 'dark' });
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', pendingCount: 0, lastRemoteCursor: 9 });
  });

  it('keeps conflicted local events when accepting remote state cannot pull the server', async () => {
    await saveImportedNovel(parsedNovel('novel-remote-wins-fail'));
    const conflictError = new Error('remote revision conflict') as Error & { status: number };
    conflictError.status = 409;
    const source: SyncEventSource = {
      async pushSync() {
        throw conflictError;
      },
      async pullSync() {
        throw new TypeError('Failed to fetch');
      },
    };
    const service = new LocalOutboxSyncService(source);
    await service.flushPending();

    const state = await service.acceptRemoteState();

    expect(await listSyncOutbox('failed')).toHaveLength(1);
    expect(await listSyncOutbox('sent')).toEqual([]);
    expect(state).toMatchObject({
      mode: 'connected',
      status: 'offline',
      pendingCount: 1,
      lastError: 'Failed to fetch',
    });
  });

  it('pulls and applies remote events when there is no local outbox', async () => {
    const source: SyncEventSource = {
      async pushSync() {
        throw new Error('push should not run without pending events');
      },
      async pullSync(since) {
        expect(since).toBe(0);
        const events: SyncEvent[] = [
          {
            id: 'remote-settings-1',
            type: 'settings_updated',
            deviceId: 'server',
            entityId: 'reader-settings',
            payload: { settings: { id: 'reader-settings', fontSize: 22, theme: 'sepia' } },
            createdAt: '2026-07-04T00:01:00.000Z',
          },
        ];
        return {
          cursor: 7,
          events,
        };
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();
    const settings = await getSettings();

    expect(settings).toMatchObject({ fontSize: 22, theme: 'sepia' });
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', lastRemoteCursor: 7, pendingCount: 0 });
  });

  it('pulls and applies remote AI/TTS voice profile and correction events without re-queuing them', async () => {
    await saveImportedNovel(parsedNovel('novel-remote-ai-sync'));
    const localConfirmedCharacter: Character = {
      id: 'char_confirmed',
      novelId: 'novel-remote-ai-sync',
      canonicalName: 'Local Confirmed',
      aliases: ['Local'],
      color: '#111111',
      description: 'User confirmed locally.',
      confidence: 0.8,
      isUserConfirmed: true,
    };
    const localCorrectedSegment: LabeledSegment = {
      id: 'segment_remote_1',
      novelId: 'novel-remote-ai-sync',
      chapterId: 'novel-remote-ai-sync:chapter:1',
      paragraphId: 'novel-remote-ai-sync:paragraph:1',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: 4,
      segmentTextHash: integrityHash('body'),
      type: 'narration',
      speakerId: 'char_confirmed',
      candidateSpeakers: ['char_confirmed'],
      listenerIds: [],
      emotion: 'warm',
      confidence: 1,
      isUserCorrected: true,
    };
    await saveCharacters('novel-remote-ai-sync', [localConfirmedCharacter]);
    await saveSegments('novel-remote-ai-sync:chapter:1', [localCorrectedSegment]);
    await updateSyncOutboxItems(
      (await listSyncOutbox()).map((item) => item.id),
      'sent',
    );
    const source: SyncEventSource = {
      async pushSync() {
        throw new Error('push should not run without pending events');
      },
      async pullSync() {
        const events: SyncEvent[] = [
          {
            id: 'remote-character-graph',
            type: 'character_graph_updated',
            deviceId: 'server',
            novelId: 'novel-remote-ai-sync',
            entityId: 'character_graph_novel-remote-ai-sync',
            payload: {
              mode: 'replace',
              characters: [
                {
                  id: 'char_confirmed',
                  novelId: 'novel-remote-ai-sync',
                  canonicalName: 'Generated Name',
                  aliases: ['Generated'],
                  color: '#222222',
                  description: 'Generated metadata should not downgrade user confirmation.',
                  confidence: 0.95,
                  isUserConfirmed: false,
                },
              ],
            },
            revision: {
              entityType: 'character_graph',
              entityId: 'character_graph_novel-remote-ai-sync',
              novelId: 'novel-remote-ai-sync',
              localSequence: 0,
              updatedAt: '2026-07-06T00:00:30.000Z',
              payloadHash: 'hash-character-graph',
            },
            createdAt: '2026-07-06T00:00:30.000Z',
          },
          {
            id: 'remote-chapter-segments',
            type: 'chapter_segments_updated',
            deviceId: 'server',
            novelId: 'novel-remote-ai-sync',
            entityId: 'chapter_segments_novel-remote-ai-sync:chapter:1',
            payload: {
              chapterId: 'novel-remote-ai-sync:chapter:1',
              segments: [
                {
                  id: 'segment_remote_1',
                  novelId: 'novel-remote-ai-sync',
                  chapterId: 'novel-remote-ai-sync:chapter:1',
                  paragraphId: 'novel-remote-ai-sync:paragraph:1',
                  segmentIndex: 0,
                  startOffset: 0,
                  endOffset: 4,
                  segmentTextHash: integrityHash('body'),
                  type: 'narration',
                  speakerId: 'unknown',
                  candidateSpeakers: ['unknown'],
                  listenerIds: [],
                  emotion: 'neutral',
                  confidence: 0.4,
                  isUserCorrected: false,
                },
              ],
            },
            revision: {
              entityType: 'chapter_segments',
              entityId: 'chapter_segments_novel-remote-ai-sync:chapter:1',
              novelId: 'novel-remote-ai-sync',
              localSequence: 0,
              updatedAt: '2026-07-06T00:00:45.000Z',
              payloadHash: 'hash-chapter-segments',
            },
            createdAt: '2026-07-06T00:00:45.000Z',
          },
          {
            id: 'remote-voice-profiles',
            type: 'voice_profiles_updated',
            deviceId: 'server',
            novelId: 'novel-remote-ai-sync',
            entityId: 'voice_profiles_novel-remote-ai-sync',
            payload: {
              voiceProfiles: [
                {
                  id: 'voice_remote_narrator',
                  novelId: 'novel-remote-ai-sync',
                  role: 'narrator',
                  providerId: 'system',
                  providerVoiceId: 'ko-KR-remote',
                  label: 'Remote Narrator',
                  speed: 0.95,
                  isUserSelected: true,
                  createdAt: '2026-07-06T00:01:00.000Z',
                  updatedAt: '2026-07-06T00:01:00.000Z',
                },
              ],
            },
            createdAt: '2026-07-06T00:01:00.000Z',
          },
          {
            id: 'remote-correction',
            type: 'user_correction_created',
            deviceId: 'server',
            novelId: 'novel-remote-ai-sync',
            entityId: 'correction_remote_1',
            payload: {
              correction: {
                id: 'correction_remote_1',
                novelId: 'novel-remote-ai-sync',
                chapterId: 'novel-remote-ai-sync:chapter:1',
                paragraphId: 'novel-remote-ai-sync:paragraph:1',
                segmentId: 'segment_remote_1',
                correctionType: 'emotion',
                beforeJson: JSON.stringify({ emotion: 'neutral' }),
                afterJson: JSON.stringify({ emotion: 'tense' }),
                applyScope: 'chapter',
                createdAt: '2026-07-06T00:02:00.000Z',
              },
            },
            createdAt: '2026-07-06T00:02:00.000Z',
          },
        ];
        return {
          cursor: 11,
          events,
        };
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(await getVoiceProfiles('novel-remote-ai-sync')).toMatchObject([
      {
        id: 'voice_remote_narrator',
        providerVoiceId: 'ko-KR-remote',
        speed: 0.95,
      },
    ]);
    expect(await getCharacters('novel-remote-ai-sync')).toMatchObject([
      {
        id: 'char_confirmed',
        canonicalName: 'Local Confirmed',
        aliases: ['Local'],
        color: '#111111',
        isUserConfirmed: true,
        confidence: 0.95,
      },
    ]);
    expect(await getSegments('novel-remote-ai-sync:chapter:1')).toMatchObject([
      {
        id: 'segment_remote_1',
        speakerId: 'char_confirmed',
        emotion: 'tense',
        isUserCorrected: true,
      },
    ]);
    expect(await getCorrections('novel-remote-ai-sync')).toMatchObject([
      {
        id: 'correction_remote_1',
        correctionType: 'emotion',
        afterJson: JSON.stringify({ emotion: 'tense' }),
      },
    ]);
    expect(await listSyncOutbox('pending')).toEqual([]);
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', lastRemoteCursor: 11, pendingCount: 0 });
  });

  it('applies remote chapter segment patch events without deleting sibling paragraph segments', async () => {
    await saveImportedNovel(parsedNovel('novel-segment-patch'));
    const chapterId = 'novel-segment-patch:chapter:1';
    const segment = (id: string, paragraphId: string, text: string): LabeledSegment => ({
      id,
      novelId: 'novel-segment-patch',
      chapterId,
      paragraphId,
      segmentIndex: 0,
      startOffset: 0,
      endOffset: text.length,
      segmentTextHash: integrityHash(text),
      type: 'narration',
      speakerId: 'unknown',
      candidateSpeakers: ['unknown'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.5,
      isUserCorrected: false,
    });
    await saveSegments(chapterId, [
      segment('segment_old_p1', 'novel-segment-patch:paragraph:1', 'body'),
      segment('segment_keep_p2', 'novel-segment-patch:paragraph:2', 'side'),
    ]);
    await updateSyncOutboxItems(
      (await listSyncOutbox()).map((item) => item.id),
      'sent',
    );

    await applyRemoteSyncEvents([
      {
        id: 'remote-segment-patch',
        type: 'chapter_segments_updated',
        deviceId: 'server',
        novelId: 'novel-segment-patch',
        entityId: `chapter_segments_${chapterId}`,
        payload: {
          mode: 'patch',
          chapterId,
          paragraphIds: ['novel-segment-patch:paragraph:1'],
          segments: [segment('segment_new_p1', 'novel-segment-patch:paragraph:1', 'body')],
        } as unknown as SyncEvent['payload'],
        createdAt: '2026-07-06T00:00:45.000Z',
      },
    ]);

    expect((await getSegments(chapterId)).map((item) => item.id).sort()).toEqual(['segment_keep_p2', 'segment_new_p1']);
  });

  it('blocks secret-like voice profile provider options from local storage and remote sync apply', async () => {
    await expect(
      saveVoiceProfiles('novel-secret-voice', [
        {
          id: 'voice_secret',
          novelId: 'novel-secret-voice',
          role: 'narrator',
          providerId: 'local-endpoint',
          providerVoiceId: 'voice_local',
          label: 'Secret Voice',
          speed: 1,
          providerOptions: { instructions: 'Bearer secret-token-value' },
          isUserSelected: true,
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        },
      ]),
    ).rejects.toThrow('voice profile providerOptions must not contain secret-like keys or values');

    await applyRemoteSyncEvents([
      {
        id: 'remote-voice-profile-secret',
        type: 'voice_profiles_updated',
        deviceId: 'server',
        novelId: 'novel-secret-voice',
        entityId: 'voice_profiles_novel-secret-voice',
        payload: {
          voiceProfiles: [
            {
              id: 'voice_remote_secret',
              novelId: 'novel-secret-voice',
              role: 'narrator',
              providerId: 'local-endpoint',
              providerVoiceId: 'voice_local',
              label: 'Remote Secret Voice',
              speed: 1,
              providerOptions: { notes: 'Bearer secret-token-value' },
              isUserSelected: true,
              createdAt: '2026-07-06T00:00:00.000Z',
              updatedAt: '2026-07-06T00:00:00.000Z',
            },
          ],
        } as unknown as SyncEvent['payload'],
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);

    expect(await getVoiceProfiles('novel-secret-voice')).toEqual([]);
  });

  it('pushes local events then applies pulled reading position and reader annotations without re-queuing them', async () => {
    await saveImportedNovel(parsedNovel('novel-pull'));
    const source: SyncEventSource = {
      async pushSync(events) {
        expect(events.map((event) => event.type)).toEqual(['book_imported']);
        return { accepted: events.length };
      },
      async pullSync(since) {
        expect(since).toBe(0);
        const events: SyncEvent[] = [
          {
            id: 'remote-position-1',
            type: 'reading_position_updated',
            deviceId: 'server',
            novelId: 'novel-pull',
            entityId: 'reading_position_novel-pull',
            payload: {
              position: {
                chapterId: 'novel-pull:chapter:1',
                paragraphId: 'novel-pull:paragraph:1',
                paragraphIndex: 1,
                offsetInParagraph: 0,
                chapterProgress: 0.5,
                scrollTop: 80,
                updatedAt: '2026-07-04T00:02:00.000Z',
              },
            },
            createdAt: '2026-07-04T00:02:00.000Z',
          },
          {
            id: 'remote-bookmark-1',
            type: 'bookmark_created',
            deviceId: 'server',
            novelId: 'novel-pull',
            entityId: 'bookmark-remote',
            payload: {
              bookmark: {
                id: 'bookmark-remote',
                novelId: 'novel-pull',
                chapterId: 'novel-pull:chapter:1',
                paragraphId: 'novel-pull:paragraph:1',
                label: 'remote mark',
                progress: 0.5,
                scrollTop: 80,
                createdAt: '2026-07-04T00:03:00.000Z',
              },
            },
            createdAt: '2026-07-04T00:03:00.000Z',
          },
          {
            id: 'remote-highlight-1',
            type: 'highlight_created',
            deviceId: 'server',
            novelId: 'novel-pull',
            entityId: 'highlight-remote',
            payload: {
              highlight: {
                id: 'highlight-remote',
                novelId: 'novel-pull',
                chapterId: 'novel-pull:chapter:1',
                paragraphId: 'novel-pull:paragraph:1',
                quote: 'remote highlight',
                color: 'green',
                progress: 0.55,
                createdAt: '2026-07-04T00:03:30.000Z',
                updatedAt: '2026-07-04T00:03:30.000Z',
              },
            },
            createdAt: '2026-07-04T00:03:30.000Z',
          },
          {
            id: 'remote-note-1',
            type: 'note_created',
            deviceId: 'server',
            novelId: 'novel-pull',
            entityId: 'note-remote',
            payload: {
              note: {
                id: 'note-remote',
                novelId: 'novel-pull',
                chapterId: 'novel-pull:chapter:1',
                paragraphId: 'novel-pull:paragraph:1',
                quote: 'remote note quote',
                body: 'remote note draft',
                progress: 0.6,
                createdAt: '2026-07-04T00:04:00.000Z',
                updatedAt: '2026-07-04T00:04:00.000Z',
              },
            },
            createdAt: '2026-07-04T00:04:00.000Z',
          },
          {
            id: 'remote-note-2',
            type: 'note_updated',
            deviceId: 'server',
            novelId: 'novel-pull',
            entityId: 'note-remote',
            payload: {
              note: {
                id: 'note-remote',
                novelId: 'novel-pull',
                chapterId: 'novel-pull:chapter:1',
                paragraphId: 'novel-pull:paragraph:1',
                quote: 'remote note quote',
                body: 'remote note final',
                progress: 0.65,
                createdAt: '2026-07-04T00:04:00.000Z',
                updatedAt: '2026-07-04T00:04:30.000Z',
              },
            },
            createdAt: '2026-07-04T00:04:30.000Z',
          },
        ];
        return {
          cursor: 12,
          events,
        };
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(await getReadingPosition('novel-pull')).toMatchObject({
      chapterId: 'novel-pull:chapter:1',
      paragraphId: 'novel-pull:paragraph:1',
      paragraphIndex: 1,
      scrollTop: 80,
    });
    expect(await getBookmarks('novel-pull')).toMatchObject([{ id: 'bookmark-remote', label: 'remote mark' }]);
    expect(await getHighlights('novel-pull')).toMatchObject([
      {
        id: 'highlight-remote',
        paragraphId: 'novel-pull:paragraph:1',
        quote: 'remote highlight',
        color: 'green',
      },
    ]);
    expect(await getNotes('novel-pull')).toMatchObject([
      {
        id: 'note-remote',
        paragraphId: 'novel-pull:paragraph:1',
        body: 'remote note final',
        updatedAt: '2026-07-04T00:04:30.000Z',
      },
    ]);
    expect(await listSyncOutbox('pending')).toEqual([]);
    expect(await listSyncOutbox('sent')).toHaveLength(1);
    expect(state).toMatchObject({ mode: 'connected', status: 'idle', lastRemoteCursor: 12, pendingCount: 0 });
  });
});
