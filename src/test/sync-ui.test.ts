import { describe, expect, it } from 'vitest';
import {
  aiTtsSyncConflictDescription,
  aiTtsSyncEventLabel,
  canRunSyncAction,
  isAiTtsSyncEventType,
  shouldOfferRemoteReadingPosition,
  shouldRunRemoteAutoRefresh,
  summarizeAiTtsSyncConflicts,
  summarizeAiTtsSyncConflictGroups,
  summarizeSyncOutbox,
  syncActionLabel,
  syncConflictResolutionDescription,
  syncOutboxRevisionLabel,
  syncOutboxTargetLabel,
  syncStatusDescription,
  syncStatusLabel,
  syncStatusTitle,
  syncStatusTone,
} from '../sync/sync-ui';
import { SyncOutboxItem, SyncState } from '../sync/types';

function syncState(status: SyncState['status'] = 'idle'): SyncState {
  return {
    id: 'sync-state',
    mode: 'connected',
    status,
    pendingCount: 0,
    nextSequence: 1,
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function outboxItem(id: string, status: SyncOutboxItem['status'], patch: Partial<SyncOutboxItem> = {}): SyncOutboxItem {
  return {
    id,
    event: {
      id: `event-${id}`,
      type: 'note_updated',
      deviceId: 'local-browser-123456789',
      novelId: 'book-abcdef123456789',
      entityId: 'note-123456789abcdef',
      payload: { noteId: 'note-123456789abcdef' },
      createdAt: '2026-07-05T00:00:00.000Z',
    },
    status,
    localSequence: 1,
    attempts: 0,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...patch,
  };
}

describe('sync UI helpers', () => {
  it('keeps local-only status calm even when local outbox rows exist', () => {
    const localState: SyncState = {
      ...syncState(),
      mode: 'local_only',
      pendingCount: 61,
    };

    expect(syncStatusLabel(localState)).toBe('로컬 전용');
    expect(syncStatusTone(localState)).toBe('local');
    expect(syncStatusTitle(localState)).toBe('로컬 전용 모드');
    expect(syncStatusDescription(localState, false, 'local')).toContain('로컬 저장소만 사용');
  });

  it('keeps connected pending status explicit when sync is configured', () => {
    const connectedState: SyncState = {
      ...syncState(),
      pendingCount: 3,
    };

    expect(syncStatusLabel(connectedState)).toBe('동기화 대기 3');
    expect(syncStatusTone(connectedState)).toBe('pending');
    expect(syncStatusTitle(connectedState)).toBe('서버 전송 대기 중');
    expect(syncStatusDescription(connectedState, true, 'local')).toContain('서버 전송');
  });

  it('enables server refresh in remote backend mode without a local sync service', () => {
    expect(
      canRunSyncAction({
        backendMode: 'remote',
        hasSyncService: false,
        syncFlushing: false,
        state: syncState(),
      }),
    ).toBe(true);
    expect(
      syncActionLabel({
        backendMode: 'remote',
        syncFlushing: false,
        state: syncState(),
      }),
    ).toBe('서버 새로고침');
  });

  it('keeps local-only sync disabled when no sync service is configured', () => {
    expect(
      canRunSyncAction({
        backendMode: 'local',
        hasSyncService: false,
        syncFlushing: false,
        state: syncState(),
      }),
    ).toBe(false);
  });

  it('uses busy labels while a sync action is in progress', () => {
    expect(
      syncActionLabel({
        backendMode: 'remote',
        syncFlushing: true,
        state: syncState('syncing'),
      }),
    ).toBe('새로고침 중');
    expect(
      syncActionLabel({
        backendMode: 'local',
        syncFlushing: true,
        state: syncState('syncing'),
      }),
    ).toBe('동기화 중');
  });

  it('runs hosted remote auto refresh only when no sync/import work is active', () => {
    expect(
      shouldRunRemoteAutoRefresh({
        backendMode: 'remote',
        syncFlushing: false,
        importBusy: false,
        state: syncState(),
      }),
    ).toBe(true);

    expect(
      shouldRunRemoteAutoRefresh({
        backendMode: 'remote',
        syncFlushing: true,
        importBusy: false,
        state: syncState(),
      }),
    ).toBe(false);

    expect(
      shouldRunRemoteAutoRefresh({
        backendMode: 'remote',
        syncFlushing: false,
        importBusy: true,
        state: syncState(),
      }),
    ).toBe(false);

    expect(
      shouldRunRemoteAutoRefresh({
        backendMode: 'local',
        syncFlushing: false,
        importBusy: false,
        state: syncState(),
      }),
    ).toBe(false);
  });

  it('offers a remote reading position only when the hosted server has a newer active-reader location', () => {
    expect(
      shouldOfferRemoteReadingPosition({
        backendMode: 'remote',
        view: 'reader',
        remotePosition: {
          chapterId: 'chapter-2',
          chapterProgress: 0.42,
          updatedAt: '2026-07-05T00:10:00.000Z',
        },
        currentChapterId: 'chapter-1',
        currentChapterProgress: 0.2,
        currentPositionUpdatedAt: '2026-07-05T00:00:00.000Z',
      }),
    ).toBe(true);

    expect(
      shouldOfferRemoteReadingPosition({
        backendMode: 'remote',
        view: 'reader',
        remotePosition: {
          chapterId: 'chapter-1',
          chapterProgress: 0.205,
          updatedAt: '2026-07-05T00:10:00.000Z',
        },
        currentChapterId: 'chapter-1',
        currentChapterProgress: 0.2,
        currentPositionUpdatedAt: '2026-07-05T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('does not offer stale or local-only reading position jumps', () => {
    expect(
      shouldOfferRemoteReadingPosition({
        backendMode: 'remote',
        view: 'reader',
        remotePosition: {
          chapterId: 'chapter-2',
          chapterProgress: 0.8,
          updatedAt: '2026-07-05T00:00:00.000Z',
        },
        currentChapterId: 'chapter-1',
        currentChapterProgress: 0.2,
        currentPositionUpdatedAt: '2026-07-05T00:10:00.000Z',
      }),
    ).toBe(false);

    expect(
      shouldOfferRemoteReadingPosition({
        backendMode: 'local',
        view: 'reader',
        remotePosition: {
          chapterId: 'chapter-2',
          chapterProgress: 0.8,
          updatedAt: '2026-07-05T00:10:00.000Z',
        },
        currentChapterId: 'chapter-1',
        currentChapterProgress: 0.2,
        currentPositionUpdatedAt: '2026-07-05T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('summarizes unsent outbox rows for the sync conflict panel', () => {
    const summary = summarizeSyncOutbox([
      outboxItem('pending', 'pending'),
      outboxItem('sending', 'sending'),
      outboxItem('failed', 'failed', { lastError: 'server has newer note' }),
      outboxItem('sent', 'sent'),
    ]);

    expect(summary).toEqual({
      pendingCount: 1,
      sendingCount: 1,
      failedCount: 1,
      unsentCount: 3,
      latestError: 'server has newer note',
    });
  });

  it('summarizes AI/TTS sync conflicts separately from ordinary reader events', () => {
    const summary = summarizeAiTtsSyncConflicts([
      outboxItem('voice', 'failed', {
        lastError: 'server has newer voice profile',
        event: {
          ...outboxItem('voice', 'failed').event,
          type: 'voice_profiles_updated',
          entityId: 'voice_profiles_book-abcdef123456789',
        },
      }),
      outboxItem('graph', 'pending', {
        event: {
          ...outboxItem('graph', 'pending').event,
          type: 'character_graph_updated',
          entityId: 'character_graph_book-abcdef123456789',
        },
      }),
      outboxItem('note', 'failed'),
      outboxItem('sent-correction', 'sent', {
        event: {
          ...outboxItem('sent-correction', 'sent').event,
          type: 'user_correction_created',
        },
      }),
    ]);

    expect(summary.unsentCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.latestError).toBe('server has newer voice profile');
    expect(summary.items.map((item) => item.event.type)).toEqual(['voice_profiles_updated', 'character_graph_updated']);
    expect(summary.eventCounts).toEqual({
      voice_profiles_updated: 1,
      user_correction_created: 0,
      user_correction_deleted: 0,
      character_graph_updated: 1,
      chapter_segments_updated: 0,
    });
    expect(aiTtsSyncConflictDescription(summary)).toContain('AI/TTS 변경 2개');
    expect(aiTtsSyncConflictDescription(summary)).toContain('음성 프로필 1개');
    expect(aiTtsSyncConflictDescription(summary)).toContain('인물 그래프 1개');
  });

  it('labels and detects AI/TTS sync event types', () => {
    expect(isAiTtsSyncEventType('character_graph_updated')).toBe(true);
    expect(isAiTtsSyncEventType('user_correction_deleted')).toBe(true);
    expect(isAiTtsSyncEventType('note_updated')).toBe(false);
    expect(aiTtsSyncEventLabel('user_correction_deleted')).toBe('라벨 교정 삭제');
    expect(aiTtsSyncEventLabel('chapter_segments_updated')).toBe('화자 라벨');
  });

  it('groups AI/TTS sync conflicts by entity with resolution policies', () => {
    const groups = summarizeAiTtsSyncConflictGroups([
      outboxItem('voice-old', 'failed', {
        localSequence: 3,
        lastError: 'server has newer voice profiles',
        event: {
          ...outboxItem('voice-old', 'failed').event,
          type: 'voice_profiles_updated',
          entityId: 'voice_profiles_book-abcdef123456789',
          revision: {
            entityType: 'voice_profiles',
            entityId: 'voice_profiles_book-abcdef123456789',
            novelId: 'book-abcdef123456789',
            localSequence: 3,
            updatedAt: '2026-07-05T00:00:00.000Z',
            payloadHash: 'hash-voice-old',
          },
        },
      }),
      outboxItem('voice-new', 'pending', {
        localSequence: 4,
        event: {
          ...outboxItem('voice-new', 'pending').event,
          type: 'voice_profiles_updated',
          entityId: 'voice_profiles_book-abcdef123456789',
          revision: {
            entityType: 'voice_profiles',
            entityId: 'voice_profiles_book-abcdef123456789',
            novelId: 'book-abcdef123456789',
            localSequence: 4,
            updatedAt: '2026-07-05T00:01:00.000Z',
            payloadHash: 'hash-voice-new',
          },
        },
      }),
      outboxItem('segments', 'sending', {
        localSequence: 5,
        event: {
          ...outboxItem('segments', 'sending').event,
          type: 'chapter_segments_updated',
          entityId: 'chapter_segments_chapter-123456789',
          revision: {
            entityType: 'chapter_segments',
            entityId: 'chapter_segments_chapter-123456789',
            novelId: 'book-abcdef123456789',
            localSequence: 5,
            updatedAt: '2026-07-05T00:02:00.000Z',
            payloadHash: 'hash-segments',
          },
        },
      }),
      outboxItem('note', 'failed'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      eventType: 'voice_profiles_updated',
      entityId: 'voice_profiles_book-abcdef123456789',
      unsentCount: 2,
      failedCount: 1,
      pendingCount: 1,
      policyLabel: '컬렉션 교체',
      canDiscard: true,
    });
    expect(groups[0].items.map((item) => item.localSequence)).toEqual([3, 4]);
    expect(groups[0].policyDescription).toContain('음성 프로필');
    expect(groups[1]).toMatchObject({
      eventType: 'chapter_segments_updated',
      unsentCount: 1,
      sendingCount: 1,
      policyLabel: '화자 라벨 교체',
      canDiscard: false,
    });
    expect(groups[1].policyDescription).toContain('사용자 교정 라벨');
  });

  it('builds compact target labels for queued sync events', () => {
    expect(syncOutboxTargetLabel(outboxItem('failed', 'failed'))).toBe(
      '책 book-abc... · 항목 note-123... · 기기 local-br...',
    );
    expect(
      syncOutboxTargetLabel(
        outboxItem('empty', 'pending', {
          event: {
            id: 'event-empty',
            type: 'settings_updated',
            deviceId: '',
            payload: {},
            createdAt: '2026-07-05T00:00:00.000Z',
          },
        }),
      ),
    ).toBe('대상 정보 없음');
  });

  it('builds local revision labels for queued sync events', () => {
    expect(
      syncOutboxRevisionLabel(
        outboxItem('note', 'failed', {
          localSequence: 7,
          event: {
            ...outboxItem('note', 'failed').event,
            revision: {
              entityType: 'note',
              entityId: 'note-123456789abcdef',
              novelId: 'book-abcdef123456789',
              localSequence: 7,
              updatedAt: '2026-07-05T00:00:00.000Z',
              payloadHash: 'hash-note',
            },
          },
        }),
      ),
    ).toBe('메모 수정 · 로컬 #7');

    expect(syncOutboxRevisionLabel(outboxItem('legacy', 'pending'))).toBe('로컬 순번 1');
    expect(
      syncOutboxRevisionLabel(
        outboxItem('graph', 'failed', {
          localSequence: 9,
          event: {
            ...outboxItem('graph', 'failed').event,
            type: 'character_graph_updated',
            revision: {
              entityType: 'character_graph',
              entityId: 'character_graph_book-abcdef123456789',
              novelId: 'book-abcdef123456789',
              localSequence: 9,
              updatedAt: '2026-07-05T00:00:00.000Z',
              payloadHash: 'hash-graph',
            },
          },
        }),
      ),
    ).toBe('인물 그래프 수정 · 로컬 #9');
  });

  it('explains server-wins cleanup only for active conflicts', () => {
    const summary = summarizeSyncOutbox([
      outboxItem('failed', 'failed', { lastError: 'server has newer note' }),
      outboxItem('pending', 'pending'),
    ]);

    expect(syncConflictResolutionDescription(syncState('idle'), summary)).toBeUndefined();
    expect(syncConflictResolutionDescription(syncState('conflict'), summarizeSyncOutbox([]))).toBeUndefined();
    expect(syncConflictResolutionDescription(syncState('conflict'), summary)).toContain('남은 로컬 대기열 2개');
    expect(syncConflictResolutionDescription(syncState('conflict'), summary)).toContain('서버 상태를 우선');
  });
});
