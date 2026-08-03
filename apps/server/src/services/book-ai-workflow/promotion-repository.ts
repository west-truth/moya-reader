import { persistentId128 } from '@noveldesk/text-core/hash';
import { syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import type { CharacterGraph } from '../../../../../src/providers/ai';
import type { SyncEntityRevision, SyncEntityType, SyncEventType } from '@noveldesk/contracts/sync';
import type pg from 'pg';
import type { ProviderJobRow, ProviderRequestProfile } from '../provider-jobs/contracts.js';
import type { AnalysisInputRevision, AnalysisStagingArtifact } from './analysis-input-contracts.js';

export interface PromotionState {
  readonly activeContentRevisionId: string;
  readonly activeGraphRevisionId?: string;
  readonly revisionFence: number;
}

export async function lockBookPromotionState(
  client: pg.PoolClient,
  revision: AnalysisInputRevision,
): Promise<PromotionState | undefined> {
  const result = await client.query<{
    active_content_revision_id: string;
    active_character_graph_revision_id: string | null;
    revision_fence: number | string;
  }>(
    `
      select active_content_revision_id, active_character_graph_revision_id, revision_fence
      from library_books
      where id = $1 and user_id = $2
      for update
    `,
    [revision.bookId, revision.userId],
  );
  const row = result.rows[0];
  return row
    ? {
        activeContentRevisionId: row.active_content_revision_id,
        activeGraphRevisionId: row.active_character_graph_revision_id ?? undefined,
        revisionFence: Number(row.revision_fence),
      }
    : undefined;
}

export async function insertPromotedAnalysisRun(
  client: pg.PoolClient,
  input: {
    readonly analysisRunId: string;
    readonly job: ProviderJobRow;
    readonly revision: AnalysisInputRevision;
    readonly artifact: AnalysisStagingArtifact;
    readonly requestProfile: ProviderRequestProfile;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `
      insert into analysis_runs (
        id, book_id, chapter_id, run_type, provider_id, model_id, prompt_version,
        input_hash, output_hash, status, metadata, content_revision_id,
        input_revision_id, artifact_id, lifecycle_state,
        started_at, finished_at, created_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'succeeded', $10,
        $11, $12, $13, 'active', now(), now(), now()
      )
      on conflict (id) do update
        set output_hash = excluded.output_hash,
            status = 'succeeded',
            metadata = excluded.metadata,
            content_revision_id = excluded.content_revision_id,
            input_revision_id = excluded.input_revision_id,
            artifact_id = excluded.artifact_id,
            lifecycle_state = 'active',
            finished_at = now()
    `,
    [
      input.analysisRunId,
      input.job.book_id,
      input.job.chapter_id,
      input.job.job_type,
      input.job.provider_id,
      input.job.model_id,
      input.requestProfile.promptVersion,
      input.job.input_hash,
      input.artifact.outputHash,
      JSON.stringify({
        requestProfileId: input.requestProfile.id,
        schemaVersion: input.requestProfile.schemaVersion,
        inputRevisionId: input.revision.id,
        artifactId: input.artifact.id,
        ...input.metadata,
      }),
      input.revision.contentRevisionId,
      input.revision.id,
      input.artifact.id,
    ],
  );
}

export async function promoteCharacterGraphRevision(
  client: pg.PoolClient,
  input: {
    readonly revision: AnalysisInputRevision;
    readonly artifact: AnalysisStagingArtifact;
    readonly graph: CharacterGraph;
    readonly fingerprint: string;
  },
): Promise<string> {
  const numberResult = await client.query<{ revision_number: number | string }>(
    `select coalesce(max(revision_number), 0) + 1 as revision_number from character_graph_revisions where book_id = $1`,
    [input.revision.bookId],
  );
  const revisionNumber = Number(numberResult.rows[0]?.revision_number ?? 1);
  const graphRevisionId = persistentId128('character_graph_revision', [
    input.revision.bookId,
    input.revision.contentRevisionId,
    String(revisionNumber),
    input.fingerprint,
    input.artifact.id,
  ]);
  await client.query(
    `
      update character_graph_revisions
      set status = 'superseded', superseded_at = now()
      where id = $1 and book_id = $2 and status = 'active'
    `,
    [input.revision.characterGraphRevisionId ?? null, input.revision.bookId],
  );
  await client.query(
    `
      insert into character_graph_revisions (
        id, book_id, content_revision_id, revision_number, graph_fingerprint,
        snapshot, source_input_revision_id, source_artifact_id, status,
        created_at, promoted_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now(), now())
      on conflict (id) do nothing
    `,
    [
      graphRevisionId,
      input.revision.bookId,
      input.revision.contentRevisionId,
      revisionNumber,
      input.fingerprint,
      JSON.stringify(input.graph),
      input.revision.id,
      input.artifact.id,
    ],
  );
  const activated = await client.query<{ id: string }>(
    `
      update library_books
      set active_character_graph_revision_id = $4, updated_at = now()
      where id = $1
        and user_id = $2
        and active_content_revision_id = $3
        and active_character_graph_revision_id is not distinct from $5
        and revision_fence = $6
      returning id
    `,
    [
      input.revision.bookId,
      input.revision.userId,
      input.revision.contentRevisionId,
      graphRevisionId,
      input.revision.characterGraphRevisionId ?? null,
      input.revision.revisionFence,
    ],
  );
  if (!activated.rows[0]) throw new Error('character_graph_promotion_cas_failed');
  return graphRevisionId;
}

export async function activeGraphRevisionForArtifact(
  client: pg.PoolClient,
  artifactId: string,
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    `
      select graph.id
      from character_graph_revisions graph
      join library_books book on book.active_character_graph_revision_id = graph.id
      where graph.source_artifact_id = $1 and graph.status = 'active'
    `,
    [artifactId],
  );
  return result.rows[0]?.id;
}

