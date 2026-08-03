import { aggregateSyncEntityId, resourceCollectionRevision, syncEventId } from '@noveldesk/text-core/identity/sync';
import type { LabeledSegment, UserCorrection } from '@noveldesk/contracts';
import type pg from 'pg';
import {
  buildLabelMutationPlanV2,
  labelMutationCommandHash,
  LabelMutationConflictError,
  type ApplyLabelCorrectionsCommandV2,
  type ApplyLabelCorrectionsResultV2,
} from '../../../../../src/providers/label-mutation-contract';
import type { ServerConfig } from '../../config.js';
import { mapCorrection, mapSegment } from '../../routes/ai/artifact-row-mappers.js';
import { insertServerSyncEvent, serverRevision } from '../../routes/ai/sync-event-repository.js';
import { resolveExactParagraphSourceAnchor } from '../book-revision/source-anchor-repository.js';
import { withBookAITransaction } from '../book-ai-workflow/transaction.js';
import { markHostedSpeakerArtifactDependenciesStale } from '../speaker-workflow-state-service.js';

const chapterSegmentsRevision = (segments: readonly LabeledSegment[]) =>
  resourceCollectionRevision('chapter_segments', segments);
const correctionsRevision = (corrections: readonly UserCorrection[]) =>
  resourceCollectionRevision('user_corrections', corrections);

interface LabelMutationBookFenceRow extends pg.QueryResultRow {
  active_content_revision_id: string | null;
  active_character_graph_revision_id: string | null;
  revision_fence: number | string;
  graph_fingerprint: string | null;
  chapter_text_hash: string;
}

interface StoredOperationRow extends pg.QueryResultRow {
  command_hash: string;
  result_json: unknown;
}

export class HostedLabelMutationFenceConflictError extends Error {
  constructor(
    readonly fence: string,
    readonly expected: string | number | undefined,
    readonly actual: string | number | undefined,
  ) {
    super(`Label mutation fence changed: ${fence}`);
    this.name = 'HostedLabelMutationFenceConflictError';
  }
}

function assertFence(fence: string, expected: string | number | undefined, actual: string | number | undefined): void {
  if (expected !== undefined && expected !== actual) {
    throw new HostedLabelMutationFenceConflictError(fence, expected, actual);
  }
}

function operationResult(value: unknown): ApplyLabelCorrectionsResultV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Stored label mutation result is invalid');
  return value as ApplyLabelCorrectionsResultV2;
}

async function loadSegmentsForUpdate(
  client: pg.PoolClient,
  bookId: string,
  chapterId: string,
): Promise<LabeledSegment[]> {
  const result = await client.query(
    `
      select id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
             segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
             emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected
      from labeled_segments
      where book_id = $1 and chapter_id = $2 and lifecycle_state = 'active'
      order by segment_index asc, id asc
      for update
    `,
    [bookId, chapterId],
  );
  return result.rows.map(mapSegment);
}

async function loadCorrectionsForUpdate(client: pg.PoolClient, bookId: string): Promise<UserCorrection[]> {
  const result = await client.query(
    `
      select id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
             before_json, after_json, apply_scope, operation_id, intent_kind, intent_json,
             provenance_kind, source_review_artifact_id, created_at
      from user_corrections
      where book_id = $1 and lifecycle_state = 'active'
      order by created_at asc, id asc
      for update
    `,
    [bookId],
  );
  return result.rows.map(mapCorrection);
}

async function staleEpisodeContext(
  client: pg.PoolClient,
  command: ApplyLabelCorrectionsCommandV2,
  requiresContextInvalidation: boolean,
  contextFromWindowId: string | undefined,
): Promise<void> {
  if (!requiresContextInvalidation && !contextFromWindowId) return;
  if (contextFromWindowId) {
    const source = await client.query<{ workflow_id: string; window_sequence: number | string }>(
      `
        select workflow_id, window_sequence
        from analysis_episode_contexts
        where book_id = $1 and window_id = $2
        order by created_at desc
        limit 1
      `,
      [command.bookId, contextFromWindowId],
    );
    const row = source.rows[0];
    if (row) {
      await client.query(
        `
          update analysis_episode_contexts
          set status = 'stale', updated_at = now()
          where workflow_id = $1 and window_sequence >= $2 and status = 'active'
        `,
        [row.workflow_id, Number(row.window_sequence)],
      );
    }
  }
  await client.query(
    `
      update analysis_episode_contexts
      set status = 'stale', updated_at = now()
      where book_id = $1 and chapter_id = $2 and status = 'active'
    `,
    [command.bookId, command.chapterId],
  );
  await client.query(
    `
      update chapter_contexts
      set lifecycle_state = 'stale', updated_at = now()
      where book_id = $1 and chapter_id = $2 and lifecycle_state = 'active'
    `,
    [command.bookId, command.chapterId],
  );
}

