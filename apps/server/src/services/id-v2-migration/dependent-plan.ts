import { bookAIWorkflowPlanIntegrityHash } from '@noveldesk/text-core/identity/workflow';
import { syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import type { BookSnapshotRows } from './book-snapshot.js';
import {
  IdV2MigrationError,
  type BookEntityType,
  type IdV2IdentityFactory,
  type SyncEventIdentityInput,
} from './contracts.js';
import { AliasRegistry } from './alias-registry.js';
import type { CoreMigrationPlan } from './core-plan.js';
import { canonicalOpaqueHash, verifiedCanonicalHash } from './hash-validation.js';
import { remapNestedJson, remapSyncRevision } from './json-remapper.js';
import { integerValue, isoValue, optionalText, record, textValue, type JsonRecord } from './safe-values.js';

interface DerivedHashes {
  readonly workflowPlanHashBySourceId: Map<string, string>;
  readonly providerJobInputHashBySourceId: Map<string, string>;
  readonly analysisInputHashBySourceId: Map<string, string>;
  readonly analysisOutputHashBySourceId: Map<string, string | undefined>;
  readonly segmentHashBySourceId: Map<string, string>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function canonicalId(
  aliases: AliasRegistry,
  entityType: BookEntityType,
  sourceId: unknown,
  optional = false,
): string | undefined {
  const source = optionalText(sourceId);
  if (!source && optional) return undefined;
  return aliases.require(entityType, source);
}

function workflowPlanItemAliases(
  workflow: JsonRecord,
  identities: IdV2IdentityFactory,
  aliases: AliasRegistry,
  hashes: CoreMigrationPlan['hashAliases'],
  canonicalBookId: string,
): void {
  const plan = record(workflow.plan, 'book_ai_workflows.plan');
  const items: Array<{ kind: 'bundle' | 'labeling'; item: JsonRecord }> = [];
  if (Array.isArray(plan.bundleWindows)) {
    items.push(...plan.bundleWindows.map((item) => ({ kind: 'bundle' as const, item: record(item, 'bundle window') })));
  }
  if (Array.isArray(plan.labelingWindows)) {
    items.push(
      ...plan.labelingWindows.map((item) => ({ kind: 'labeling' as const, item: record(item, 'labeling window') })),
    );
  }
  for (const { kind, item } of items) {
    const sourceId = textValue(item.id, 'workflow plan item id');
    const chapterIds = stringArray(item.chapterIds).map((id) => aliases.require('chapter', id));
    const chapterId = optionalText(item.chapterId);
    if (chapterId) chapterIds.push(aliases.require('chapter', chapterId));
    const paragraphIds = stringArray(item.paragraphIds).map((id) => aliases.require('paragraph', id));
    const sourceTextHashFingerprint = textValue(item.textHashFingerprint, 'workflow plan fingerprint');
    const textHashFingerprint = canonicalOpaqueHash(
      sourceTextHashFingerprint,
      { canonicalBookId, chapterIds, paragraphIds, sequence: item.sequence },
      'workflow_plan_item',
    );
    hashes.add(sourceTextHashFingerprint, textHashFingerprint);
    const target = identities.workflowPlanItem({
      bookId: canonicalBookId,
      kind,
      sequence: integerValue(item.sequence, 'workflow plan sequence'),
      startIndex:
        kind === 'bundle'
          ? integerValue(item.startChapterIndex, 'workflow bundle start')
          : paragraphIds.length === 0
            ? 'chapter'
            : integerValue(item.startParagraphIndex, 'workflow labeling start'),
      endIndex:
        kind === 'bundle'
          ? integerValue(item.endChapterIndex, 'workflow bundle end')
          : paragraphIds.length === 0
            ? 'chapter'
            : integerValue(item.endParagraphIndex, 'workflow labeling end'),
      chapterId: chapterId ? aliases.require('chapter', chapterId) : undefined,
      chapterIds,
      paragraphIds,
      textHashFingerprint,
      sourceId,
    });
    aliases.add('workflow_plan_item', sourceId, target);
  }
}

function remappedSyncEntity(
  eventType: string,
  entityId: string | undefined,
  aliases: AliasRegistry,
): string | undefined {
  if (!entityId) return undefined;
  const typeHints: Array<[RegExp, BookEntityType]> = [
    [/book_|reading_position/, 'book'],
    [/bookmark/, 'bookmark'],
    [/highlight/, 'highlight'],
    [/note/, 'note'],
    [/character_graph/, 'book'],
    [/segment|chapter_/, 'chapter'],
    [/voice_profile/, 'voice_profile'],
    [/correction/, 'user_correction'],
  ];
  for (const [pattern, entityType] of typeHints) {
    if (pattern.test(eventType)) {
      const resolved = aliases.resolve(entityType, entityId);
      if (resolved) return resolved;
    }
  }
  return aliases.resolveUnique(entityId) ?? entityId;
}

function addDependentAliases(
  rows: BookSnapshotRows,
  core: CoreMigrationPlan,
  identities: IdV2IdentityFactory,
): DerivedHashes {
  const aliases = core.aliases;
  const annotationTables = [
    ['bookmarks', 'bookmark', identities.bookmark.bind(identities)],
    ['highlights', 'highlight', identities.highlight.bind(identities)],
    ['notes', 'note', identities.note.bind(identities)],
  ] as const;
  for (const [table, entityType, factory] of annotationTables) {
    for (const row of rows[table]) {
      const sourceId = textValue(row.id, `${table}.id`);
      aliases.add(
        entityType,
        sourceId,
        factory({
          bookId: core.canonicalBookId,
          chapterId: aliases.require('chapter', textValue(row.chapter_id, `${table}.chapter_id`)),
          paragraphId: canonicalId(aliases, 'paragraph', row.paragraph_id, true),
          createdAt: isoValue(row.created_at, `${table}.created_at`),
          sourceId,
        }),
      );
    }
  }

  for (const row of rows.characters) {
    const sourceId = textValue(row.id, 'characters.id');
    aliases.add(
      'character',
      sourceId,
      identities.character({
        bookId: core.canonicalBookId,
        canonicalName: textValue(row.canonical_name, 'characters.canonical_name'),
        sourceId,
      }),
    );
  }
  for (const row of rows.character_aliases) {
    const sourceId = textValue(row.id, 'character_aliases.id');
    aliases.add(
      'character_alias',
      sourceId,
      identities.characterAlias(
        core.canonicalBookId,
        aliases.require('character', textValue(row.character_id, 'character_aliases.character_id')),
        textValue(row.alias, 'character_aliases.alias'),
      ),
    );
  }
  for (const row of rows.character_relations) {
    const sourceId = textValue(row.id, 'character_relations.id');
    aliases.add(
      'character_relation',
      sourceId,
      identities.characterRelation(
        core.canonicalBookId,
        aliases.require('character', textValue(row.source_character_id, 'character_relations.source_character_id')),
        aliases.require('character', textValue(row.target_character_id, 'character_relations.target_character_id')),
        textValue(row.relation_label, 'character_relations.relation_label'),
      ),
    );
  }

  for (const workflow of rows.book_ai_workflows) {
    workflowPlanItemAliases(workflow, identities, aliases, core.hashAliases, core.canonicalBookId);
  }
  const workflowPlanHashBySourceId = new Map<string, string>();
  for (const workflow of rows.book_ai_workflows) {
    const sourceId = textValue(workflow.id, 'book_ai_workflows.id');
    const remappedPlan = remapNestedJson(workflow.plan, aliases, core.hashAliases);
    const planHash = bookAIWorkflowPlanIntegrityHash(remappedPlan);
    workflowPlanHashBySourceId.set(sourceId, planHash);
    core.hashAliases.add(textValue(workflow.plan_hash, 'book_ai_workflows.plan_hash'), planHash);
    aliases.add(
      'book_ai_workflow',
      sourceId,
      identities.bookAIWorkflow({
        userId: textValue(workflow.user_id, 'book_ai_workflows.user_id'),
        bookId: core.canonicalBookId,
        workflowType: textValue(workflow.workflow_type, 'book_ai_workflows.workflow_type'),
        providerId: textValue(workflow.provider_id, 'book_ai_workflows.provider_id'),
        modelId: optionalText(workflow.model_id),
        planHash,
        startedAt: isoValue(workflow.started_at ?? workflow.created_at, 'book_ai_workflows.started_at'),
        sourceId,
      }),
    );
  }

  const providerJobInputHashBySourceId = new Map<string, string>();
  for (const job of rows.provider_jobs) {
    const sourceId = textValue(job.id, 'provider_jobs.id');
    const progress = remapNestedJson(job.progress, aliases, core.hashAliases);
    const inputHash = canonicalOpaqueHash(
      textValue(job.input_hash, 'provider_jobs.input_hash'),
      progress,
      'provider_job',
    );
    providerJobInputHashBySourceId.set(sourceId, inputHash);
    core.hashAliases.add(textValue(job.input_hash, 'provider_jobs.input_hash'), inputHash);
    aliases.add(
      'provider_job',
      sourceId,
      identities.providerJob({
        userId: textValue(job.user_id, 'provider_jobs.user_id'),
        bookId: core.canonicalBookId,
        chapterId: canonicalId(aliases, 'chapter', job.chapter_id, true),
        jobType: textValue(job.job_type, 'provider_jobs.job_type'),
        providerId: textValue(job.provider_id, 'provider_jobs.provider_id'),
        modelId: optionalText(job.model_id),
        inputHash,
        sourceId,
      }),
    );
  }

  const analysisInputHashBySourceId = new Map<string, string>();
  const analysisOutputHashBySourceId = new Map<string, string | undefined>();
  for (const run of rows.analysis_runs) {
    const sourceId = textValue(run.id, 'analysis_runs.id');
    const metadata = remapNestedJson(run.metadata, aliases, core.hashAliases);
    const inputHash = canonicalOpaqueHash(
      textValue(run.input_hash, 'analysis_runs.input_hash'),
      metadata,
      'analysis_run_input',
    );
    const sourceOutputHash = optionalText(run.output_hash);
    const outputHash = sourceOutputHash
      ? canonicalOpaqueHash(sourceOutputHash, metadata, 'analysis_run_output')
      : undefined;
    analysisInputHashBySourceId.set(sourceId, inputHash);
    analysisOutputHashBySourceId.set(sourceId, outputHash);
    core.hashAliases.add(textValue(run.input_hash, 'analysis_runs.input_hash'), inputHash);
    if (sourceOutputHash && outputHash) core.hashAliases.add(sourceOutputHash, outputHash);
    aliases.add(
      'analysis_run',
      sourceId,
      identities.analysisRun({
        bookId: core.canonicalBookId,
        providerJobId: optionalText(record(run.metadata ?? {}, 'analysis_runs.metadata').providerJobId)
          ? canonicalId(
              aliases,
              'provider_job',
              record(run.metadata ?? {}, 'analysis_runs.metadata').providerJobId,
              true,
            )
          : undefined,
        inputHash,
        outputHash,
        runType: textValue(run.run_type, 'analysis_runs.run_type'),
        sourceId,
      }),
    );
  }
  for (const context of rows.chapter_contexts) {
    const sourceId = textValue(context.id, 'chapter_contexts.id');
    aliases.add(
      'chapter_context',
      sourceId,
      identities.chapterContext(
        core.canonicalBookId,
        aliases.require('chapter', textValue(context.chapter_id, 'chapter_contexts.chapter_id')),
      ),
    );
  }
  for (const profile of rows.voice_profiles) {
    const sourceId = textValue(profile.id, 'voice_profiles.id');
    aliases.add(
      'voice_profile',
      sourceId,
      identities.voiceProfile({
        bookId: core.canonicalBookId,
        characterId: canonicalId(aliases, 'character', profile.character_id, true),
        role: textValue(profile.role, 'voice_profiles.role'),
        providerId: textValue(profile.provider_id, 'voice_profiles.provider_id'),
        providerVoiceId: textValue(profile.provider_voice_id, 'voice_profiles.provider_voice_id'),
        sourceId,
      }),
    );
  }

  const segmentHashBySourceId = new Map<string, string>();
  for (const segment of rows.labeled_segments) {
    const sourceId = textValue(segment.id, 'labeled_segments.id');
    const sourceParagraphId = textValue(segment.paragraph_id, 'labeled_segments.paragraph_id');
    const paragraphText = core.paragraphTextBySourceId.get(sourceParagraphId);
    if (paragraphText === undefined) {
      throw new IdV2MigrationError('identity_reference_missing', 'A segment paragraph is unavailable.', {
        entityType: 'paragraph',
        sourceId: sourceParagraphId,
      });
    }
    const startOffset = integerValue(segment.start_offset, 'labeled_segments.start_offset');
    const endOffset = integerValue(segment.end_offset, 'labeled_segments.end_offset');
    const segmentText = paragraphText.slice(startOffset, endOffset);
    const segmentTextHash = verifiedCanonicalHash(
      textValue(segment.segment_text_hash, 'labeled_segments.segment_text_hash'),
      segmentText,
      'labeled_segment',
    );
    segmentHashBySourceId.set(sourceId, segmentTextHash);
    core.hashAliases.add(textValue(segment.segment_text_hash, 'labeled_segments.segment_text_hash'), segmentTextHash);
    aliases.add(
      'labeled_segment',
      sourceId,
      identities.labeledSegment({
        bookId: core.canonicalBookId,
        chapterId: aliases.require('chapter', textValue(segment.chapter_id, 'labeled_segments.chapter_id')),
        paragraphId: aliases.require('paragraph', sourceParagraphId),
        segmentIndex: integerValue(segment.segment_index, 'labeled_segments.segment_index'),
        startOffset,
        endOffset,
        segmentTextHash,
        sourceId,
      }),
    );
  }
  for (const correction of rows.user_corrections) {
    const sourceId = textValue(correction.id, 'user_corrections.id');
    aliases.add(
      'user_correction',
      sourceId,
      identities.userCorrection({
        bookId: core.canonicalBookId,
        chapterId: canonicalId(aliases, 'chapter', correction.chapter_id, true),
        paragraphId: canonicalId(aliases, 'paragraph', correction.paragraph_id, true),
        segmentId: canonicalId(aliases, 'labeled_segment', correction.segment_id, true),
        correctionType: textValue(correction.correction_type, 'user_corrections.correction_type'),
        createdAt: isoValue(correction.created_at, 'user_corrections.created_at'),
        sourceId,
      }),
    );
  }
  for (const link of rows.book_ai_workflow_jobs) {
    const sourceId = textValue(link.id, 'book_ai_workflow_jobs.id');
    aliases.add(
      'book_ai_workflow_job',
      sourceId,
      identities.workflowJob(
        aliases.require('book_ai_workflow', textValue(link.workflow_id, 'book_ai_workflow_jobs.workflow_id')),
        textValue(link.stage, 'book_ai_workflow_jobs.stage'),
        aliases.resolve('workflow_plan_item', textValue(link.plan_item_id, 'book_ai_workflow_jobs.plan_item_id')) ??
          textValue(link.plan_item_id, 'book_ai_workflow_jobs.plan_item_id'),
      ),
    );
  }

  for (const event of rows.sync_events) {
    const sourceId = textValue(event.id, 'sync_events.id');
    const type = textValue(event.type, 'sync_events.type');
    const remappedPayload = remapNestedJson(event.payload, aliases, core.hashAliases);
    const payloadHash = syncPayloadIntegrityHash(remappedPayload);
    const input: SyncEventIdentityInput = {
      userId: textValue(event.user_id, 'sync_events.user_id'),
      deviceId: optionalText(event.device_id),
      type,
      bookId: core.canonicalBookId,
      entityId: remappedSyncEntity(type, optionalText(event.entity_id), aliases),
      createdAt: isoValue(event.created_at, 'sync_events.created_at'),
      payloadHash,
      sourceId,
    };
    aliases.add('sync_event', sourceId, identities.syncEvent(input));
  }

  return {
    workflowPlanHashBySourceId,
    providerJobInputHashBySourceId,
    analysisInputHashBySourceId,
    analysisOutputHashBySourceId,
    segmentHashBySourceId,
  };
}

function transformAnnotationRows(
  rows: readonly JsonRecord[],
  entityType: 'bookmark' | 'highlight' | 'note',
  core: CoreMigrationPlan,
): JsonRecord[] {
  return rows.map((row) => ({
    ...row,
    id: core.aliases.require(entityType, textValue(row.id, `${entityType}.id`)),
    book_id: core.canonicalBookId,
    chapter_id: core.aliases.require('chapter', textValue(row.chapter_id, `${entityType}.chapter_id`)),
    paragraph_id: canonicalId(core.aliases, 'paragraph', row.paragraph_id, true) ?? null,
  }));
}

export function buildDependentMigrationRows(input: {
  readonly sourceRows: BookSnapshotRows;
  readonly core: CoreMigrationPlan;
  readonly identities: IdV2IdentityFactory;
}): BookSnapshotRows {
  const { sourceRows, core, identities } = input;
  const hashes = addDependentAliases(sourceRows, core, identities);
  const aliases = core.aliases;
  const target = core.canonicalRows;

  target.reading_positions.push(
    ...sourceRows.reading_positions.map((row) => ({
      ...row,
      book_id: core.canonicalBookId,
      chapter_id: aliases.require('chapter', textValue(row.chapter_id, 'reading_positions.chapter_id')),
      paragraph_id: canonicalId(aliases, 'paragraph', row.paragraph_id, true) ?? null,
    })),
  );
  target.bookmarks.push(...transformAnnotationRows(sourceRows.bookmarks, 'bookmark', core));
  target.highlights.push(...transformAnnotationRows(sourceRows.highlights, 'highlight', core));
  target.notes.push(...transformAnnotationRows(sourceRows.notes, 'note', core));
  target.upload_sessions.push(
    ...sourceRows.upload_sessions.map((row) => ({
      ...row,
      client_book_id: core.canonicalBookId,
      client_hash_hint: row.client_hash_hint ? core.canonicalNormalizedTextHash : null,
    })),
  );
  target.import_jobs.push(...sourceRows.import_jobs.map((row) => ({ ...row, book_id: core.canonicalBookId })));

  target.characters.push(
    ...sourceRows.characters.map((row) => ({
      ...remapNestedJson(row, aliases, core.hashAliases),
      id: aliases.require('character', textValue(row.id, 'characters.id')),
      book_id: core.canonicalBookId,
    })),
  );
  target.character_aliases.push(
    ...sourceRows.character_aliases.map((row) => ({
      ...remapNestedJson(row, aliases, core.hashAliases),
      id: aliases.require('character_alias', textValue(row.id, 'character_aliases.id')),
      book_id: core.canonicalBookId,
      character_id: aliases.require('character', textValue(row.character_id, 'character_aliases.character_id')),
    })),
  );
  target.character_relations.push(
    ...sourceRows.character_relations.map((row) => ({
      ...remapNestedJson(row, aliases, core.hashAliases),
      id: aliases.require('character_relation', textValue(row.id, 'character_relations.id')),
      book_id: core.canonicalBookId,
      source_character_id: aliases.require(
        'character',
        textValue(row.source_character_id, 'character_relations.source_character_id'),
      ),
      target_character_id: aliases.require(
        'character',
        textValue(row.target_character_id, 'character_relations.target_character_id'),
      ),
    })),
  );
  target.analysis_runs.push(
    ...sourceRows.analysis_runs.map((row) => {
      const sourceId = textValue(row.id, 'analysis_runs.id');
      return {
        ...row,
        id: aliases.require('analysis_run', sourceId),
        book_id: core.canonicalBookId,
        chapter_id: canonicalId(aliases, 'chapter', row.chapter_id, true) ?? null,
        input_hash: hashes.analysisInputHashBySourceId.get(sourceId),
        output_hash: hashes.analysisOutputHashBySourceId.get(sourceId) ?? null,
        metadata: remapNestedJson(row.metadata, aliases, core.hashAliases),
      };
    }),
  );
  target.chapter_contexts.push(
    ...sourceRows.chapter_contexts.map((row) => ({
      ...row,
      id: aliases.require('chapter_context', textValue(row.id, 'chapter_contexts.id')),
      book_id: core.canonicalBookId,
      chapter_id: aliases.require('chapter', textValue(row.chapter_id, 'chapter_contexts.chapter_id')),
      analysis_run_id: canonicalId(aliases, 'analysis_run', row.analysis_run_id, true) ?? null,
      active_character_ids: remapNestedJson(row.active_character_ids, aliases, core.hashAliases),
      unresolved: remapNestedJson(row.unresolved, aliases, core.hashAliases),
    })),
  );
  target.voice_profiles.push(
    ...sourceRows.voice_profiles.map((row) => ({
      ...remapNestedJson(row, aliases, core.hashAliases),
      id: aliases.require('voice_profile', textValue(row.id, 'voice_profiles.id')),
      book_id: core.canonicalBookId,
      character_id: canonicalId(aliases, 'character', row.character_id, true) ?? null,
    })),
  );
  target.labeled_segments.push(
    ...sourceRows.labeled_segments.map((row) => {
      const sourceId = textValue(row.id, 'labeled_segments.id');
      return {
        ...row,
        id: aliases.require('labeled_segment', sourceId),
        book_id: core.canonicalBookId,
        chapter_id: aliases.require('chapter', textValue(row.chapter_id, 'labeled_segments.chapter_id')),
        paragraph_id: aliases.require('paragraph', textValue(row.paragraph_id, 'labeled_segments.paragraph_id')),
        segment_text_hash: hashes.segmentHashBySourceId.get(sourceId),
        speaker_id:
          aliases.resolve('character', textValue(row.speaker_id, 'labeled_segments.speaker_id')) ?? row.speaker_id,
        candidate_speakers: remapNestedJson(row.candidate_speakers, aliases, core.hashAliases),
        listener_ids: remapNestedJson(row.listener_ids, aliases, core.hashAliases),
        voice_profile_id: canonicalId(aliases, 'voice_profile', row.voice_profile_id, true) ?? null,
        analysis_run_id: canonicalId(aliases, 'analysis_run', row.analysis_run_id, true) ?? null,
      };
    }),
  );
  target.user_corrections.push(
    ...sourceRows.user_corrections.map((row) => ({
      ...row,
      id: aliases.require('user_correction', textValue(row.id, 'user_corrections.id')),
      book_id: core.canonicalBookId,
      chapter_id: canonicalId(aliases, 'chapter', row.chapter_id, true) ?? null,
      paragraph_id: canonicalId(aliases, 'paragraph', row.paragraph_id, true) ?? null,
      segment_id: canonicalId(aliases, 'labeled_segment', row.segment_id, true) ?? null,
      before_json: remapNestedJson(row.before_json, aliases, core.hashAliases),
      after_json: remapNestedJson(row.after_json, aliases, core.hashAliases),
    })),
  );

  target.book_ai_workflows.push(
    ...sourceRows.book_ai_workflows.map((row) => {
      const sourceId = textValue(row.id, 'book_ai_workflows.id');
      return {
        ...row,
        id: aliases.require('book_ai_workflow', sourceId),
        book_id: core.canonicalBookId,
        plan_hash: hashes.workflowPlanHashBySourceId.get(sourceId),
        plan: remapNestedJson(row.plan, aliases, core.hashAliases),
        progress: remapNestedJson(row.progress, aliases, core.hashAliases),
      };
    }),
  );
  target.provider_jobs.push(
    ...sourceRows.provider_jobs.map((row) => {
      const sourceId = textValue(row.id, 'provider_jobs.id');
      return {
        ...row,
        id: aliases.require('provider_job', sourceId),
        book_id: core.canonicalBookId,
        chapter_id: canonicalId(aliases, 'chapter', row.chapter_id, true) ?? null,
        input_hash: hashes.providerJobInputHashBySourceId.get(sourceId),
        progress: remapNestedJson(row.progress, aliases, core.hashAliases),
      };
    }),
  );
  target.provider_job_attempts.push(
    ...sourceRows.provider_job_attempts.map((row) => ({
      ...row,
      provider_job_id: aliases.require(
        'provider_job',
        textValue(row.provider_job_id, 'provider_job_attempts.provider_job_id'),
      ),
      progress: remapNestedJson(row.progress, aliases, core.hashAliases),
    })),
  );
  target.provider_job_outbox.push(
    ...sourceRows.provider_job_outbox.map((row) => ({
      ...row,
      provider_job_id: aliases.require(
        'provider_job',
        textValue(row.provider_job_id, 'provider_job_outbox.provider_job_id'),
      ),
    })),
  );
  target.book_ai_workflow_jobs.push(
    ...sourceRows.book_ai_workflow_jobs.map((row) => ({
      ...row,
      id: aliases.require('book_ai_workflow_job', textValue(row.id, 'book_ai_workflow_jobs.id')),
      workflow_id: aliases.require('book_ai_workflow', textValue(row.workflow_id, 'book_ai_workflow_jobs.workflow_id')),
      provider_job_id: aliases.require(
        'provider_job',
        textValue(row.provider_job_id, 'book_ai_workflow_jobs.provider_job_id'),
      ),
      plan_item_id:
        aliases.resolve('workflow_plan_item', textValue(row.plan_item_id, 'book_ai_workflow_jobs.plan_item_id')) ??
        row.plan_item_id,
    })),
  );
  target.sync_events.push(
    ...sourceRows.sync_events.map((row) => {
      const payload = remapNestedJson(row.payload, aliases, core.hashAliases);
      const type = textValue(row.type, 'sync_events.type');
      return {
        ...row,
        id: aliases.require('sync_event', textValue(row.id, 'sync_events.id')),
        book_id: core.canonicalBookId,
        entity_id: remappedSyncEntity(type, optionalText(row.entity_id), aliases) ?? null,
        payload,
        revision: remapSyncRevision(row.revision, payload, aliases, core.hashAliases),
        id_contract: 'v2-sha256-128',
        hash_contract: 'v2-sha256-tagged',
      };
    }),
  );
  return target;
}
