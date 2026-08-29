import {
  applyRemoteSyncEvents,
  cacheRemoteBookSnapshot,
  cacheRemoteBookSnapshotStream,
  getSyncState,
  listSyncOutbox,
  openReaderDb,
  saveSyncState,
  updateSyncOutboxItems,
} from '../storage/db';
import type { BookAssetMetadata } from '../domain/types';
import { cacheRemoteBookCover, clearCachedRemoteBookCover, getActiveBookCover } from '../storage/book-asset-store';
import {
  claimSyncOutboxBatchInDatabase,
  recoverStaleSendingOutboxInDatabase,
  releaseClaimedSyncOutboxItemsInDatabase,
  settleClaimedSyncOutboxItemsInDatabase,
  settleUnclaimedSyncOutboxItemsInDatabase,
} from '../storage/sync-outbox-store';
import { SYNC_CONTRACT_V2 } from './contract';
import { translateLocalPulledEventsToV2, translateLocalSyncEventsToV1 } from './local-sync-contract-translation';
import { applyRemoteVoiceCastingSyncEvents } from './voice-casting-sync-apply';
import type {
  JsonValue,
  NegotiatedSyncContract,
  PullSyncResult,
  PushSyncResult,
  RejectedSyncEvent,
  RemoteBookSnapshot,
  RemoteBookSnapshotStream,
  SyncEvent,
  SyncOutboxItem,
  ResolvedSyncContract,
  SyncState,
} from './types';

export interface SyncEventSource {
  negotiateSyncContract?(): Promise<NegotiatedSyncContract>;
  pushSync(events: SyncEvent[], contract?: ResolvedSyncContract): Promise<PushSyncResult>;
  pullSync(since?: number, contract?: ResolvedSyncContract): Promise<PullSyncResult>;
  getBookSnapshotStream?(bookId: string): Promise<RemoteBookSnapshotStream | undefined>;
  getBookSnapshot?(bookId: string): Promise<RemoteBookSnapshot | undefined>;
  getBookCoverMetadata?(bookId: string): Promise<{ cover: Record<string, unknown> }>;
  getBookCover?(bookId: string): Promise<{ blob: Blob; headers: Headers }>;
  saveBookCover?(
    bookId: string,
    cover: Blob,
    metadata: {
      fileName: string;
      contentType: string;
      contentHash: string;
      pixelWidth: number;
      pixelHeight: number;
      fit: 'crop' | 'contain';
      positionX: number;
      positionY: number;
      provenance?: 'user_supplied' | 'approved_enrichment' | 'generated_preview';
    },
  ): Promise<unknown>;
  removeBookCover?(bookId: string): Promise<unknown>;
}

export interface LocalOutboxSyncServiceOptions {
  now?: () => Date;
  createLeaseToken?: () => string;
  leaseDurationMs?: number;
}

interface ActiveClaim {
  leaseToken: string;
  items: SyncOutboxItem[];
}

interface PushApplicationResult {
  ownershipLost: boolean;
  conflictState?: SyncState;
}

