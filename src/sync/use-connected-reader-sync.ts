import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
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
import type { ReaderRuntime } from '../repositories/reader-runtime';
import { loadLocalConnectedRefreshState, type LocalConnectedRefreshState } from './local-connected-refresh';
import { loadHostedRemoteRefreshState, type HostedRemoteRefreshState } from './remote-refresh';
import type { ConnectedSyncSelection } from './connected-sync-controller';
import type { ReaderView } from './sync-ui';
import type { ReadingPosition, SyncOutboxItem, SyncState } from './types';
import { useConnectedSyncController } from './use-connected-sync-controller';

type Setter<Value> = Dispatch<SetStateAction<Value>>;

export interface ConnectedReaderSyncBindings {
  readonly setReaderSettings: Setter<ReaderSettings>;
  readonly setNovels: Setter<Novel[]>;
  readonly replaceSelection: (
    replacement: Partial<{
      view: ReaderView;
      selectedNovel: Novel;
      chapters: Chapter[];
      currentChapter: Chapter;
      localReadingPosition: ReadingPosition;
      remoteReadingPosition: ReadingPosition;
    }>,
  ) => void;
  readonly setBookmarks: Setter<Bookmark[]>;
  readonly setHighlights: Setter<ReaderHighlight[]>;
  readonly setNotes: Setter<ReaderNote[]>;
  readonly setSegments: Setter<LabeledSegment[]>;
  readonly setCharacters: Setter<Character[]>;
  readonly setVoiceProfiles: Setter<VoiceProfile[]>;
  readonly setSyncState: Setter<SyncState | undefined>;
  readonly setSyncOutbox: Setter<SyncOutboxItem[]>;
  readonly setSyncFlushing: Setter<boolean>;
  readonly setActiveChapterId: (id: string | undefined) => void;
}

export interface ConnectedReaderSyncInput {
  readonly runtime: ReaderRuntime;
  readonly selection: ConnectedSyncSelection<Novel, Chapter>;
  readonly serverAttachBusy: boolean;
  readonly resetParagraphCache: () => void;
  readonly bindings: ConnectedReaderSyncBindings;
}

export type RemoteRefreshOptions = { silent?: boolean };

interface RemoteServerRefreshResult {
  state: SyncState;
  outbox: SyncOutboxItem[];
  remoteState?: HostedRemoteRefreshState;
  trashNovels?: Novel[];
}

export function connectedSyncFailureState(message: string): SyncState {
  const updatedAt = new Date().toISOString();
  return {
    id: 'sync-state',
    mode: 'connected',
    status: 'failed',
    pendingCount: 0,
    nextSequence: 1,
    lastError: message,
    updatedAt,
  };
}