export async function updateBookAnalysisStatus(
  client: pg.PoolClient,
  revision: AnalysisInputRevision,
  status: string,
): Promise<void> {
  await client.query(
    `
      update library_books
      set analysis_status = $3, updated_at = now()
      where id = $1 and user_id = $2 and active_content_revision_id = $4 and revision_fence = $5
    `,
    [revision.bookId, revision.userId, status, revision.contentRevisionId, revision.revisionFence],
  );
}

function syncRevision(input: {
  entityType: SyncEntityType;
  entityId: string;
  novelId: string;
  createdAt: string;
  payload: unknown;
}): SyncEntityRevision {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    novelId: input.novelId,
    localSequence: 0,
    updatedAt: input.createdAt,
    payloadHash: syncPayloadIntegrityHash(input.payload),
  };
}

export async function insertPromotionSyncEvent(
  client: pg.PoolClient,
  input: {
    readonly job: ProviderJobRow;
    readonly artifact: AnalysisStagingArtifact;
    readonly type: SyncEventType;
    readonly entityType: SyncEntityType;
    readonly entityId: string;
    readonly payload: unknown;
  },
): Promise<void> {
  const createdAt = input.artifact.createdAt;
  await client.query(
    `
      insert into sync_events (id, user_id, device_id, type, book_id, entity_id, payload, revision, created_at)
      values ($1, $2, null, $3, $4, $5, $6, $7, $8)
      on conflict (id) do nothing
    `,
    [
      syncEventId({
        userId: input.job.user_id,
        type: input.type,
        novelId: input.job.book_id,
        entityId: input.entityId,
        seed: input.artifact.id,
      }),
      input.job.user_id,
      input.type,
      input.job.book_id,
      input.entityId,
      JSON.stringify(input.payload),
      JSON.stringify(
        syncRevision({
          entityType: input.entityType,
          entityId: input.entityId,
          novelId: input.job.book_id,
          createdAt,
          payload: input.payload,
        }),
      ),
      createdAt,
    ],
  );
}
