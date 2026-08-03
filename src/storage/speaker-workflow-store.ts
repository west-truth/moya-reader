import {
  assertSpeakerArtifactDependency,
  markSpeakerArtifactDependencyStale,
  type SpeakerArtifactDependencyV1,
} from '../providers/speaker-attribution/artifact-dependency';
import {
  assertAcceptedSpeakerProvenance,
  transitionAcceptedSpeakerProvenance,
  type AcceptedSpeakerProvenanceV1,
} from '../providers/speaker-attribution/accepted-speaker-provenance';
import {
  assertNoAmbiguousSpeakerIdentityEdges,
  assertNoAmbiguousSpeakerVoiceIdentities,
  assertSpeakerIdentityEdge,
  assertSpeakerVoiceIdentity,
  type SpeakerIdentityEdgeV1,
  type SpeakerVoiceIdentityV1,
} from '../providers/speaker-attribution/speaker-identity';
import type { SpeakerSequenceDecisionRecordV1 } from '../providers/speaker-attribution/workflow-state';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { SPEAKER_WORKFLOW_STORES } from './speaker-workflow-schema';

type FingerprintedRow = { readonly id: string; readonly fingerprint: string };
type IdentityRow = FingerprintedRow & {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly speakerEntityId: string;
};

function uniqueImmutableRows<T extends FingerprintedRow>(rows: readonly T[], label: string): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const previous = unique.get(row.id);
    if (previous && previous.fingerprint !== row.fingerprint) {
      throw new Error(`${label} ${row.id} has conflicting immutable content in one write`);
    }
    if (!previous) unique.set(row.id, row);
  }
  return [...unique.values()];
}

async function abortWithConflict(tx: IDBTransaction, done: Promise<void>, message: string): Promise<never> {
  tx.abort();
  await done.catch(() => undefined);
  throw new Error(message);
}

function abortTransactionWithConflict(tx: IDBTransaction, message: string): never {
  tx.abort();
  throw new Error(message);
}

async function appendImmutableRowsInTransaction<T extends FingerprintedRow>(
  tx: IDBTransaction,
  storeName: string,
  rows: readonly T[],
  label: string,
): Promise<void> {
  const unique = uniqueImmutableRows(rows, label);
  if (unique.length === 0) return;
  const store = tx.objectStore(storeName);
  const previous = await Promise.all(unique.map((row) => requestToPromise<T | undefined>(store.get(row.id))));
  for (let index = 0; index < unique.length; index += 1) {
    const row = unique[index]!;
    const existing = previous[index];
    if (existing && existing.fingerprint !== row.fingerprint) {
      abortTransactionWithConflict(tx, `${label} ${row.id} conflicts with persisted immutable content`);
    }
    if (!existing) store.add(row);
  }
}

function uniqueDependencyRows(rows: readonly SpeakerArtifactDependencyV1[]): SpeakerArtifactDependencyV1[] {
  const unique = new Map<string, SpeakerArtifactDependencyV1>();
  for (const row of rows) {
    assertSpeakerArtifactDependency(row);
    const previous = unique.get(row.id);
    if (previous && previous.fingerprint !== row.fingerprint) {
      throw new Error(`Speaker artifact dependency ${row.id} has conflicting immutable content in one write`);
    }
    if (!previous) unique.set(row.id, row);
    else if (previous.status === 'active' && row.status === 'stale') {
      unique.set(row.id, markSpeakerArtifactDependencyStale(previous, row.staleReason!));
    }
  }
  return [...unique.values()];
}

export async function mergeSpeakerSequenceDecisionsForChapter(input: {
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly records: readonly SpeakerSequenceDecisionRecordV1[];
}): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.sequenceDecisions, 'readwrite');
  const done = transactionDone(tx);
  try {
    await mergeSpeakerSequenceDecisionsForChapterInTransaction(tx, input);
    await done;
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  }
}

