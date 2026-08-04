import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyVoiceCastingWorkspace } from '../providers/voice-casting';
import { resetReaderDbForTests } from '../storage/reader-database';
import { listSyncOutbox } from '../storage/sync-event-store';
import { getVoiceCastingWorkspace, saveVoiceCastingWorkspace } from '../storage/voice-casting-store';
import type { SyncEvent } from './types';
import { applyRemoteVoiceCastingSyncEvents } from './voice-casting-sync-apply';

const bookId = 'book_1';
const contentRevisionId = 'content_revision_1';

function remoteEvent(voiceProfileIds: string[]): SyncEvent {
  return {
    id: 'event_remote_voice_casting',
    type: 'voice_casting_updated',
    deviceId: 'device_remote',
    novelId: bookId,
    entityId: 'voice_casting_book_1',
    payload: {
      version: 'voice-casting-v1',
      contentRevisionId,
      storageRevision: 7,
      userArtifacts: {
        voiceProfileIds,
        pools: [],
        overrides: [],
        traitEvidence: [],
      },
    },
    createdAt: '2026-07-13T01:00:00.000Z',
  };
}

describe('voice casting remote sync projection', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('replaces only user artifacts, marks local derived state stale, and does not enqueue an echo', async () => {
    const local = createEmptyVoiceCastingWorkspace({ bookId, contentRevisionId, storageRevision: 1 });
    await saveVoiceCastingWorkspace({ workspace: local, expectedStorageRevision: 0 });

    await applyRemoteVoiceCastingSyncEvents([remoteEvent(['voice_remote_1'])]);

    const stored = await getVoiceCastingWorkspace(bookId);
    expect(stored).toMatchObject({
      bookId,
      contentRevisionId,
      storageRevision: 2,
      status: 'stale',
      userArtifacts: {
        voiceProfileIds: ['voice_remote_1'],
        pools: [],
        overrides: [],
        traitEvidence: [],
      },
    });
    expect(stored?.derivedArtifacts).toEqual(local.derivedArtifacts);
    expect(await listSyncOutbox('pending')).toHaveLength(1);
  });

  it('ignores a pulled echo of the already-persisted user projection', async () => {
    const local = createEmptyVoiceCastingWorkspace({ bookId, contentRevisionId, storageRevision: 1 });
    await saveVoiceCastingWorkspace({ workspace: local, expectedStorageRevision: 0 });

    await applyRemoteVoiceCastingSyncEvents([remoteEvent([])]);

    expect(await getVoiceCastingWorkspace(bookId)).toEqual(local);
    expect(await listSyncOutbox('pending')).toHaveLength(1);
  });
});
