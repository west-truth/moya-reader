import type { LabeledSegment } from '../domain/types';
import {
  projectAcceptedSpeakerUtterance,
  assertVoiceCastingWorkspace,
  type AcceptedSpeakerUtteranceV1,
  type VoiceCastingWorkspaceV1,
} from '../providers/voice-casting';
import type { AcceptedSpeakerProvenanceV1 } from '../providers/speaker-attribution/accepted-speaker-provenance';
import { voiceCastingUpdatedPayload } from '../sync/voice-casting-event';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { SPEAKER_WORKFLOW_STORES } from './speaker-workflow-schema';
import { queueSyncEventInTransaction } from './sync-event-store';
import { VOICE_CASTING_STORES } from './voice-casting-schema';

interface StoredVoiceCastingWorkspace {
  readonly id: string;
  readonly novelId: string;
  readonly contentRevisionId: string;
  readonly storageRevision: number;
  readonly workspace: VoiceCastingWorkspaceV1;
}

export class VoiceCastingRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(`Voice casting revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'VoiceCastingRevisionConflictError';
  }
}

function assertWorkspaceScope(workspace: VoiceCastingWorkspaceV1): void {
  assertVoiceCastingWorkspace(workspace);
  if (!Number.isSafeInteger(workspace.storageRevision) || workspace.storageRevision < 1) {
    throw new Error('Voice casting workspace storage revision must be a positive safe integer');
  }
}

export async function getVoiceCastingWorkspace(novelId: string): Promise<VoiceCastingWorkspaceV1 | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(VOICE_CASTING_STORES.states, 'readonly');
  const row = await requestToPromise<StoredVoiceCastingWorkspace | undefined>(
    tx.objectStore(VOICE_CASTING_STORES.states).index('novelId').get(novelId),
  );
  await transactionDone(tx);
  if (!row) return undefined;
  assertVoiceCastingWorkspace(row.workspace);
  return row.workspace;
}

export async function saveVoiceCastingWorkspace(input: {
  readonly workspace: VoiceCastingWorkspaceV1;
  readonly expectedStorageRevision: number;
}): Promise<void> {
  assertWorkspaceScope(input.workspace);
  if (!Number.isSafeInteger(input.expectedStorageRevision) || input.expectedStorageRevision < 0) {
    throw new Error('Expected voice casting storage revision must be a nonnegative safe integer');
  }
  if (input.workspace.storageRevision !== input.expectedStorageRevision + 1) {
    throw new Error('Voice casting workspace must advance storage revision exactly once');
  }

  const db = await openReaderDb();
  const tx = db.transaction([VOICE_CASTING_STORES.states, 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(VOICE_CASTING_STORES.states);
  const current = await requestToPromise<StoredVoiceCastingWorkspace | undefined>(
    store.index('novelId').get(input.workspace.bookId),
  );
  const actualRevision = current?.storageRevision ?? 0;
  if (actualRevision !== input.expectedStorageRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new VoiceCastingRevisionConflictError(input.expectedStorageRevision, actualRevision);
  }
  store.put({
    id: `voice_casting_state_${input.workspace.bookId}`,
    novelId: input.workspace.bookId,
    contentRevisionId: input.workspace.contentRevisionId,
    storageRevision: input.workspace.storageRevision,
    workspace: input.workspace,
  } satisfies StoredVoiceCastingWorkspace);
  await queueSyncEventInTransaction(tx, 'voice_casting_updated', voiceCastingUpdatedPayload(input.workspace), {
    novelId: input.workspace.bookId,
    entityId: `voice_casting_${input.workspace.bookId}`,
  });
  await done;
}

export async function listAcceptedSpeakerUtterances(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId?: string;
}): Promise<AcceptedSpeakerUtteranceV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction([SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance, 'segments'], 'readonly');
  const done = transactionDone(tx);
  const [provenanceRows, segments] = await Promise.all([
    requestToPromise<AcceptedSpeakerProvenanceV1[]>(
      tx
        .objectStore(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance)
        .index('contentRevisionId')
        .getAll(input.contentRevisionId),
    ),
    requestToPromise<LabeledSegment[]>(tx.objectStore('segments').index('novelId').getAll(input.bookId)),
  ]);
  await done;

  const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));
  return provenanceRows
    .filter(
      (row) =>
        row.status === 'active' &&
        row.bookId === input.bookId &&
        (input.chapterId === undefined || row.chapterId === input.chapterId),
    )
    .map((provenance) => {
      const segment = segmentById.get(provenance.segmentId);
      if (
        !segment ||
        segment.novelId !== input.bookId ||
        segment.chapterId !== provenance.chapterId ||
        segment.paragraphId !== provenance.paragraphId
      ) {
        throw new Error(`Accepted speaker provenance ${provenance.id} has no matching labeled segment`);
      }
      return projectAcceptedSpeakerUtterance({
        provenance,
        sourceStartOffset: segment.startOffset,
        sourceEndOffset: segment.endOffset,
        spokenCharacterCount: segment.endOffset - segment.startOffset,
      });
    })
    .sort((left, right) => left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id));
}