export async function mergeSpeakerSequenceDecisionsForChapterInTransaction(
  tx: IDBTransaction,
  input: {
    readonly contentRevisionId: string;
    readonly chapterId: string;
    readonly records: readonly SpeakerSequenceDecisionRecordV1[];
  },
): Promise<void> {
  if (
    input.records.some(
      (record) => record.contentRevisionId !== input.contentRevisionId || record.chapterId !== input.chapterId,
    )
  ) {
    throw new Error('Speaker sequence merge contains a different revision or chapter');
  }
  await appendImmutableRowsInTransaction(
    tx,
    SPEAKER_WORKFLOW_STORES.sequenceDecisions,
    input.records,
    'Speaker sequence decision',
  );
}

// Compatibility name: sequence decisions are now merged per window and never delete other chapter windows.
export const replaceSpeakerSequenceDecisionsForChapter = mergeSpeakerSequenceDecisionsForChapter;

export async function listSpeakerSequenceDecisions(
  contentRevisionId: string,
  chapterId: string,
): Promise<SpeakerSequenceDecisionRecordV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.sequenceDecisions, 'readonly');
  const done = transactionDone(tx);
  const rows = await requestToPromise<SpeakerSequenceDecisionRecordV1[]>(
    tx
      .objectStore(SPEAKER_WORKFLOW_STORES.sequenceDecisions)
      .index('contentRevisionId_chapterId')
      .getAll([contentRevisionId, chapterId]),
  );
  await done;
  return rows;
}

export async function putSpeakerArtifactDependencies(rows: readonly SpeakerArtifactDependencyV1[]): Promise<void> {
  const unique = uniqueDependencyRows(rows);
  if (unique.length === 0) return;
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.artifactDependencies, 'readwrite');
  const done = transactionDone(tx);
  try {
    await putSpeakerArtifactDependenciesInTransaction(tx, unique);
    await done;
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  }
}

export async function putSpeakerArtifactDependenciesInTransaction(
  tx: IDBTransaction,
  rows: readonly SpeakerArtifactDependencyV1[],
): Promise<void> {
  const unique = uniqueDependencyRows(rows);
  if (unique.length === 0) return;
  const store = tx.objectStore(SPEAKER_WORKFLOW_STORES.artifactDependencies);
  const previous = await Promise.all(
    unique.map((row) => requestToPromise<SpeakerArtifactDependencyV1 | undefined>(store.get(row.id))),
  );
  for (let index = 0; index < unique.length; index += 1) {
    const row = unique[index]!;
    const existing = previous[index];
    if (existing && existing.fingerprint !== row.fingerprint) {
      abortTransactionWithConflict(
        tx,
        `Speaker artifact dependency ${row.id} conflicts with persisted immutable content`,
      );
    }
    if (!existing) {
      store.add(row);
    } else if (existing.status === 'active' && row.status === 'stale') {
      store.put(markSpeakerArtifactDependencyStale(existing, row.staleReason!));
    }
  }
}

export async function markSpeakerArtifactDependenciesStale(input: {
  readonly contentRevisionId: string;
  readonly rowIds: readonly string[];
  readonly staleReason: string;
}): Promise<number> {
  const rowIds = [...new Set(input.rowIds)];
  if (rowIds.length === 0) return 0;
  const reason = input.staleReason.trim();
  if (!reason) throw new Error('A stale speaker artifact dependency requires a reason');
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.artifactDependencies, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(SPEAKER_WORKFLOW_STORES.artifactDependencies);
  const rows = await Promise.all(
    rowIds.map((id) => requestToPromise<SpeakerArtifactDependencyV1 | undefined>(store.get(id))),
  );
  if (rows.some((row) => !row || row.contentRevisionId !== input.contentRevisionId)) {
    return abortWithConflict(tx, done, 'Selected speaker artifact dependency is unavailable in this revision');
  }
  for (const row of rows as SpeakerArtifactDependencyV1[]) {
    if (row.status === 'active') store.put(markSpeakerArtifactDependencyStale(row, reason));
  }
  await done;
  return rows.length;
}

