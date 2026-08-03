import type {
  Bookmark,
  Character,
  DocumentAnnotation,
  DocumentTextOrderOverride,
  LabeledSegment,
  ReaderHighlight,
  ReaderNote,
  ReadingSessionEvent,
  Shelf,
  UserCorrection,
  VoiceProfile,
} from '../domain/types';
import type { CloudVaultBookV1, CloudVaultSnapshotV1, CloudVaultTombstoneV1 } from './contracts';
import { CLOUD_VAULT_FORMAT, CLOUD_VAULT_VERSION } from './contracts';

function newer(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '') >= (right ?? '');
}

function mergeById<T extends { readonly id: string }>(
  left: readonly T[],
  right: readonly T[],
  choose: (left: T, right: T) => T,
): T[] {
  const merged = new Map(right.map((item) => [item.id, item]));
  for (const item of left) {
    const existing = merged.get(item.id);
    merged.set(item.id, existing ? choose(item, existing) : item);
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const chooseBookmark = (left: Bookmark, right: Bookmark) => (newer(left.createdAt, right.createdAt) ? left : right);
const chooseHighlight = (left: ReaderHighlight, right: ReaderHighlight) =>
  newer(left.updatedAt, right.updatedAt) ? left : right;
const chooseNote = (left: ReaderNote, right: ReaderNote) => (newer(left.updatedAt, right.updatedAt) ? left : right);
const chooseDocumentAnnotation = (left: DocumentAnnotation, right: DocumentAnnotation) =>
  newer(left.deletedAt ?? left.updatedAt, right.deletedAt ?? right.updatedAt) ? left : right;
const chooseDocumentTextOrderOverride = (left: DocumentTextOrderOverride, right: DocumentTextOrderOverride) =>
  newer(left.updatedAt, right.updatedAt) ? left : right;
const chooseSession = (left: ReadingSessionEvent, right: ReadingSessionEvent) =>
  newer(left.endedAt, right.endedAt) ? left : right;
const chooseCorrection = (left: UserCorrection, right: UserCorrection) =>
  newer(left.createdAt, right.createdAt) ? left : right;
const chooseShelf = (left: Shelf, right: Shelf) => (newer(left.updatedAt, right.updatedAt) ? left : right);
const chooseTombstone = (left: CloudVaultTombstoneV1, right: CloudVaultTombstoneV1) =>
  newer(left.deletedAt, right.deletedAt) ? left : right;

function chooseCharacter(left: Character, right: Character, preferLeft: boolean): Character {
  if (left.isUserConfirmed !== right.isUserConfirmed) return left.isUserConfirmed ? left : right;
  return preferLeft ? left : right;
}

function chooseSegment(left: LabeledSegment, right: LabeledSegment, preferLeft: boolean): LabeledSegment {
  if (left.isUserCorrected !== right.isUserCorrected) return left.isUserCorrected ? left : right;
  return preferLeft ? left : right;
}

function voiceTimestamp(profile: VoiceProfile): string {
  return profile.updatedAt ?? profile.createdAt ?? '';
}

function chooseVoice(left: VoiceProfile, right: VoiceProfile, preferLeft: boolean): VoiceProfile {
  if (left.isUserSelected !== right.isUserSelected) return left.isUserSelected ? left : right;
  if (voiceTimestamp(left) !== voiceTimestamp(right)) {
    return newer(voiceTimestamp(left), voiceTimestamp(right)) ? left : right;
  }
  return preferLeft ? left : right;
}

function bookKey(book: CloudVaultBookV1): string {
  return book.identity.normalizedTextHash;
}

function mergeBook(left: CloudVaultBookV1, right: CloudVaultBookV1): CloudVaultBookV1 {
  const metadataFromLeft = newer(left.revisions.metadataAt, right.revisions.metadataAt);
  const aiFromLeft = newer(left.revisions.aiTtsAt, right.revisions.aiTtsAt);
  const leftPosition = left.readingPosition;
  const rightPosition = right.readingPosition;
  const readingPosition = !leftPosition
    ? rightPosition
    : !rightPosition || newer(leftPosition.updatedAt, rightPosition.updatedAt)
      ? leftPosition
      : rightPosition;
  return {
    identity: metadataFromLeft ? left.identity : right.identity,
    revisions: {
      metadataAt: metadataFromLeft ? left.revisions.metadataAt : right.revisions.metadataAt,
      readerAt: newer(left.revisions.readerAt, right.revisions.readerAt)
        ? left.revisions.readerAt
        : right.revisions.readerAt,
      annotationsAt: newer(left.revisions.annotationsAt, right.revisions.annotationsAt)
        ? left.revisions.annotationsAt
        : right.revisions.annotationsAt,
      statisticsAt: newer(left.revisions.statisticsAt, right.revisions.statisticsAt)
        ? left.revisions.statisticsAt
        : right.revisions.statisticsAt,
      aiTtsAt: aiFromLeft ? left.revisions.aiTtsAt : right.revisions.aiTtsAt,
    },
    // Keep anchor references from every device. The same source can have
    // different local ids when it was imported under a different filename.
    chapters: mergeById(left.chapters, right.chapters, (item) => item),
    paragraphs: mergeById(left.paragraphs, right.paragraphs, (item) => item),
    readingPosition,
    bookmarks: mergeById(left.bookmarks, right.bookmarks, chooseBookmark),
    highlights: mergeById(left.highlights, right.highlights, chooseHighlight),
    notes: mergeById(left.notes, right.notes, chooseNote),
    documentAnnotations: mergeById(
      left.documentAnnotations ?? [],
      right.documentAnnotations ?? [],
      chooseDocumentAnnotation,
    ),
    documentTextOrderOverrides: mergeById(
      left.documentTextOrderOverrides ?? [],
      right.documentTextOrderOverrides ?? [],
      chooseDocumentTextOrderOverride,
    ),
    readingSessions: mergeById(left.readingSessions, right.readingSessions, chooseSession),
    characters: mergeById(left.characters, right.characters, (a, b) => chooseCharacter(a, b, aiFromLeft)),
    characterRelations: mergeById(left.characterRelations, right.characterRelations, (a, b) => (aiFromLeft ? a : b)),
    segments: mergeById(left.segments, right.segments, (a, b) => chooseSegment(a, b, aiFromLeft)),
    voiceProfiles: mergeById(left.voiceProfiles, right.voiceProfiles, (a, b) => chooseVoice(a, b, aiFromLeft)),
    corrections: mergeById(left.corrections, right.corrections, chooseCorrection),
  };
}

function tombstoneWins(entityTimestamp: string | undefined, tombstone: CloudVaultTombstoneV1): boolean {
  return !entityTimestamp || tombstone.deletedAt >= entityTimestamp;
}

function applyBookTombstones(book: CloudVaultBookV1, tombstones: readonly CloudVaultTombstoneV1[]): CloudVaultBookV1 {
  const relevant = tombstones.filter((item) => item.bookHash === book.identity.normalizedTextHash);
  const byEntity = new Map(relevant.map((item) => [`${item.entityType}:${item.entityId}`, item]));
  return {
    ...book,
    readingPosition: (() => {
      const position = book.readingPosition;
      if (!position) return undefined;
      const tombstone = byEntity.get(`reading_position:${position.id}`);
      return tombstone && tombstoneWins(position.updatedAt, tombstone) ? undefined : position;
    })(),
    bookmarks: book.bookmarks.filter((item) => {
      const tombstone = byEntity.get(`bookmark:${item.id}`);
      return !tombstone || !tombstoneWins(item.createdAt, tombstone);
    }),
    highlights: book.highlights.filter((item) => {
      const tombstone = byEntity.get(`highlight:${item.id}`);
      return !tombstone || !tombstoneWins(item.updatedAt, tombstone);
    }),
    notes: book.notes.filter((item) => {
      const tombstone = byEntity.get(`note:${item.id}`);
      return !tombstone || !tombstoneWins(item.updatedAt, tombstone);
    }),
    documentAnnotations: (book.documentAnnotations ?? []).filter((item) => {
      const tombstone = byEntity.get(`document_annotation:${item.id}`);
      return !tombstone || !tombstoneWins(item.deletedAt ?? item.updatedAt, tombstone);
    }),
    documentTextOrderOverrides: (book.documentTextOrderOverrides ?? []).filter((item) => {
      const tombstone = byEntity.get(`document_text_order_override:${item.id}`);
      return !tombstone || !tombstoneWins(item.updatedAt, tombstone);
    }),
    corrections: book.corrections.filter((item) => {
      const tombstone = byEntity.get(`user_correction:${item.id}`);
      return !tombstone || !tombstoneWins(item.createdAt, tombstone);
    }),
  };
}

export function mergeCloudVaultSnapshots(
  local: CloudVaultSnapshotV1,
  remote: CloudVaultSnapshotV1 | undefined,
  generatedAt = new Date().toISOString(),
): CloudVaultSnapshotV1 {
  if (!remote) return { ...local, generatedAt };
  const books = new Map(remote.books.map((book) => [bookKey(book), book]));
  for (const book of local.books) {
    const existing = books.get(bookKey(book));
    books.set(bookKey(book), existing ? mergeBook(book, existing) : book);
  }
  const tombstones = mergeById(local.tombstones, remote.tombstones, chooseTombstone);
  const shelfTombstones = new Map(
    tombstones.filter((item) => item.entityType === 'shelf').map((item) => [item.entityId, item]),
  );
  const membershipTombstones = new Map(
    tombstones.filter((item) => item.entityType === 'shelf_membership').map((item) => [item.entityId, item]),
  );
  const settingsFromLocal = newer(local.settingsUpdatedAt, remote.settingsUpdatedAt);
  return {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    generatedAt,
    deviceId: local.deviceId,
    // The current device's selection is authoritative. Remote payloads stay in
    // the encrypted file, but a previously enabled category must not silently
    // turn itself back on after the user disables it locally.
    scope: { ...local.scope, ttsAudio: false },
    books: [...books.values()]
      .map((book) => applyBookTombstones(book, tombstones))
      .sort((a, b) => bookKey(a).localeCompare(bookKey(b))),
    shelves: mergeById(local.shelves, remote.shelves, chooseShelf).filter((shelf) => {
      const tombstone = shelfTombstones.get(shelf.id);
      return !tombstone || !tombstoneWins(shelf.updatedAt, tombstone);
    }),
    shelfMemberships: mergeById(local.shelfMemberships, remote.shelfMemberships, (left) => left).filter(
      (membership) => !membershipTombstones.has(membership.id),
    ),
    tombstones,
    settings: settingsFromLocal ? local.settings : remote.settings,
    settingsUpdatedAt: settingsFromLocal ? local.settingsUpdatedAt : remote.settingsUpdatedAt,
  };
}
