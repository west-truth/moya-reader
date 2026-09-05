import type { SyncRepository } from '../repositories/reader-repository';
import type { SyncEventType, SyncOutboxItem } from './types';

const QUEUED_STATUSES = ['pending', 'sending', 'failed'] as const;
export const SYNC_OUTBOX_PREVIEW_LIMIT = 100;
const PROVIDER_METADATA_EVENT_TYPES: readonly SyncEventType[] = [
  'voice_profiles_updated',
  'user_correction_created',
  'user_correction_deleted',
  'character_graph_updated',
  'chapter_segments_updated',
];

export interface SyncOutboxDetails {
  items: SyncOutboxItem[];
  truncated: boolean;
}

/** Only an explicit detail request reads the complete unsent queue. Sent history is never needed by this UI. */
export async function loadSyncOutboxDetails(
  repository: Pick<SyncRepository, 'listSyncOutbox'>,
  complete = false,
): Promise<SyncOutboxDetails> {
  const limit = SYNC_OUTBOX_PREVIEW_LIMIT;
  const batches = await Promise.all(
    QUEUED_STATUSES.map((status) => repository.listSyncOutbox(status, complete ? undefined : { limit: limit + 1 })),
  );
  return {
    items: batches
      .flatMap((items) => (complete ? items : items.slice(0, limit)))
      .sort((a, b) => a.localSequence - b.localSequence),
    truncated: !complete && batches.some((items) => items.length > limit),
  };
}

/** Overflow is unknown, so defer prefetch/sync before playback rather than scan every queued position. */
export async function mayHaveQueuedProviderMetadata(
  repository: Pick<SyncRepository, 'listSyncOutbox'>,
): Promise<boolean> {
  for (const status of QUEUED_STATUSES) {
    const items = await repository.listSyncOutbox(status, { limit: SYNC_OUTBOX_PREVIEW_LIMIT + 1 });
    if (
      items.length > SYNC_OUTBOX_PREVIEW_LIMIT ||
      items.some((item) => PROVIDER_METADATA_EVENT_TYPES.includes(item.event.type))
    )
      return true;
  }
  return false;
}