async function appendIdentityRows<T extends IdentityRow>(input: {
  readonly storeName: string;
  readonly rows: readonly T[];
  readonly label: string;
  readonly assertRow: (row: T) => void;
  readonly assertNoAmbiguity: (rows: readonly T[]) => void;
}): Promise<void> {
  input.rows.forEach(input.assertRow);
  const unique = uniqueImmutableRows(input.rows, input.label);
  if (unique.length === 0) return;
  const db = await openReaderDb();
  const tx = db.transaction(input.storeName, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(input.storeName);
  const scopes = [...new Map(unique.map((row) => [`${row.bookId}\u0000${row.speakerEntityId}`, row])).values()];
  const existingByScope = await Promise.all(
    scopes.map((row) =>
      requestToPromise<T[]>(store.index('bookId_speakerEntityId').getAll([row.bookId, row.speakerEntityId])),
    ),
  );
  const existing = [...new Map(existingByScope.flat().map((row) => [row.id, row] as const)).values()];
  existing.forEach(input.assertRow);
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  for (const row of unique) {
    const previous = existingById.get(row.id);
    if (previous && previous.fingerprint !== row.fingerprint) {
      return abortWithConflict(tx, done, `${input.label} ${row.id} conflicts with persisted immutable content`);
    }
  }
  try {
    input.assertNoAmbiguity([...existing, ...unique.filter((row) => !existingById.has(row.id))]);
  } catch (error) {
    return abortWithConflict(tx, done, error instanceof Error ? error.message : `${input.label} interval conflicts`);
  }
  unique.forEach((row) => {
    if (!existingById.has(row.id)) store.add(row);
  });
  await done;
}

export function appendSpeakerIdentityEdges(rows: readonly SpeakerIdentityEdgeV1[]): Promise<void> {
  return appendIdentityRows({
    storeName: SPEAKER_WORKFLOW_STORES.speakerIdentities,
    rows,
    label: 'Speaker identity edge',
    assertRow: assertSpeakerIdentityEdge,
    assertNoAmbiguity: assertNoAmbiguousSpeakerIdentityEdges,
  });
}

export function appendSpeakerVoiceIdentities(rows: readonly SpeakerVoiceIdentityV1[]): Promise<void> {
  return appendIdentityRows({
    storeName: SPEAKER_WORKFLOW_STORES.voiceIdentities,
    rows,
    label: 'Speaker voice identity',
    assertRow: assertSpeakerVoiceIdentity,
    assertNoAmbiguity: assertNoAmbiguousSpeakerVoiceIdentities,
  });
}

export async function listSpeakerArtifactDependencies(
  contentRevisionId: string,
): Promise<SpeakerArtifactDependencyV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.artifactDependencies, 'readonly');
  const done = transactionDone(tx);
  const rows = await requestToPromise<SpeakerArtifactDependencyV1[]>(
    tx.objectStore(SPEAKER_WORKFLOW_STORES.artifactDependencies).index('contentRevisionId').getAll(contentRevisionId),
  );
  await done;
  return rows;
}

export async function listSpeakerIdentityEdges(bookId: string): Promise<SpeakerIdentityEdgeV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.speakerIdentities, 'readonly');
  const done = transactionDone(tx);
  const rows = await requestToPromise<SpeakerIdentityEdgeV1[]>(
    tx.objectStore(SPEAKER_WORKFLOW_STORES.speakerIdentities).index('bookId').getAll(bookId),
  );
  await done;
  return rows;
}

export async function listSpeakerVoiceIdentities(bookId: string): Promise<SpeakerVoiceIdentityV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.voiceIdentities, 'readonly');
  const done = transactionDone(tx);
  const rows = await requestToPromise<SpeakerVoiceIdentityV1[]>(
    tx.objectStore(SPEAKER_WORKFLOW_STORES.voiceIdentities).index('bookId').getAll(bookId),
  );
  await done;
  return rows;
}

export interface AcceptedSpeakerProvenanceReplacement {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphIds: readonly string[];
  readonly rows: readonly AcceptedSpeakerProvenanceV1[];
}

export async function replaceAcceptedSpeakerProvenanceForParagraphs(
  input: AcceptedSpeakerProvenanceReplacement,
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance, 'readwrite');
  const done = transactionDone(tx);
  try {
    await replaceAcceptedSpeakerProvenanceForParagraphsInTransaction(tx, input);
    await done;
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  }
}

