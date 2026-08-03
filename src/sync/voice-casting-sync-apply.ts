import {
  assertVoiceCastingWorkspace,
  createEmptyVoiceCastingWorkspace,
  normalizeVoiceCastingWorkspace,
  type VoiceCastingWorkspaceV1,
} from '../providers/voice-casting';
import { requestToPromise, transactionDone } from '../storage/indexeddb-transaction';
import { openReaderDb } from '../storage/reader-database';
import { VOICE_CASTING_STORES } from '../storage/voice-casting-schema';
import type { SyncEvent } from './types';
import { parseVoiceCastingUpdatedPayload } from './voice-casting-event';

interface StoredVoiceCastingWorkspace {
  readonly id: string;
  readonly novelId: string;
  readonly contentRevisionId: string;
  readonly storageRevision: number;
  readonly workspace: VoiceCastingWorkspaceV1;
}

function sameUserArtifacts(left: VoiceCastingWorkspaceV1, right: unknown): boolean {
  return JSON.stringify(left.userArtifacts) === JSON.stringify(right);
}

export async function applyRemoteVoiceCastingSyncEvents(events: readonly SyncEvent[]): Promise<void> {
  const updates = events.filter((event) => event.type === 'voice_casting_updated');
  if (updates.length === 0) return;

  const db = await openReaderDb();
  const tx = db.transaction(VOICE_CASTING_STORES.states, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(VOICE_CASTING_STORES.states);
  for (const event of updates) {
    if (!event.novelId) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error('Remote voice casting event is missing a book id');
    }
    const payload = parseVoiceCastingUpdatedPayload(event.payload, event.novelId);
    if (!payload) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error('Remote voice casting event payload is invalid');
    }
    const current = await requestToPromise<StoredVoiceCastingWorkspace | undefined>(
      store.index('novelId').get(event.novelId),
    );
    if (current) assertVoiceCastingWorkspace(current.workspace);
    if (
      current?.contentRevisionId === payload.contentRevisionId &&
      sameUserArtifacts(current.workspace, payload.userArtifacts)
    ) {
      continue;
    }

    const storageRevision = (current?.storageRevision ?? 0) + 1;
    const empty = createEmptyVoiceCastingWorkspace({
      bookId: event.novelId,
      contentRevisionId: payload.contentRevisionId,
      storageRevision,
    });
    const workspace = normalizeVoiceCastingWorkspace({
      bookId: event.novelId,
      contentRevisionId: payload.contentRevisionId,
      storageRevision,
      userArtifacts: payload.userArtifacts,
      derivedArtifacts:
        current?.contentRevisionId === payload.contentRevisionId
          ? current.workspace.derivedArtifacts
          : empty.derivedArtifacts,
      status: 'stale',
    });
    store.put({
      id: `voice_casting_state_${event.novelId}`,
      novelId: event.novelId,
      contentRevisionId: payload.contentRevisionId,
      storageRevision,
      workspace,
    } satisfies StoredVoiceCastingWorkspace);
  }
  await done;
}