function objectValue(value: JsonValue | unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function fieldText(row: Record<string, unknown>, camel: string, snake = camel): string | undefined {
  const value = row[camel] ?? row[snake];
  return typeof value === 'string' && value ? value : undefined;
}

function remoteCoverMetadata(bookId: string, row: Record<string, unknown>): BookAssetMetadata {
  const id = fieldText(row, 'id');
  const contentHash = fieldText(row, 'contentHash', 'content_hash');
  const remoteProvenance = fieldText(row, 'provenance');
  if (!id || !contentHash) throw new Error('remote cover metadata is incomplete');
  return {
    id,
    bookId,
    kind: 'cover',
    provenance:
      remoteProvenance === 'approved_enrichment' || remoteProvenance === 'generated_preview'
        ? remoteProvenance
        : 'user_supplied',
    status: 'active',
    storageKey: fieldText(row, 'storageKey', 'storage_key') ?? id,
    fileName: fieldText(row, 'fileName', 'file_name'),
    contentType: fieldText(row, 'contentType', 'content_type') ?? 'image/jpeg',
    byteLength: Number(row.byteLength ?? row.byte_length) || 0,
    contentHash,
    pixelWidth: Number(row.pixelWidth ?? row.pixel_width) || undefined,
    pixelHeight: Number(row.pixelHeight ?? row.pixel_height) || undefined,
    createdAt: fieldText(row, 'createdAt', 'created_at') ?? new Date(0).toISOString(),
    activatedAt: fieldText(row, 'activatedAt', 'activated_at'),
  };
}

const compactableEventTypes = new Set<SyncEvent['type']>([
  'book_updated',
  'reading_position_updated',
  'settings_updated',
  'voice_profiles_updated',
  'voice_casting_updated',
  'character_graph_updated',
  'chapter_segments_updated',
]);
const terminalRejectionReasons = new Set<RejectedSyncEvent['reason']>([
  'duplicate',
  'already_applied',
  'already-applied',
]);
const preAttachBookMissingMessage = 'server book does not exist yet';
const DEFAULT_LEASE_DURATION_MS = 2 * 60 * 1000;

function defaultLeaseToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `sync-lease-${globalThis.crypto.randomUUID()}`;
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return `sync-lease-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  return `sync-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class LocalOutboxSyncService {
  private activeFlushPromise?: Promise<SyncState>;
  private readonly now: () => Date;
  private readonly createLeaseToken: () => string;
  private readonly leaseDurationMs: number;

  constructor(
    private readonly client: SyncEventSource,
    options: LocalOutboxSyncServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createLeaseToken = options.createLeaseToken ?? defaultLeaseToken;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (!Number.isFinite(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive number');
    }
  }

  private startSingleFlight(operation: () => Promise<SyncState>): Promise<SyncState> {
    if (this.activeFlushPromise) return this.activeFlushPromise;
    const active = operation();
    this.activeFlushPromise = active;
    const clear = () => {
      if (this.activeFlushPromise === active) this.activeFlushPromise = undefined;
    };
    void active.then(clear, clear);
    return active;
  }

  private currentLeaseWindow(): { now: string; leaseExpiresAt: string } {
    const current = this.now();
    const timestamp = current.getTime();
    if (!Number.isFinite(timestamp)) throw new Error('sync clock returned an invalid date');
    return {
      now: current.toISOString(),
      leaseExpiresAt: new Date(timestamp + this.leaseDurationMs).toISOString(),
    };
  }

  private remoteBookId(event: SyncEvent): string | undefined {
    if (event.type !== 'book_imported') return undefined;
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, JsonValue>)
        : {};
    return event.novelId || (typeof payload.bookId === 'string' ? payload.bookId : undefined) || event.entityId;
  }

  private async cacheImportedBooks(events: SyncEvent[]): Promise<void> {
    if (!this.client.getBookSnapshotStream && !this.client.getBookSnapshot) return;
    const bookIds = Array.from(
      new Set(events.map((event) => this.remoteBookId(event)).filter((bookId): bookId is string => Boolean(bookId))),
    );
    for (const bookId of bookIds) {
      if (this.client.getBookSnapshotStream) {
        const snapshot = await this.client.getBookSnapshotStream(bookId);
        if (snapshot) {
          await cacheRemoteBookSnapshotStream(snapshot);
          continue;
        }
      }
      const snapshot = await this.client.getBookSnapshot?.(bookId);
      if (snapshot) await cacheRemoteBookSnapshot(snapshot);
    }
  }

  private coverMutation(event: SyncEvent): 'replace' | 'remove' | undefined {
    if (event.type !== 'book_updated') return undefined;
    const payload = objectValue(event.payload);
    return payload?.coverMutation === 'replace' || payload?.coverMutation === 'remove'
      ? payload.coverMutation
      : undefined;
  }

  private async syncPushedCoverAssets(claim: ActiveClaim, result: PushSyncResult): Promise<void> {
    if (!this.client.saveBookCover && !this.client.removeBookCover) return;
    const rejectionById = new Map((result.rejected ?? []).map((item) => [item.id, item]));
    for (const item of claim.items) {
      const mutation = this.coverMutation(item.event);
      if (!mutation) continue;
      const rejection = rejectionById.get(item.event.id);
      if (rejection && !this.isTerminalRejection(rejection)) continue;
      const bookId = item.event.novelId ?? item.event.entityId;
      if (!bookId) continue;
      if (mutation === 'remove') {
        await this.client.removeBookCover?.(bookId);
        continue;
      }
      const cover = await getActiveBookCover(bookId);
      if (!cover || !this.client.saveBookCover) throw new Error(`local cover asset is missing for ${bookId}`);
      const payload = objectValue(item.event.payload);
      const novel = objectValue(payload?.novel);
      const contentType = cover.metadata.contentType;
      const pixelWidth = cover.metadata.pixelWidth;
      const pixelHeight = cover.metadata.pixelHeight;
      if (!pixelWidth || !pixelHeight) throw new Error(`local cover dimensions are missing for ${bookId}`);
      await this.client.saveBookCover(bookId, cover.blob, {
        fileName: cover.metadata.fileName ?? 'cover',
        contentType,
        contentHash: cover.metadata.contentHash,
        pixelWidth,
        pixelHeight,
        fit: novel?.coverFit === 'contain' ? 'contain' : 'crop',
        positionX: Number(novel?.coverPositionX) || 50,
        positionY: Number(novel?.coverPositionY) || 50,
        provenance:
          cover.metadata.provenance === 'approved_enrichment' || cover.metadata.provenance === 'generated_preview'
            ? cover.metadata.provenance
            : 'user_supplied',
      });
    }
  }

  private async cachePulledCoverAssets(events: SyncEvent[]): Promise<void> {
    if (!this.client.getBookCover || !this.client.getBookCoverMetadata) return;
    const latestByBook = new Map<string, { coverAssetId: string | null }>();
    for (const event of events) {
      if (event.type !== 'book_updated') continue;
      const payload = objectValue(event.payload);
      const novel = objectValue(payload?.novel);
      if (!novel || !Object.prototype.hasOwnProperty.call(novel, 'coverAssetId')) continue;
      const bookId = event.novelId ?? event.entityId ?? fieldText(novel, 'id');
      if (!bookId) continue;
      latestByBook.set(bookId, {
        coverAssetId: typeof novel.coverAssetId === 'string' ? novel.coverAssetId : null,
      });
    }
    for (const [bookId, change] of latestByBook) {
      if (!change.coverAssetId) {
        await clearCachedRemoteBookCover(bookId);
        continue;
      }
      const [metadata, download] = await Promise.all([
        this.client.getBookCoverMetadata(bookId),
        this.client.getBookCover(bookId),
      ]);
      await cacheRemoteBookCover(remoteCoverMetadata(bookId, metadata.cover), download.blob);
    }
  }

  private syncFailureStatus(error: unknown): SyncState['status'] {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    if (status === 409) return 'conflict';
    if (status === 0 || error instanceof TypeError) return 'offline';
    return 'failed';
  }

  private rejectionMessage(rejected: RejectedSyncEvent[]): string {
    const first = rejected[0];
    const suffix = first?.message ?? first?.reason ?? 'rejected';
    return `Server rejected ${rejected.length} sync event${rejected.length === 1 ? '' : 's'}: ${suffix}`;
  }

  private isTerminalRejection(rejected: RejectedSyncEvent): boolean {
    return terminalRejectionReasons.has(rejected.reason);
  }

  private async applyPushResult(claim: ActiveClaim, result: PushSyncResult): Promise<PushApplicationResult> {
    const itemByEventId = new Map(claim.items.map((item) => [item.event.id, item]));
    const relevantRejections = (result.rejected ?? []).filter((rejected) => itemByEventId.has(rejected.id));
    const conflictRejections = relevantRejections.filter((rejected) => !this.isTerminalRejection(rejected));
    const conflictByEventId = new Map(conflictRejections.map((rejected) => [rejected.id, rejected]));
    const message = conflictRejections.length ? this.rejectionMessage(conflictRejections) : undefined;
    const window = this.currentLeaseWindow();
    const settled = await settleClaimedSyncOutboxItemsInDatabase(
      await openReaderDb(),
      claim.leaseToken,
      claim.items.map((item) => ({
        id: item.id,
        status: conflictByEventId.has(item.event.id) ? ('failed' as const) : ('sent' as const),
        lastError: conflictByEventId.has(item.event.id) ? message : undefined,
      })),
      window.now,
    );
    if (settled.updatedIds.length !== claim.items.length) return { ownershipLost: true };
    if (!message) return { ownershipLost: false };
    return {
      ownershipLost: false,
      conflictState: await saveSyncState({
        mode: 'connected',
        status: 'conflict',
        lastError: message,
      }),
    };
  }

  private compactableKey(item: SyncOutboxItem): string | undefined {
    const payload =
      item.event.payload && typeof item.event.payload === 'object' && !Array.isArray(item.event.payload)
        ? (item.event.payload as Record<string, JsonValue>)
        : undefined;
    if (typeof payload?.compoundOperationId === 'string') return undefined;
    const revision = item.event.revision;
    if (!revision || !compactableEventTypes.has(item.event.type)) return undefined;
    return `${item.event.type}:${revision.entityType}:${revision.novelId ?? ''}:${revision.entityId}`;
  }

  private compactSupersededItems(items: SyncOutboxItem[]): { compactedIds: string[]; remaining: SyncOutboxItem[] } {
    const latestByKey = new Map<string, SyncOutboxItem>();
    for (const item of items) {
      const key = this.compactableKey(item);
      if (!key) continue;
      const current = latestByKey.get(key);
      if (!current || item.localSequence > current.localSequence) latestByKey.set(key, item);
    }

    const compactedIds = items
      .filter((item) => {
        const key = this.compactableKey(item);
        return key ? latestByKey.get(key)?.id !== item.id : false;
      })
      .map((item) => item.id);
    const compacted = new Set(compactedIds);
    return {
      compactedIds,
      remaining: items.filter((item) => !compacted.has(item.id)),
    };
  }

  private isPreAttachBookMissingItem(item: SyncOutboxItem): boolean {
    return item.status === 'failed' && Boolean(item.lastError?.includes(preAttachBookMissingMessage));
  }

  private async queuedItems(): Promise<SyncOutboxItem[]> {
    const pending = await listSyncOutbox('pending');
    const failed = await listSyncOutbox('failed');
    const queuedItems = [...pending, ...failed].sort((a, b) => a.localSequence - b.localSequence);
    const { compactedIds, remaining } = this.compactSupersededItems(queuedItems);
    await settleUnclaimedSyncOutboxItemsInDatabase(
      await openReaderDb(),
      compactedIds,
      'sent',
      this.currentLeaseWindow().now,
    );
    return remaining;
  }

  private async negotiatedContract(): Promise<NegotiatedSyncContract> {
    return this.client.negotiateSyncContract?.() ?? { descriptor: SYNC_CONTRACT_V2, legacyServer: false };
  }

  private async pushEvents(events: SyncEvent[], negotiation: NegotiatedSyncContract): Promise<PushSyncResult> {
    if (negotiation.descriptor.contractVersion !== 1) {
      return this.client.pushSync(events, negotiation.descriptor);
    }
    const translated = await translateLocalSyncEventsToV1(events);
    const result = await this.client.pushSync(translated.events, negotiation.descriptor);
    const originalId = (id: string) => translated.originalEventIdByTranslatedId.get(id) ?? id;
    return {
      ...result,
      acceptedIds: result.acceptedIds?.map(originalId),
      rejected: result.rejected?.map((rejected) => ({ ...rejected, id: originalId(rejected.id) })),
    };
  }

  private async pullRemoteUpdates(negotiation: NegotiatedSyncContract): Promise<PullSyncResult> {
    const current = await getSyncState();
    const pulled = await this.client.pullSync(current.lastRemoteCursor ?? 0, negotiation.descriptor);
    const events =
      negotiation.descriptor.contractVersion === 1
        ? await translateLocalPulledEventsToV2(pulled.events)
        : pulled.events;
    await this.cacheImportedBooks(events);
    await this.cachePulledCoverAssets(events);
    await applyRemoteSyncEvents(events);
    await applyRemoteVoiceCastingSyncEvents(events);
    await saveSyncState({
      mode: 'connected',
      status: 'syncing',
      lastRemoteCursor: pulled.cursor,
      lastError: undefined,
    });
    return { ...pulled, events };
  }

  private async runFlushPending(): Promise<SyncState> {
    let activeClaim: ActiveClaim | undefined;

    try {
      await saveSyncState({ mode: 'connected', status: 'syncing', lastError: undefined });
      const negotiation = await this.negotiatedContract();
      await recoverStaleSendingOutboxInDatabase(await openReaderDb(), this.currentLeaseWindow().now);
      let items = await this.queuedItems();

      if (items.some((item) => this.isPreAttachBookMissingItem(item))) {
        await this.pullRemoteUpdates(negotiation);
        items = await this.queuedItems();
      }

      if (!items.length && (await listSyncOutbox('sending')).length) return getSyncState();

      if (items.length) {
        const leaseToken = this.createLeaseToken();
        const leaseWindow = this.currentLeaseWindow();
        const claimedItems = await claimSyncOutboxBatchInDatabase(await openReaderDb(), {
          leaseToken,
          now: leaseWindow.now,
          leaseExpiresAt: leaseWindow.leaseExpiresAt,
          candidateIds: items.map((item) => item.id),
        });
        if (!claimedItems.length) return getSyncState();

        activeClaim = { leaseToken, items: claimedItems };
        const pushResult = await this.pushEvents(
          claimedItems.map((item) => item.event),
          negotiation,
        );
        await this.syncPushedCoverAssets(activeClaim, pushResult);
        const application = await this.applyPushResult(activeClaim, pushResult);
        activeClaim = undefined;
        if (application.ownershipLost) return getSyncState();
        if (application.conflictState) return application.conflictState;
      }

      const pulled = await this.pullRemoteUpdates(negotiation);
      return saveSyncState({
        mode: 'connected',
        status: 'idle',
        lastRemoteCursor: pulled.cursor,
        lastSyncedAt: this.currentLeaseWindow().now,
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeClaim) {
        const released = await releaseClaimedSyncOutboxItemsInDatabase(
          await openReaderDb(),
          activeClaim.leaseToken,
          activeClaim.items.map((item) => item.id),
          'failed',
          this.currentLeaseWindow().now,
          message,
        );
        if (!released.updatedIds.length) return getSyncState();
      }
      return saveSyncState({
        mode: 'connected',
        status: this.syncFailureStatus(error),
        lastError: message,
      });
    }
  }

  flushPending(): Promise<SyncState> {
    return this.startSingleFlight(() => this.runFlushPending());
  }

  private async runAcceptRemoteState(): Promise<SyncState> {
    try {
      await saveSyncState({ mode: 'connected', status: 'syncing', lastError: undefined });
      const negotiation = await this.negotiatedContract();
      const queued = (await listSyncOutbox()).filter((item) => item.status !== 'sent');
      const current = await getSyncState();
      const pulled = await this.client.pullSync(current.lastRemoteCursor ?? 0, negotiation.descriptor);
      const events =
        negotiation.descriptor.contractVersion === 1
          ? await translateLocalPulledEventsToV2(pulled.events)
          : pulled.events;
      await this.cacheImportedBooks(events);
      await this.cachePulledCoverAssets(events);
      await applyRemoteSyncEvents(events);
      await applyRemoteVoiceCastingSyncEvents(events);
      await updateSyncOutboxItems(
        queued.map((item) => item.id),
        'sent',
      );
      return saveSyncState({
        mode: 'connected',
        status: 'idle',
        lastRemoteCursor: pulled.cursor,
        lastSyncedAt: this.currentLeaseWindow().now,
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return saveSyncState({
        mode: 'connected',
        status: this.syncFailureStatus(error),
        lastError: message,
      });
    }
  }

  acceptRemoteState(): Promise<SyncState> {
    return this.startSingleFlight(() => this.runAcceptRemoteState());
  }
}