export async function replaceAcceptedSpeakerProvenanceForParagraphsInTransaction(
  tx: IDBTransaction,
  input: AcceptedSpeakerProvenanceReplacement,
): Promise<void> {
  const paragraphIds = new Set(input.paragraphIds);
  for (const row of input.rows) {
    assertAcceptedSpeakerProvenance(row);
    if (
      row.bookId !== input.bookId ||
      row.contentRevisionId !== input.contentRevisionId ||
      row.chapterId !== input.chapterId ||
      !paragraphIds.has(row.paragraphId)
    ) {
      throw new Error(
        'Accepted speaker provenance replace contains a row outside its book, revision, chapter, or paragraphs',
      );
    }
    if (row.status !== 'active') {
      throw new Error('Accepted speaker provenance replace only accepts active rows');
    }
  }

  const rows = uniqueImmutableRows(input.rows, 'Accepted speaker provenance');
  const segmentIds = new Set<string>();
  for (const row of rows) {
    if (segmentIds.has(row.segmentId)) {
      throw new Error(
        `Duplicate active accepted speaker provenance for revision ${row.contentRevisionId}, segment ${row.segmentId}`,
      );
    }
    segmentIds.add(row.segmentId);
  }
  if (paragraphIds.size === 0 && rows.length === 0) return;

  const store = tx.objectStore(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance);
  const targetRequest = requestToPromise<AcceptedSpeakerProvenanceV1[]>(
    store.index('contentRevisionId_chapterId').getAll([input.contentRevisionId, input.chapterId]),
  );
  const existingByIdRequest = Promise.all(
    rows.map((row) => requestToPromise<AcceptedSpeakerProvenanceV1 | undefined>(store.get(row.id))),
  );
  const existingBySegmentRequest = Promise.all(
    rows.map((row) =>
      requestToPromise<AcceptedSpeakerProvenanceV1[]>(
        store.index('contentRevisionId_segmentId').getAll([row.contentRevisionId, row.segmentId]),
      ),
    ),
  );
  const [chapterRows, existingById, existingBySegment] = await Promise.all([
    targetRequest,
    existingByIdRequest,
    existingBySegmentRequest,
  ]);
  chapterRows.forEach(assertAcceptedSpeakerProvenance);
  const targetActiveRows = chapterRows.filter(
    (row) => row.bookId === input.bookId && paragraphIds.has(row.paragraphId) && row.status === 'active',
  );
  const incomingIds = new Set(rows.map((row) => row.id));
  const supersededIds = new Set(targetActiveRows.filter((row) => !incomingIds.has(row.id)).map((row) => row.id));

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const existing = existingById[index];
    if (existing && existing.fingerprint !== row.fingerprint) {
      abortTransactionWithConflict(
        tx,
        `Accepted speaker provenance ${row.id} conflicts with persisted immutable content`,
      );
    }
    if (existing && existing.status !== 'active') {
      abortTransactionWithConflict(tx, `Accepted speaker provenance ${row.id} is already ${existing.status}`);
    }
    const conflictingActive = existingBySegment[index]!.find(
      (candidate) => candidate.status === 'active' && candidate.id !== row.id && !supersededIds.has(candidate.id),
    );
    if (conflictingActive) {
      abortTransactionWithConflict(
        tx,
        `Duplicate active accepted speaker provenance for revision ${row.contentRevisionId}, segment ${row.segmentId}`,
      );
    }
  }

  targetActiveRows.forEach((row) => {
    if (!incomingIds.has(row.id)) store.put(transitionAcceptedSpeakerProvenance(row, 'superseded'));
  });
  rows.forEach((row, index) => {
    if (!existingById[index]) store.add(row);
  });
}

export async function listAcceptedSpeakerProvenance(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId?: string;
  readonly activeOnly?: boolean;
}): Promise<AcceptedSpeakerProvenanceV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance, 'readonly');
  const done = transactionDone(tx);
  const rows = await requestToPromise<AcceptedSpeakerProvenanceV1[]>(
    tx
      .objectStore(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance)
      .index('contentRevisionId')
      .getAll(input.contentRevisionId),
  );
  await done;
  rows.forEach(assertAcceptedSpeakerProvenance);
  return rows.filter(
    (row) =>
      row.bookId === input.bookId &&
      (input.chapterId === undefined || row.chapterId === input.chapterId) &&
      (!input.activeOnly || row.status === 'active'),
  );
}
