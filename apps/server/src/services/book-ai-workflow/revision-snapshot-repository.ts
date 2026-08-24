import { persistentId128 } from '@noveldesk/text-core/hash';
import { characterGraphIntegrityHash, correctionCollectionIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { UserCorrection } from '@noveldesk/contracts';
import type { CharacterGraph } from '../../../../../src/providers/ai';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import { loadCharacterGraph, loadRecentCorrections } from '../provider-jobs/job-data-loader.js';
import type { RevisionQueryable } from './analysis-input-repository.js';

interface BookRevisionStateRow {
  id: string;
  user_id: string;
  object_id: string | null;
  normalized_text_hash: string;
  content_revision_number: number | string;
  revision_fence: number | string;
  active_content_revision_id: string;
  active_character_graph_revision_id: string | null;
  source_raw_text_hash: string | null;
  graph_revision_number: number | string | null;
  graph_fingerprint: string | null;
  graph_snapshot: unknown;
}

export interface LockedBookRevisionState {
  readonly bookId: string;
  readonly userId: string;
  readonly sourceObjectId?: string;
  readonly sourceRawTextHash?: string;
  readonly normalizedTextHash: string;
  readonly contentRevisionId: string;
  readonly contentRevisionNumber: number;
  readonly revisionFence: number;
  readonly graphRevisionId?: string;
  readonly graphRevisionNumber: number;
  readonly graphFingerprint: string;
  readonly graphSnapshot: CharacterGraph;
}

function numberValue(value: number | string | null): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Book revision number is invalid');
  return parsed;
}

function pseudoJob(state: LockedBookRevisionState, chapterId?: string): ProviderJobRow {
  return {
    id: `revision_snapshot:${state.bookId}`,
    user_id: state.userId,
    book_id: state.bookId,
    chapter_id: chapterId ?? null,
    job_type: 'revision_snapshot',
    provider_id: 'revision_snapshot',
    model_id: null,
    input_hash: state.contentRevisionId,
    status: 'running',
    progress: {},
  };
}

export async function lockBookRevisionState(
  db: RevisionQueryable,
  userId: string,
  bookId: string,
  options: { readonly lock?: boolean } = { lock: true },
): Promise<LockedBookRevisionState | undefined> {
  const result = await db.query<BookRevisionStateRow>(
    `
      select book.id, book.user_id, book.object_id, book.normalized_text_hash,
             book.content_revision_number, book.revision_fence,
             book.active_content_revision_id, book.active_character_graph_revision_id,
             content.source_raw_text_hash,
             graph.revision_number as graph_revision_number,
             graph.graph_fingerprint,
             graph.snapshot as graph_snapshot
      from library_books book
      join book_content_revisions content on content.id = book.active_content_revision_id
      left join character_graph_revisions graph on graph.id = book.active_character_graph_revision_id
      where book.id = $1 and book.user_id = $2
      ${options.lock === false ? '' : 'for update of book'}
    `,
    [bookId, userId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const graphSnapshot = normalizeCharacterGraphSnapshot(
    row.graph_snapshot ?? { novelId: bookId, characters: [], relations: [] },
    bookId,
    { trustUserConfirmed: true },
  );
  return {
    bookId,
    userId,
    sourceObjectId: row.object_id ?? undefined,
    sourceRawTextHash: row.source_raw_text_hash ?? undefined,
    normalizedTextHash: row.normalized_text_hash,
    contentRevisionId: row.active_content_revision_id,
    contentRevisionNumber: numberValue(row.content_revision_number),
    revisionFence: numberValue(row.revision_fence),
    graphRevisionId: row.active_character_graph_revision_id ?? undefined,
    graphRevisionNumber: numberValue(row.graph_revision_number),
    graphFingerprint: row.graph_fingerprint ?? characterGraphIntegrityHash(graphSnapshot),
    graphSnapshot,
  };
}

export async function ensureCanonicalGraphRevision(
  db: RevisionQueryable,
  state: LockedBookRevisionState,
): Promise<LockedBookRevisionState> {
  const canonicalGraph = await loadCharacterGraph(db, pseudoJob(state));
  const fingerprint = characterGraphIntegrityHash(canonicalGraph);
  if (state.graphRevisionId && state.graphFingerprint === fingerprint) {
    return { ...state, graphSnapshot: canonicalGraph };
  }

  const nextNumberResult = await db.query<{ revision_number: number | string }>(
    `select coalesce(max(revision_number), 0) + 1 as revision_number from character_graph_revisions where book_id = $1`,
    [state.bookId],
  );
  const revisionNumber = numberValue(nextNumberResult.rows[0]?.revision_number ?? 1);
  const revisionId = persistentId128('character_graph_revision', [
    state.bookId,
    state.contentRevisionId,
    String(revisionNumber),
    fingerprint,
  ]);
  await db.query(
    `
      update character_graph_revisions
      set status = 'superseded', superseded_at = now()
      where book_id = $1 and status = 'active'
    `,
    [state.bookId],
  );
  await db.query(
    `
      insert into character_graph_revisions (
        id, book_id, content_revision_id, revision_number, graph_fingerprint,
        snapshot, status, created_at, promoted_at
      )
      values ($1, $2, $3, $4, $5, $6, 'active', now(), now())
    `,
    [revisionId, state.bookId, state.contentRevisionId, revisionNumber, fingerprint, JSON.stringify(canonicalGraph)],
  );
  await db.query(
    `
      update library_books
      set active_character_graph_revision_id = $3, updated_at = now()
      where id = $1 and user_id = $2 and active_content_revision_id = $4 and revision_fence = $5
    `,
    [state.bookId, state.userId, revisionId, state.contentRevisionId, state.revisionFence],
  );
  await db.query(
    `
      update characters
      set graph_revision_id = $2,
          source_content_revision_id = coalesce(source_content_revision_id, $3)
      where book_id = $1
    `,
    [state.bookId, revisionId, state.contentRevisionId],
  );
  await db.query('update character_aliases set graph_revision_id = $2 where book_id = $1', [state.bookId, revisionId]);
  await db.query('update character_relations set graph_revision_id = $2 where book_id = $1', [
    state.bookId,
    revisionId,
  ]);
  return {
    ...state,
    graphRevisionId: revisionId,
    graphRevisionNumber: revisionNumber,
    graphFingerprint: fingerprint,
    graphSnapshot: canonicalGraph,
  };
}

export async function loadPinnedCorrections(
  db: RevisionQueryable,
  state: LockedBookRevisionState,
  chapterId?: string,
): Promise<{ corrections: readonly UserCorrection[]; fingerprint: string }> {
  const corrections = await loadRecentCorrections(db, pseudoJob(state, chapterId));
  return {
    corrections,
    fingerprint: correctionCollectionIntegrityHash(corrections),
  };
}

export function pinParagraphText<T extends { readonly text: string; readonly textHash: string }>(paragraph: T): T {
  return { ...paragraph, textHash: textIntegrityHash(paragraph.text) };
}
