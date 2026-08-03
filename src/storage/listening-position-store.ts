import type { DocumentAnchor, ListeningPosition } from '../domain/types';
import type {
  ListeningPositionRepository,
  SaveListeningPositionInput,
} from '../repositories/listening-position-repository';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { getByIndex, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import {
  jsonValue,
  LOCAL_DEVICE_ID,
  nowIso,
  queueSyncEventInTransaction,
  tombstoneEntity,
  tombstoneId,
} from './sync-event-store';

export function listeningPositionId(bookId: string): string {
  return `listening_position_${bookId}`;
}

function normalizeAnchor(anchor: DocumentAnchor): DocumentAnchor {
  if (anchor.kind === 'fixed_page') {
    return { ...anchor, pageIndex: Math.max(0, Math.floor(anchor.pageIndex)) };
  }
  if (anchor.kind === 'fixed_text') {
    const startOffset = Math.max(0, Math.floor(anchor.startOffset));
    return {
      ...anchor,
      pageIndex: Math.max(0, Math.floor(anchor.pageIndex)),
      startOffset,
      endOffset: Math.max(startOffset, Math.floor(anchor.endOffset)),
    };
  }
  if (anchor.kind === 'fixed_region') {
    return {
      ...anchor,
      pageIndex: Math.max(0, Math.floor(anchor.pageIndex)),
      quads: anchor.quads.map((quad) => ({
        x: Math.max(0, Math.min(1, quad.x)),
        y: Math.max(0, Math.min(1, quad.y)),
        width: Math.max(0, Math.min(1, quad.width)),
        height: Math.max(0, Math.min(1, quad.height)),
      })),
    };
  }
  const startOffset = Math.max(0, Math.floor(anchor.startOffset));
  return {
    ...anchor,
    startOffset,
    endOffset: Math.max(startOffset, Math.floor(anchor.endOffset)),
    reader: { ...anchor.reader, offset: Math.max(0, Math.floor(anchor.reader.offset)) },
  };
}

export function getListeningPosition(bookId: string): Promise<ListeningPosition | undefined> {
  return getByIndex<ListeningPosition>(DOCUMENT_LISTENING_STORES.listeningPositions, 'bookId', bookId);
}

export async function saveListeningPosition(input: SaveListeningPositionInput): Promise<ListeningPosition> {
  const position: ListeningPosition = {
    id: listeningPositionId(input.bookId),
    bookId: input.bookId,
    chapterId: input.chapterId,
    anchor: normalizeAnchor(input.anchor),
    queueItemFingerprint: input.queueItemFingerprint,
    contentRevisionId: input.contentRevisionId,
    settingsFingerprint: input.settingsFingerprint,
    deviceId: input.deviceId ?? LOCAL_DEVICE_ID,
    updatedAt: input.updatedAt ?? nowIso(),
  };
  const db = await openReaderDb();
  const tx = db.transaction(
    [DOCUMENT_LISTENING_STORES.listeningPositions, 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  tx.objectStore(DOCUMENT_LISTENING_STORES.listeningPositions).put(position);
  tx.objectStore('sync_tombstones').delete(tombstoneId('listening_position', position.id));
  await queueSyncEventInTransaction(tx, 'listening_position_updated', jsonValue({ listeningPosition: position }), {
    novelId: input.bookId,
    entityId: position.id,
  });
  await transactionDone(tx);
  return position;
}

export async function clearListeningPosition(bookId: string): Promise<void> {
  const db = await openReaderDb();
  const id = listeningPositionId(bookId);
  const deletedAt = nowIso();
  const tx = db.transaction(
    [DOCUMENT_LISTENING_STORES.listeningPositions, 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  tx.objectStore(DOCUMENT_LISTENING_STORES.listeningPositions).delete(id);
  tx.objectStore('sync_tombstones').put(tombstoneEntity('listening_position', id, deletedAt, bookId));
  await queueSyncEventInTransaction(tx, 'listening_position_deleted', jsonValue({ id, deletedAt }), {
    novelId: bookId,
    entityId: id,
  });
  await transactionDone(tx);
}

export async function remapListeningPosition(
  bookId: string,
  anchor: DocumentAnchor,
  contentRevisionId: string,
): Promise<ListeningPosition | undefined> {
  const current = await getListeningPosition(bookId);
  if (!current) return undefined;
  return saveListeningPosition({
    ...current,
    bookId,
    anchor,
    contentRevisionId,
  });
}

export class IndexedDbListeningPositionRepository implements ListeningPositionRepository {
  get(bookId: string): Promise<ListeningPosition | undefined> {
    return getListeningPosition(bookId);
  }

  save(input: SaveListeningPositionInput): Promise<ListeningPosition> {
    return saveListeningPosition(input);
  }

  clear(bookId: string): Promise<void> {
    return clearListeningPosition(bookId);
  }

  remap(bookId: string, anchor: DocumentAnchor, contentRevisionId: string): Promise<ListeningPosition | undefined> {
    return remapListeningPosition(bookId, anchor, contentRevisionId);
  }
}