export async function applyHostedLabelCorrections(
  pool: pg.Pool,
  config: ServerConfig,
  command: ApplyLabelCorrectionsCommandV2,
): Promise<ApplyLabelCorrectionsResultV2> {
  const commandHash = labelMutationCommandHash(command);
  return withBookAITransaction(pool, async (client) => {
    const existing = await client.query<StoredOperationRow>(
      `select command_hash, result_json from label_mutation_operations where id = $1 and user_id = $2`,
      [command.operationId, config.defaultUserId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].command_hash !== commandHash) {
        throw new LabelMutationConflictError(`operation id was reused: ${command.operationId}`, 'operation_reused');
      }
      return operationResult(existing.rows[0].result_json);
    }

    const fence = await client.query<LabelMutationBookFenceRow>(
      `
        select book.active_content_revision_id,
               book.active_character_graph_revision_id,
               book.revision_fence,
               graph.graph_fingerprint,
               chapter.text_hash as chapter_text_hash
        from library_books book
        join chapters chapter on chapter.id = $3 and chapter.book_id = book.id
        left join character_graph_revisions graph on graph.id = book.active_character_graph_revision_id
        where book.id = $1 and book.user_id = $2
        for update of book
      `,
      [command.bookId, config.defaultUserId, command.chapterId],
    );
    const book = fence.rows[0];
    if (!book?.active_content_revision_id) {
      throw new LabelMutationConflictError(`book or chapter is missing: ${command.bookId}`, 'fence_changed');
    }
    const [segments, corrections] = await Promise.all([
      loadSegmentsForUpdate(client, command.bookId, command.chapterId),
      loadCorrectionsForUpdate(client, command.bookId),
    ]);
    assertFence('contentRevisionId', command.expected.contentRevisionId, book.active_content_revision_id);
    assertFence('chapterTextHash', command.expected.chapterTextHash, book.chapter_text_hash);
    assertFence(
      'graphRevisionId',
      command.expected.graphRevisionId,
      book.active_character_graph_revision_id ?? undefined,
    );
    assertFence('graphFingerprint', command.expected.graphFingerprint, book.graph_fingerprint ?? undefined);
    assertFence('workflowGeneration', command.expected.workflowGeneration, Number(book.revision_fence));
    assertFence(
      'segmentCollectionRevision',
      command.expected.segmentCollectionRevision,
      chapterSegmentsRevision(segments),
    );
    assertFence('correctionRevisionId', command.expected.correctionRevisionId, correctionsRevision(corrections));

    const plan = buildLabelMutationPlanV2(command, segments);
    for (const segmentId of Object.keys(plan.changedFieldsBySegment)) {
      const segment = plan.segments.find((item) => item.id === segmentId);
      if (!segment) continue;
      await client.query(
        `
          update labeled_segments
          set speaker_id = $4,
              candidate_speakers = $5::jsonb,
              listener_ids = $6::jsonb,
              emotion = $7,
              prosody_intent = $8::jsonb,
              confidence = $9,
              voice_profile_id = $10,
              is_user_corrected = true,
              mutation_operation_id = $11,
              updated_at = now()
          where id = $1 and book_id = $2 and chapter_id = $3 and lifecycle_state = 'active'
        `,
        [
          segment.id,
          command.bookId,
          command.chapterId,
          segment.speakerId,
          JSON.stringify(segment.candidateSpeakers),
          JSON.stringify(segment.listenerIds),
          segment.emotion,
          segment.prosodyIntent ? JSON.stringify(segment.prosodyIntent) : null,
          segment.confidence,
          segment.voiceProfileId ?? null,
          command.operationId,
        ],
      );
    }

    const anchors = new Map<string, Awaited<ReturnType<typeof resolveExactParagraphSourceAnchor>>>();
    for (const correction of plan.corrections) {
      if (!anchors.has(correction.paragraphId ?? '')) {
        anchors.set(
          correction.paragraphId ?? '',
          correction.paragraphId
            ? await resolveExactParagraphSourceAnchor(
                client,
                config.defaultUserId,
                command.bookId,
                correction.paragraphId,
              )
            : undefined,
        );
      }
      const anchor = anchors.get(correction.paragraphId ?? '');
      await client.query(
        `
          insert into user_corrections (
            id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
            before_json, after_json, apply_scope, source_content_revision_id,
            source_anchor, source_anchor_hash, lifecycle_state, operation_id,
            intent_kind, intent_json, provenance_kind, source_review_artifact_id, created_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
            $11::jsonb, $12, 'active', $13, $14, $15::jsonb, $16, $17, $18
          )
          on conflict (id) do nothing
        `,
        [
          correction.id,
          command.bookId,
          command.chapterId,
          correction.paragraphId ?? null,
          correction.segmentId ?? null,
          correction.correctionType,
          correction.beforeJson ?? null,
          correction.afterJson,
          correction.applyScope,
          anchor?.contentRevisionId ?? book.active_content_revision_id,
          anchor ? JSON.stringify(anchor.anchor) : null,
          anchor?.hash ?? null,
          command.operationId,
          correction.intentKind ?? null,
          correction.intentJson ?? null,
          correction.provenanceKind ?? 'user_label_mutation',
          command.sourceReviewArtifactId ?? null,
          correction.createdAt,
        ],
      );
    }

    await staleEpisodeContext(client, command, plan.requiresContextInvalidation, plan.contextFromWindowId);
    const obsolete = await client.query<{ id: string }>(
      `
        update analysis_review_artifacts
        set status = 'obsolete', review_revision = review_revision + 1,
            promotion_last_error_code = 'label_mutation_superseded',
            promotion_last_error_at = now(), next_reconcile_at = null, updated_at = now()
        where user_id = $1 and book_id = $2 and chapter_id = $3
          and status in ('open', 'editing', 'validating', 'approved', 'promoting')
          and ($4::text is null or id <> $4)
        returning id
      `,
      [config.defaultUserId, command.bookId, command.chapterId, command.sourceReviewArtifactId ?? null],
    );
    const staleTTS =
      plan.staleTTSSegmentIds.length > 0
        ? await client.query<{ id: string }>(
            `
              update tts_audio_cache
              set lifecycle_state = 'stale', updated_at = now()
              where book_id = $1 and lifecycle_state = 'active' and segment_ids ?| $2::text[]
              returning id
            `,
            [command.bookId, plan.staleTTSSegmentIds],
          )
        : { rows: [] as { id: string }[] };
    const changedFields = new Set(Object.values(plan.changedFieldsBySegment).flat());
    const invalidatedDependencyLevels =
      changedFields.has('speakerId') || changedFields.has('listenerIds') || changedFields.has('segmentType')
        ? ['L3_speaker', 'L4_voice']
        : ['L4_voice'];
    const dependencyRows = await client.query<{ id: string }>(
      `
        select id
        from speaker_artifact_dependencies
        where user_id = $1 and book_id = $2 and content_revision_id = $3
          and chapter_id = $4 and status = 'active'
          and dependency_level = any($5::text[])
        order by id
      `,
      [
        config.defaultUserId,
        command.bookId,
        book.active_content_revision_id,
        command.chapterId,
        invalidatedDependencyLevels,
      ],
    );
    if (dependencyRows.rows.length > 0) {
      await markHostedSpeakerArtifactDependenciesStale(client, config.defaultUserId, {
        bookId: command.bookId,
        contentRevisionId: book.active_content_revision_id,
        rowIds: dependencyRows.rows.map((row) => row.id),
        staleReason: `label_mutation:${command.operationId}`,
      });
    }

    const nextCorrections = [...corrections, ...plan.corrections];
    const segmentPayload = { chapterId: command.chapterId, segments: plan.segments };
    const segmentEntityId = aggregateSyncEntityId({
      entityType: 'chapter_segments',
      novelId: command.bookId,
      chapterId: command.chapterId,
    });
    const segmentSeed = `label_mutation_segments:${command.operationId}`;
    await insertServerSyncEvent(client, config.defaultUserId, {
      seed: segmentSeed,
      type: 'chapter_segments_updated',
      bookId: command.bookId,
      entityId: segmentEntityId,
      payload: segmentPayload,
      revision: serverRevision({
        entityType: 'chapter_segments',
        entityId: segmentEntityId,
        novelId: command.bookId,
        updatedAt: command.createdAt,
        payload: segmentPayload,
      }),
      createdAt: command.createdAt,
    });
    const syncEventIds = [
      syncEventId({
        userId: config.defaultUserId,
        type: 'chapter_segments_updated',
        novelId: command.bookId,
        entityId: segmentEntityId,
        seed: segmentSeed,
      }),
    ];
    for (const correction of plan.corrections) {
      const payload = { correction };
      const seed = `label_mutation_correction:${command.operationId}:${correction.id}`;
      await insertServerSyncEvent(client, config.defaultUserId, {
        seed,
        type: 'user_correction_created',
        bookId: command.bookId,
        entityId: correction.id,
        payload,
        revision: serverRevision({
          entityType: 'user_correction',
          entityId: correction.id,
          novelId: command.bookId,
          updatedAt: correction.createdAt,
          payload,
        }),
        createdAt: correction.createdAt,
      });
      syncEventIds.push(
        syncEventId({
          userId: config.defaultUserId,
          type: 'user_correction_created',
          novelId: command.bookId,
          entityId: correction.id,
          seed,
        }),
      );
    }

    const result: ApplyLabelCorrectionsResultV2 = {
      operationId: command.operationId,
      revisions: {
        segmentCollectionRevision: chapterSegmentsRevision(plan.segments),
        correctionRevisionId: correctionsRevision(nextCorrections),
      },
      updatedSegmentIds: Object.keys(plan.changedFieldsBySegment).sort(),
      createdCorrectionIds: plan.corrections.map((correction) => correction.id).sort(),
      invalidation: {
        contextFromWindowId: plan.contextFromWindowId,
        relabelPlanId: plan.relabelPlanId,
        obsoleteReviewArtifactIds: obsolete.rows.map((row) => row.id).sort(),
        staleTTSRenderItemIds: staleTTS.rows.map((row) => row.id).sort(),
      },
      syncEventIds,
    };
    await client.query(
      `
        insert into label_mutation_operations (
          id, user_id, book_id, chapter_id, source_review_artifact_id,
          command_hash, command_json, expected_fences, result_json, applied_at, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, now())
      `,
      [
        command.operationId,
        config.defaultUserId,
        command.bookId,
        command.chapterId,
        command.sourceReviewArtifactId ?? null,
        commandHash,
        JSON.stringify(command),
        JSON.stringify(command.expected),
        JSON.stringify(result),
        command.createdAt,
      ],
    );
    if (plan.relabelPlanId) {
      await client.query(
        `
          insert into label_reanalysis_plans (
            id, operation_id, user_id, book_id, chapter_id, from_window_id, intent_json, status, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $8)
          on conflict (id) do nothing
        `,
        [
          plan.relabelPlanId,
          command.operationId,
          config.defaultUserId,
          command.bookId,
          command.chapterId,
          plan.contextFromWindowId ?? null,
          JSON.stringify(command.edits.map((edit) => edit.intent)),
          command.createdAt,
        ],
      );
    }
    await client.query(
      `
        insert into label_mutation_invalidations (
          operation_id, book_id, chapter_id, context_from_window_id,
          obsolete_review_artifact_ids, stale_tts_render_item_ids, created_at
        )
        values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
      `,
      [
        command.operationId,
        command.bookId,
        command.chapterId,
        plan.contextFromWindowId ?? null,
        JSON.stringify(result.invalidation.obsoleteReviewArtifactIds),
        JSON.stringify(result.invalidation.staleTTSRenderItemIds),
        command.createdAt,
      ],
    );
    return result;
  });
}