export function useConnectedReaderSync(input: ConnectedReaderSyncInput) {
  const { bindings, resetParagraphCache, runtime, selection, serverAttachBusy } = input;
  const { readerRepository, syncService } = runtime;
  const controller = useConnectedSyncController(runtime, selection);
  const bindingsRef = useRef(bindings);
  const serverAttachBusyRef = useRef(serverAttachBusy);
  const mutationPushPendingRef = useRef(false);
  useLayoutEffect(() => {
    bindingsRef.current = bindings;
    serverAttachBusyRef.current = serverAttachBusy;
  }, [bindings, serverAttachBusy]);

  const refreshNovels = useCallback(
    () =>
      controller.runRuntimeTask('novel-catalog-refresh', {
        load: async () => {
          const [active, trash] = await Promise.all([
            readerRepository.listNovels(),
            runtime.libraryCatalogRepository?.listTrash() ?? Promise.resolve([]),
          ]);
          return [...active, ...trash];
        },
        commit: (novels) => bindingsRef.current.setNovels(novels),
      }),
    [controller, readerRepository, runtime.libraryCatalogRepository],
  );

  const refreshSyncState = useCallback(async () => {
    const snapshot = await controller.runRuntimeTask('sync-status-refresh', {
      load: async () => {
        const [state, outbox] = await Promise.all([readerRepository.getSyncState(), readerRepository.listSyncOutbox()]);
        return { state, outbox };
      },
      commit: ({ state, outbox }) => {
        bindingsRef.current.setSyncState(state);
        bindingsRef.current.setSyncOutbox(outbox);
      },
    });
    return snapshot?.state;
  }, [controller, readerRepository]);

  const applyHostedState = useCallback(
    (remoteState: HostedRemoteRefreshState, bookId?: string, chapterId?: string) => {
      const bindings = bindingsRef.current;
      bindings.setNovels(remoteState.novels);
      if (!bookId) return;
      if (remoteState.selection.status === 'missing') {
        bindings.replaceSelection({
          selectedNovel: undefined,
          currentChapter: undefined,
          chapters: [],
          remoteReadingPosition: undefined,
          localReadingPosition: undefined,
          view: 'library',
        });
        resetParagraphCache();
        bindings.setBookmarks([]);
        bindings.setHighlights([]);
        bindings.setNotes([]);
        return;
      }
      if (remoteState.selection.status !== 'loaded') return;
      bindings.replaceSelection({
        selectedNovel: remoteState.selection.novel,
        chapters: remoteState.selection.chapters,
        remoteReadingPosition: remoteState.selection.remoteReadingPosition,
        localReadingPosition: remoteState.selection.readingPosition,
        ...(chapterId ? { currentChapter: remoteState.selection.currentChapter } : undefined),
      });
      bindings.setBookmarks(remoteState.selection.bookmarks);
      bindings.setHighlights(remoteState.selection.highlights);
      bindings.setNotes(remoteState.selection.notes);
      if (chapterId) {
        bindings.setActiveChapterId(remoteState.selection.currentChapter?.id);
        if (remoteState.selection.currentChapterChanged) resetParagraphCache();
      }
    },
    [resetParagraphCache],
  );

  const refreshRemoteServerState = useCallback(
    async (options: RemoteRefreshOptions = {}) => {
      const result = await controller.runSelectionTask<RemoteServerRefreshResult>('remote-server-refresh', {
        start: () => {
          if (options.silent) return;
          const bindings = bindingsRef.current;
          bindings.setSyncState((previous) => ({
            id: 'sync-state',
            mode: 'connected',
            status: 'syncing',
            pendingCount: 0,
            nextSequence: previous?.nextSequence ?? 1,
            lastRemoteCursor: previous?.lastRemoteCursor,
            lastSyncedAt: previous?.lastSyncedAt,
            updatedAt: new Date().toISOString(),
          }));
          bindings.setSyncFlushing(true);
        },
        load: async ({ selection }) => {
          const [remoteState, state, outbox, trashNovels] = await Promise.all([
            loadHostedRemoteRefreshState({
              repository: readerRepository,
              backendMode: runtime.mode,
              view: selection.view,
              selectedNovel: selection.book,
              currentChapter: selection.chapter,
              currentChapterProgress: selection.chapterProgress,
            }),
            readerRepository.getSyncState(),
            readerRepository.listSyncOutbox(),
            runtime.libraryCatalogRepository?.listTrash() ?? Promise.resolve([]),
          ]);
          return { state, outbox, remoteState, trashNovels };
        },
        commit: ({ state, outbox, remoteState, trashNovels }, { selection }) => {
          if (remoteState) {
            applyHostedState(
              { ...remoteState, novels: [...remoteState.novels, ...(trashNovels ?? [])] },
              selection.bookId,
              selection.chapterId,
            );
          }
          bindingsRef.current.setSyncState(state);
          bindingsRef.current.setSyncOutbox(outbox);
        },
        recover: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          const state = connectedSyncFailureState(message);
          bindingsRef.current.setSyncState(state);
          bindingsRef.current.setSyncOutbox([]);
          return { state, outbox: [] };
        },
        settle: (context) => {
          if (!options.silent) {
            bindingsRef.current.setSyncFlushing(false);
            if (!context.isSelectionCurrent()) void refreshSyncState();
          }
        },
      });
      return result?.state;
    },
    [applyHostedState, controller, readerRepository, refreshSyncState, runtime.libraryCatalogRepository, runtime.mode],
  );

  const applyLocalState = useCallback(
    (state: LocalConnectedRefreshState, viewAtStart: ReaderView, chapterIdAtStart?: string) => {
      const bindings = bindingsRef.current;
      bindings.setReaderSettings(state.settings);
      bindings.setNovels(state.novels);
      if (state.selection.status === 'none') return;
      if (state.selection.status === 'missing') {
        bindings.replaceSelection({
          selectedNovel: undefined,
          currentChapter: undefined,
          chapters: [],
          remoteReadingPosition: undefined,
          localReadingPosition: undefined,
          view: 'library',
        });
        bindings.setActiveChapterId(undefined);
        resetParagraphCache();
        bindings.setBookmarks([]);
        bindings.setHighlights([]);
        bindings.setNotes([]);
        bindings.setSegments([]);
        bindings.setCharacters([]);
        bindings.setVoiceProfiles([]);
        return;
      }
      const currentChapter = chapterIdAtStart ? state.selection.currentChapter : undefined;
      bindings.replaceSelection({
        selectedNovel: state.selection.novel,
        chapters: state.selection.chapters,
        localReadingPosition: state.selection.readingPosition,
        remoteReadingPosition: undefined,
        ...(chapterIdAtStart
          ? {
              currentChapter,
              ...(currentChapter || viewAtStart !== 'reader' ? undefined : { view: 'chapters' as const }),
            }
          : undefined),
      });
      bindings.setBookmarks(state.selection.bookmarks);
      bindings.setHighlights(state.selection.highlights);
      bindings.setNotes(state.selection.notes);
      bindings.setCharacters(state.selection.characters);
      bindings.setVoiceProfiles(state.selection.voiceProfiles);
      if (!chapterIdAtStart) return;
      if (!state.selection.currentChapter) {
        bindings.setActiveChapterId(undefined);
        resetParagraphCache();
        bindings.setSegments([]);
        return;
      }
      bindings.setActiveChapterId(state.selection.currentChapter.id);
      if (state.selection.currentChapterChanged) resetParagraphCache();
      bindings.setSegments(state.selection.segments);
    },
    [resetParagraphCache],
  );

  const flushSyncState = useCallback(async () => {
    if (!syncService) return refreshSyncState();
    const result = await controller.runSelectionTask('connected-sync-flush', {
      start: () => {
        const bindings = bindingsRef.current;
        bindings.setSyncState((previous) =>
          previous
            ? { ...previous, mode: 'connected', status: 'syncing', updatedAt: new Date().toISOString() }
            : previous,
        );
        bindings.setSyncFlushing(true);
      },
      load: async ({ selection }) => {
        const state = await syncService.flushPending();
        const [outbox, localState, trashNovels] = await Promise.all([
          readerRepository.listSyncOutbox(),
          state.status === 'idle'
            ? loadLocalConnectedRefreshState({
                repository: readerRepository,
                selectedNovel: selection.book,
                currentChapter: selection.chapter,
              })
            : Promise.resolve(undefined),
          runtime.libraryCatalogRepository?.listTrash() ?? Promise.resolve([]),
        ]);
        return {
          state,
          outbox,
          localState: localState ? { ...localState, novels: [...localState.novels, ...trashNovels] } : undefined,
        };
      },
      commit: ({ state, outbox, localState }, { selection }) => {
        bindingsRef.current.setSyncState(state);
        bindingsRef.current.setSyncOutbox(outbox);
        if (localState) applyLocalState(localState, selection.view, selection.chapterId);
      },
      settle: (context) => {
        bindingsRef.current.setSyncFlushing(false);
        if (!context.isSelectionCurrent()) void refreshSyncState();
      },
    });
    return result?.state;
  }, [applyLocalState, controller, readerRepository, refreshSyncState, runtime.libraryCatalogRepository, syncService]);

  const schedulePendingMutationPush = useCallback(
    (delayMs?: number) => {
      if (!syncService || !mutationPushPendingRef.current || serverAttachBusyRef.current) return;
      controller.scheduleMutationPush(async () => {
        if (serverAttachBusyRef.current) return;
        mutationPushPendingRef.current = false;
        await flushSyncState();
      }, delayMs);
    },
    [controller, flushSyncState, syncService],
  );

  useEffect(() => {
    if (!serverAttachBusy) schedulePendingMutationPush();
  }, [schedulePendingMutationPush, serverAttachBusy]);

  useEffect(
    () => () => {
      mutationPushPendingRef.current = false;
    },
    [controller],
  );

  const refreshAfterLocalMutation = useCallback(
    async (kind?: string) => {
      const state = await refreshSyncState();
      if (syncService && state && state.status !== 'conflict') {
        mutationPushPendingRef.current = true;
        schedulePendingMutationPush(kind === 'progress' ? 5_000 : undefined);
      }
      return state;
    },
    [refreshSyncState, schedulePendingMutationPush, syncService],
  );

  return {
    connectedSyncController: controller,
    flushSyncState,
    refreshAfterLocalMutation,
    refreshNovels,
    refreshRemoteServerState,
    refreshSyncState,
  };
}
