import type { Chapter, ListeningPosition, Novel, ParagraphPage, ReadingPosition } from './domain';

export type { ReadingPosition } from './domain';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SyncMode = 'local_only' | 'connected';

export type SyncStatus = 'local_only' | 'offline' | 'idle' | 'syncing' | 'failed' | 'conflict';

export type SyncContractVersion = 1 | 2;

export type SyncIdContract = 'v1-legacy' | 'v2-sha256-128';

export type SyncHashContract = 'v1-legacy' | 'v2-sha256-tagged';

export interface SyncContractFields {
  contractVersion?: SyncContractVersion;
  idContract?: SyncIdContract;
  hashContract?: SyncHashContract;
}

export interface ResolvedSyncContract {
  contractVersion: SyncContractVersion;
  idContract: SyncIdContract;
  hashContract: SyncHashContract;
}

export interface SyncCapabilities extends ResolvedSyncContract {
  supportedContracts: ResolvedSyncContract[];
  defaultPullContract: ResolvedSyncContract;
}

export interface NegotiatedSyncContract {
  descriptor: ResolvedSyncContract;
  legacyServer: boolean;
}

export type SyncEventType =
  | 'book_imported'
  | 'book_deleted'
  | 'book_trashed'
  | 'book_restored'
  | 'book_purged'
  | 'book_updated'
  | 'shelf_updated'
  | 'shelf_deleted'
  | 'shelf_membership_added'
  | 'shelf_membership_removed'
  | 'reading_position_updated'
  | 'reading_position_deleted'
  | 'listening_position_updated'
  | 'listening_position_deleted'
  | 'bookmark_created'
  | 'bookmark_deleted'
  | 'highlight_created'
  | 'highlight_deleted'
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'document_annotation_updated'
  | 'document_annotation_deleted'
  | 'document_text_order_override_updated'
  | 'document_text_order_override_deleted'
  | 'settings_updated'
  | 'voice_profiles_updated'
  | 'voice_casting_updated'
  | 'user_correction_created'
  | 'user_correction_deleted'
  | 'character_graph_updated'
  | 'chapter_segments_updated';

export interface Device {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface RemoteBookSnapshot {
  novel: Novel;
  chapters: Chapter[];
  paragraphPages: ParagraphPage[];
  readingPosition?: ReadingPosition;
  sourceRevision?: string;
  contentHash?: string;
  expectedChapterCount?: number;
  expectedPageCount?: number;
  expectedParagraphCount?: number;
}

export interface RemoteBookSnapshotStream {
  novel: Novel;
  chapters: Chapter[];
  readingPosition?: ReadingPosition;
  pageBatches: AsyncIterable<ParagraphPage[]>;
  sourceRevision?: string;
  contentHash?: string;
  expectedChapterCount?: number;
  expectedPageCount?: number;
  expectedParagraphCount?: number;
}

export interface SyncEvent extends SyncContractFields {
  sequence?: number;
  id: string;
  type: SyncEventType;
  deviceId: string;
  novelId?: string;
  entityId?: string;
  payload: JsonValue;
  revision?: SyncEntityRevision;
  createdAt: string;
}

export type SyncEntityType =
  | 'book'
  | 'shelf'
  | 'shelf_membership'
  | 'reading_position'
  | 'listening_position'
  | 'bookmark'
  | 'highlight'
  | 'note'
  | 'document_annotation'
  | 'document_text_order_override'
  | 'settings'
  | 'voice_profiles'
  | 'voice_casting'
  | 'user_correction'
  | 'character_graph'
  | 'chapter_segments';

export interface SyncEntityRevision {
  entityType: SyncEntityType;
  entityId: string;
  novelId?: string;
  localSequence: number;
  updatedAt?: string;
  deletedAt?: string;
  payloadHash: string;
}

export interface RejectedSyncEvent {
  id: string;
  reason: 'stale' | 'duplicate' | 'already_applied' | 'already-applied' | 'invalid';
  message?: string;
}

export interface PushSyncResult extends SyncContractFields {
  accepted: number;
  acceptedIds?: string[];
  rejected?: RejectedSyncEvent[];
}

export interface PullSyncResult extends SyncContractFields {
  cursor: number;
  events: SyncEvent[];
}

export interface SyncOutboxItem {
  id: string;
  event: SyncEvent;
  status: 'pending' | 'sending' | 'failed' | 'sent';
  localSequence: number;
  attempts: number;
  attemptCount?: number;
  lastAttemptAt?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncState {
  id: 'sync-state';
  mode: SyncMode;
  status: SyncStatus;
  pendingCount: number;
  nextSequence: number;
  lastRemoteCursor?: number;
  lastSyncedAt?: string;
  lastError?: string;
  updatedAt: string;
}
