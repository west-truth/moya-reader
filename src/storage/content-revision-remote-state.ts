import { hashSync } from '../domain/hash';
import { integrityHash, persistentId128 } from '../domain/id-hash-contract';
import { syncEventId, syncPayloadIntegrityHash } from '../domain/identity/sync-identities';
import type { Bookmark, Chapter, Novel, Paragraph, ParagraphPage, ReaderHighlight, ReaderNote } from '../domain/types';
import { resolveSyncContract } from '../sync/contract';
import type { JsonValue, ReadingPosition, RemoteBookSnapshotStream, SyncEvent, SyncOutboxItem } from '../sync/types';
import type { ContentActivationReaderPlan } from './content-revision-store';
import type { ReaderAnchorQuarantineEntity, ReaderAnchorQuarantineRecord } from './reader-anchor-quarantine';

export interface BookChildIdIndex {
  chapterIndexById: Map<string, number>;
  chapterIdByIndex: Map<number, string>;
  paragraphKeyById: Map<string, string>;
  paragraphIdByKey: Map<string, string>;
}

export interface LocalReaderChildSnapshot {
  readingPosition?: ReadingPosition;
  bookmarks: Bookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
}

export type ContentActivationSnapshot = Pick<RemoteBookSnapshotStream, 'novel' | 'chapters' | 'readingPosition'>;

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function stringField(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function jsonValue<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function bookProgressFromChapterProgress(
  novel: Novel,
  chapter: Chapter | undefined,
  chapterProgress: number,
): number {
  const clampedChapterProgress = clamp01(chapterProgress);
  const totalChapters = Math.max(1, novel.totalChapters);
  if (!chapter || totalChapters <= 1) return clampedChapterProgress;
  const chapterIndex = Math.max(1, Math.min(totalChapters, chapter.index));
  return clamp01((chapterIndex - 1 + clampedChapterProgress) / totalChapters);
}

export function createBookChildIdIndex(chapters: Chapter[]): BookChildIdIndex {
  const index: BookChildIdIndex = {
    chapterIndexById: new Map(),
    chapterIdByIndex: new Map(),
    paragraphKeyById: new Map(),
    paragraphIdByKey: new Map(),
  };
  for (const chapter of chapters) {
    index.chapterIndexById.set(chapter.id, chapter.index);
    index.chapterIdByIndex.set(chapter.index, chapter.id);
  }
  return index;
}

function paragraphRemapKey(chapterIndex: number, paragraphIndex: number, textHash: string): string {
  return `${chapterIndex}:${paragraphIndex}:${textHash}`;
}

export function addParagraphToChildIdIndex(index: BookChildIdIndex, paragraph: Paragraph): void {
  const chapterIndex = index.chapterIndexById.get(paragraph.chapterId);
  if (chapterIndex === undefined || !paragraph.text) return;
  const key = paragraphRemapKey(chapterIndex, paragraph.index, integrityHash(paragraph.text));
  index.paragraphKeyById.set(paragraph.id, key);
  if (!index.paragraphIdByKey.has(key)) index.paragraphIdByKey.set(key, paragraph.id);
}

export function addParagraphPagesToChildIdIndex(index: BookChildIdIndex, pages: ParagraphPage[]): void {
  pages.forEach((page) => page.paragraphs.forEach((paragraph) => addParagraphToChildIdIndex(index, paragraph)));
}

function remapAnchorIds(
  chapterId: string,
  paragraphId: string | undefined,
  oldIndex: BookChildIdIndex,
  nextIndex: BookChildIdIndex,
): { chapterId: string; paragraphId: string; changed: boolean } | undefined {
  if (!paragraphId) return undefined;
  const chapterIndex = oldIndex.chapterIndexById.get(chapterId);
  if (chapterIndex === undefined) return undefined;
  const nextChapterId = nextIndex.chapterIdByIndex.get(chapterIndex);
  if (!nextChapterId) return undefined;

  const paragraphKey = oldIndex.paragraphKeyById.get(paragraphId);
  if (!paragraphKey) return undefined;
  const nextParagraphId = nextIndex.paragraphIdByKey.get(paragraphKey);
  if (!nextParagraphId) return undefined;
  return {
    chapterId: nextChapterId,
    paragraphId: nextParagraphId,
    changed: nextChapterId !== chapterId || nextParagraphId !== paragraphId,
  };
}

function freshRemappedOutboxItem(
  item: SyncOutboxItem,
  payload: JsonValue,
  localSequence: number,
  now: string,
  targetContentRevisionId: string | undefined,
): SyncOutboxItem {
  const { sequence: _sequence, ...sourceEvent } = item.event;
  const eventId = syncEventId({
    userId: 'local',
    deviceId: item.event.deviceId,
    type: item.event.type,
    novelId: item.event.novelId,
    entityId: item.event.entityId,
    seed: `content-revision-remap:${targetContentRevisionId ?? ''}:${localSequence}:${now}:${item.event.id}`,
  });
  const event: SyncEvent = {
    ...sourceEvent,
    id: eventId,
    payload,
    revision: item.event.revision
      ? {
          ...item.event.revision,
          localSequence,
          updatedAt: now,
          payloadHash:
            resolveSyncContract(item.event).contractVersion === 2
              ? syncPayloadIntegrityHash(payload)
              : hashSync(JSON.stringify(payload)),
        }
      : undefined,
    createdAt: now,
  };
  return {
    id: persistentId128('sync_outbox', [eventId]),
    event,
    status: 'pending',
    localSequence,
    attempts: 0,
    attemptCount: undefined,
    lastAttemptAt: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function readingPositionIsNewer(local: ReadingPosition, remote: ReadingPosition | undefined): boolean {
  if (!remote) return true;
  const localTimestamp = Date.parse(local.updatedAt);
  const remoteTimestamp = Date.parse(remote.updatedAt);
  if (!Number.isFinite(localTimestamp)) return false;
  if (!Number.isFinite(remoteTimestamp)) return true;
  return localTimestamp > remoteTimestamp;
}

function remapJsonAnchorRecord(
  record: Record<string, JsonValue>,
  oldIndex: BookChildIdIndex,
  nextIndex: BookChildIdIndex,
): { record: Record<string, JsonValue>; changed: boolean } | undefined {
  const chapterId = stringField(record.chapterId);
  if (!chapterId) return undefined;
  const paragraphId = stringField(record.paragraphId) || undefined;
  const remapped = remapAnchorIds(chapterId, paragraphId, oldIndex, nextIndex);
  if (!remapped) return undefined;
  return {
    changed: remapped.changed,
    record: {
      ...record,
      chapterId: remapped.chapterId,
      paragraphId: remapped.paragraphId,
    },
  };
}

function syncEventAnchorPayloadKey(event: SyncEvent): 'position' | 'bookmark' | 'highlight' | 'note' | undefined {
  return event.type === 'reading_position_updated'
    ? 'position'
    : event.type === 'bookmark_created'
      ? 'bookmark'
      : event.type === 'highlight_created'
        ? 'highlight'
        : event.type === 'note_created' || event.type === 'note_updated'
          ? 'note'
          : undefined;
}

function remapSyncEventPayload(
  event: SyncEvent,
  oldIndex: BookChildIdIndex,
  nextIndex: BookChildIdIndex,
): { payload: JsonValue; changed: boolean } | undefined {
  const payload = recordValue(event.payload);
  const payloadKey = syncEventAnchorPayloadKey(event);
  if (!payloadKey) return undefined;
  const remapped = remapJsonAnchorRecord(recordValue(payload[payloadKey]), oldIndex, nextIndex);
  return remapped
    ? { payload: jsonValue({ ...payload, [payloadKey]: remapped.record }), changed: remapped.changed }
    : undefined;
}

function eventBelongsToNovel(event: SyncEvent, novelId: string): boolean {
  if (event.novelId === novelId || event.revision?.novelId === novelId) return true;
  const payload = recordValue(event.payload);
  const nested =
    recordValue(payload.position).novelId ||
    recordValue(payload.bookmark).novelId ||
    recordValue(payload.highlight).novelId ||
    recordValue(payload.note).novelId ||
    recordValue(payload.annotation).bookId;
  return nested === novelId;
}

function applyRemoteReadingPosition(
  novel: Novel,
  readingPosition: ReadingPosition | undefined,
  chapters: Chapter[],
): Novel {
  if (!readingPosition) return novel;
  const chapter = chapters.find((item) => item.id === readingPosition.chapterId);
  return {
    ...novel,
    lastReadChapterId: readingPosition.chapterId,
    lastReadChapterIndex: chapter?.index,
    lastReadParagraphId: readingPosition.paragraphId,
    lastReadOffset: readingPosition.scrollTop,
    lastReadProgress: bookProgressFromChapterProgress(novel, chapter, readingPosition.chapterProgress),
    updatedAt: readingPosition.updatedAt >= novel.updatedAt ? readingPosition.updatedAt : novel.updatedAt,
  };
}

export function prepareRemoteContentActivation(input: {
  snapshot: ContentActivationSnapshot;
  baseNovel?: Novel;
  localSnapshot: LocalReaderChildSnapshot;
  outboxItems: SyncOutboxItem[];
  oldIndex: BookChildIdIndex;
  nextIndex: BookChildIdIndex;
  expectedSyncNextSequence?: number;
  now: string;
  sourceContentRevisionId?: string;
  targetContentRevisionId?: string;
}): { novel: Novel; readerPlan: ContentActivationReaderPlan } {
  const { snapshot, baseNovel, localSnapshot, oldIndex, nextIndex } = input;
  const novelId = snapshot.novel.id;
  const quarantineRecords: ReaderAnchorQuarantineRecord[] = [];
  const quarantine = (
    entityType: ReaderAnchorQuarantineEntity,
    sourceEntityId: string,
    payload: unknown,
    reason: ReaderAnchorQuarantineRecord['reason'] = 'content_replaced_anchor_unmatched',
  ) => {
    quarantineRecords.push({
      id: `reader_anchor_quarantine:${input.targetContentRevisionId ?? input.now}:${entityType}:${sourceEntityId}`,
      novelId,
      entityType,
      sourceEntityId,
      sourceContentRevisionId: input.sourceContentRevisionId,
      targetContentRevisionId: input.targetContentRevisionId,
      reason,
      payload,
      quarantinedAt: input.now,
    });
  };
  const deleteOutboxItemIds: string[] = [];
  const outboxItems: SyncOutboxItem[] = [];
  let nextSyncSequence =
    input.expectedSyncNextSequence ??
    input.outboxItems.reduce((next, item) => Math.max(next, item.localSequence + 1), 1);
  for (const item of input.outboxItems) {
    if (!eventBelongsToNovel(item.event, novelId)) continue;
    const payloadKey = syncEventAnchorPayloadKey(item.event);
    if (!payloadKey) continue;
    const remapped = remapSyncEventPayload(item.event, oldIndex, nextIndex);
    if (!remapped) {
      deleteOutboxItemIds.push(item.id);
      quarantine('sync_outbox', item.id, item);
      continue;
    }
    const requiresFreshIdentity = remapped.changed || item.status === 'sent' || item.status === 'sending';
    if (!requiresFreshIdentity) continue;
    outboxItems.push(
      freshRemappedOutboxItem(item, remapped.payload, nextSyncSequence, input.now, input.targetContentRevisionId),
    );
    nextSyncSequence += 1;
    if (item.status !== 'sent') deleteOutboxItemIds.push(item.id);
    if (item.status === 'sending') {
      quarantine('sync_outbox', item.id, item, 'content_replaced_inflight_replaced');
    }
  }

  const planAnchoredRecords = <T extends { id: string; chapterId: string; paragraphId?: string }>(
    records: T[],
    entityType: 'bookmark' | 'highlight' | 'note',
  ): { remapped: T[]; deleteIds: string[] } => {
    const remapped: T[] = [];
    const deleteIds: string[] = [];
    for (const record of records) {
      const next = remapAnchorIds(record.chapterId, record.paragraphId, oldIndex, nextIndex);
      if (!next) {
        deleteIds.push(record.id);
        quarantine(entityType, record.id, record);
      } else if (next.changed) {
        remapped.push({ ...record, chapterId: next.chapterId, paragraphId: next.paragraphId });
      }
    }
    return { remapped, deleteIds };
  };
  const bookmarkPlan = planAnchoredRecords(localSnapshot.bookmarks, 'bookmark');
  const highlightPlan = planAnchoredRecords(localSnapshot.highlights, 'highlight');
  const notePlan = planAnchoredRecords(localSnapshot.notes, 'note');

  let novel = applyRemoteReadingPosition(snapshot.novel, snapshot.readingPosition, snapshot.chapters);
  let readingPosition = snapshot.readingPosition;
  let deleteReadingPosition = !readingPosition;
  if (localSnapshot.readingPosition) {
    const localPosition = localSnapshot.readingPosition;
    const remapped = remapAnchorIds(localPosition.chapterId, localPosition.paragraphId, oldIndex, nextIndex);
    if (remapped && readingPositionIsNewer(localPosition, snapshot.readingPosition)) {
      const mappedPosition = {
        ...localPosition,
        chapterId: remapped.chapterId,
        paragraphId: remapped.paragraphId,
      };
      readingPosition = mappedPosition;
      deleteReadingPosition = false;
      const chapter = snapshot.chapters.find((item) => item.id === mappedPosition.chapterId);
      novel = {
        ...novel,
        lastReadChapterId: mappedPosition.chapterId,
        lastReadChapterIndex: chapter?.index,
        lastReadParagraphId: mappedPosition.paragraphId,
        lastReadOffset: mappedPosition.scrollTop,
        lastReadProgress: bookProgressFromChapterProgress(novel, chapter, mappedPosition.chapterProgress),
        updatedAt: mappedPosition.updatedAt >= novel.updatedAt ? mappedPosition.updatedAt : novel.updatedAt,
      };
    } else if (!remapped) {
      quarantine('reading_position', localPosition.id, localPosition);
      deleteReadingPosition = !snapshot.readingPosition;
    }
    if (!remapped) {
      if (snapshot.readingPosition) {
        novel = applyRemoteReadingPosition(novel, snapshot.readingPosition, snapshot.chapters);
      } else if (baseNovel) {
        novel = {
          ...novel,
          lastReadChapterId: undefined,
          lastReadChapterIndex: undefined,
          lastReadParagraphId: undefined,
          lastReadOffset: 0,
          lastReadProgress: 0,
          lastReadAt: baseNovel.lastReadAt,
          readingSeconds: baseNovel.readingSeconds,
        };
      }
    }
  }
  return {
    novel,
    readerPlan: {
      expectedSyncNextSequence: input.expectedSyncNextSequence,
      nextSyncSequence: outboxItems.length ? nextSyncSequence : undefined,
      readingPosition,
      deleteReadingPosition,
      bookmarks: bookmarkPlan.remapped,
      highlights: highlightPlan.remapped,
      notes: notePlan.remapped,
      outboxItems,
      deleteBookmarkIds: bookmarkPlan.deleteIds,
      deleteHighlightIds: highlightPlan.deleteIds,
      deleteNoteIds: notePlan.deleteIds,
      deleteOutboxItemIds,
      quarantineRecords,
    },
  };
}
