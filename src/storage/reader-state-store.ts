import type { Novel, ReaderSettings } from '../domain/types';
import { defaultSettings } from '../repositories/reader-defaults';
import { bookProgressFromChapterProgress } from './content-revision-remote-state';
import { storedNovel } from './content-revision-store';
import { ContentRevisionConflictError } from './content-revisions';
import {
  deleteByIndexInTransaction,
  getByIndex,
  getItem,
  requestToPromise,
  transactionDone,
} from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { getChapter } from './reader-query-store';
import { jsonValue, LOCAL_DEVICE_ID, nowIso, queueSyncEventInTransaction, tombstoneEntity } from './sync-event-store';
import type { ReadingPosition } from '../sync/types';
import {
  RepositoryEntityNotFoundError,
  type NovelMetadataPatch,
  type SaveReadingPositionInput,
} from '../repositories/reader-repository';

export async function patchNovelMetadata(novelId: string, patch: NovelMetadataPatch): Promise<void> {
  if (patch.title === undefined && patch.favorite === undefined && patch.analysisStatus === undefined) return;
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const current = await requestToPromise<Novel | undefined>(store.get(novelId));
  if (!current) {
    await done;
    throw new RepositoryEntityNotFoundError('novel', novelId);
  }
  const next = storedNovel({
    ...current,
    ...(patch.title === undefined ? undefined : { title: patch.title }),
    ...(patch.favorite === undefined ? undefined : { favorite: patch.favorite }),
    ...(patch.analysisStatus === undefined ? undefined : { analysisStatus: patch.analysisStatus }),
    metadataRevision: (current.metadataRevision ?? 0) + 1,
    updatedAt: nowIso(),
  });
  store.put(next);
  const syncedPatch = {
    id: next.id,
    title: next.title,
    favorite: next.favorite,
    analysisStatus: next.analysisStatus,
    metadataRevision: next.metadataRevision,
    updatedAt: next.updatedAt,
  };
  await queueSyncEventInTransaction(tx, 'book_updated', jsonValue({ novel: syncedPatch }), {
    novelId: next.id,
    entityId: next.id,
  });
  await done;
}

export async function saveReadingPosition(input: SaveReadingPositionInput): Promise<void> {
  const clampedProgress = Math.max(0, Math.min(1, input.chapterProgress));
  const roundedScrollTop = Math.max(0, Math.round(input.scrollTop));
  const chapter = await getChapter(input.chapterId);
  const position: ReadingPosition = {
    id: `reading_position_${input.novelId}`,
    novelId: input.novelId,
    chapterId: input.chapterId,
    paragraphId: input.paragraphId,
    paragraphIndex: input.paragraphIndex,
    offsetInParagraph: input.offsetInParagraph ?? 0,
    chapterProgress: clampedProgress,
    scrollTop: roundedScrollTop,
    deviceId: LOCAL_DEVICE_ID,
    updatedAt: nowIso(),
  };

  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'reading_positions', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const novelStore = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(novelStore.get(input.novelId));
  if (!novel) {
    await done;
    return;
  }
  if (
    input.expectedContentRevisionId !== undefined &&
    novel.activeContentRevisionId !== input.expectedContentRevisionId
  ) {
    tx.abort();
    await done.catch(() => undefined);
    throw new ContentRevisionConflictError('Content revision changed before reader position was saved');
  }
  novelStore.put(
    storedNovel({
      ...novel,
      lastReadChapterId: input.chapterId,
      lastReadChapterIndex: chapter?.index,
      lastReadParagraphId: input.paragraphId,
      lastReadOffset: roundedScrollTop,
      lastReadProgress: bookProgressFromChapterProgress(novel, chapter, clampedProgress),
    }),
  );
  tx.objectStore('reading_positions').put(position);
  await queueSyncEventInTransaction(tx, 'reading_position_updated', jsonValue({ position }), {
    novelId: input.novelId,
    entityId: position.id,
  });
  await done;
}

export function getReadingPosition(novelId: string): Promise<ReadingPosition | undefined> {
  return getByIndex<ReadingPosition>('reading_positions', 'novelId', novelId);
}

export async function clearReadingPosition(novelId: string): Promise<void> {
  const deletedAt = nowIso();
  const positionId = `reading_position_${novelId}`;
  const db = await openReaderDb();
  const tx = db.transaction(
    ['novels', 'reading_positions', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const novelStore = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(novelStore.get(novelId));
  if (!novel) {
    await done;
    return;
  }
  novelStore.put(
    storedNovel({
      ...novel,
      lastReadChapterId: undefined,
      lastReadChapterIndex: undefined,
      lastReadParagraphId: undefined,
      lastReadOffset: 0,
      lastReadProgress: 0,
      updatedAt: deletedAt,
    }),
  );
  deleteByIndexInTransaction(tx, 'reading_positions', 'novelId', novelId);
  tx.objectStore('sync_tombstones').put(tombstoneEntity('reading_position', positionId, deletedAt, novelId));
  await queueSyncEventInTransaction(tx, 'reading_position_deleted', jsonValue({ id: positionId, deletedAt }), {
    novelId,
    entityId: positionId,
  });
  await done;
}

export async function addNovelReadingTime(novelId: string, seconds: number, readAt = nowIso()): Promise<void> {
  const deltaSeconds = Math.max(0, Math.floor(seconds));
  if (deltaSeconds <= 0) return;

  const db = await openReaderDb();
  const tx = db.transaction('novels', 'readwrite');
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(novelId));
  if (novel) {
    store.put(
      storedNovel({
        ...novel,
        readingSeconds: Math.max(0, novel.readingSeconds ?? 0) + deltaSeconds,
        lastReadAt: readAt,
        updatedAt: readAt,
      }),
    );
  }
  await transactionDone(tx);
}

export async function getSettings(): Promise<ReaderSettings> {
  const settings = await getItem<ReaderSettings>('settings', defaultSettings.id);
  return {
    ...defaultSettings,
    ...settings,
    ttsPlayback: {
      ...defaultSettings.ttsPlayback,
      ...settings?.ttsPlayback,
      rate: settings?.ttsPlayback?.rate ?? settings?.ttsSpeed ?? defaultSettings.ttsPlayback.rate,
    },
    readingProfile: { ...defaultSettings.readingProfile, ...settings?.readingProfile },
    aiWorkflows: {
      ...defaultSettings.aiWorkflows!,
      ...settings?.aiWorkflows,
      bookOverrides: {
        ...defaultSettings.aiWorkflows?.bookOverrides,
        ...settings?.aiWorkflows?.bookOverrides,
      },
    },
    gestureBindings: { ...defaultSettings.gestureBindings, ...settings?.gestureBindings },
  };
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(['settings', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const next = { ...settings, cloudVaultUpdatedAt: new Date().toISOString() } satisfies ReaderSettings;
  tx.objectStore('settings').put(next);
  await queueSyncEventInTransaction(tx, 'settings_updated', jsonValue({ settings: next }), { entityId: settings.id });
  await transactionDone(tx);
}
