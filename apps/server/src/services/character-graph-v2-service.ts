import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import pg from 'pg';
import type { CharacterGraph } from '../../../../src/providers/ai';
import {
  buildCharacterIdentityOperationPlanV2,
  CharacterIdentityConflictError,
} from '../../../../src/providers/character-identity-operation';
import {
  activeCharacterGraphFingerprintV2,
  backfillCharacterGraphKnowledgeV2,
  CHARACTER_GRAPH_KNOWLEDGE_VERSION,
  deriveCharacterMergeCandidatesV2,
  type CharacterGraphKnowledgeV2,
  type CharacterIdentityCommandV2,
  type CharacterIdentityOperationResultV2,
} from '../../../../src/providers/character-graph-v2';
import { mapCharacter, mapCharacterRelation, mapSegment, mapVoiceProfile } from '../routes/ai/artifact-row-mappers.js';
import { insertServerSyncEvent, serverRevision, withTransaction } from '../routes/ai/sync-event-repository.js';
import {
  replaceCharacterAliases,
  replaceCharacterRelations,
  upsertCharacters,
} from './provider-jobs/entity-write-repository.js';

export interface CharacterGraphV2Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface KnowledgeTable {
  readonly table: string;
  readonly key: keyof Pick<
    CharacterGraphKnowledgeV2,
    | 'facts'
    | 'mentions'
    | 'addressTerms'
    | 'speechTraits'
    | 'relationFacts'
    | 'evidence'
    | 'mergeCandidates'
    | 'redirects'
  >;
}

const KNOWLEDGE_TABLES: readonly KnowledgeTable[] = [
  { table: 'character_facts_v2', key: 'facts' },
  { table: 'character_mentions_v2', key: 'mentions' },
  { table: 'character_address_terms_v2', key: 'addressTerms' },
  { table: 'character_speech_traits_v2', key: 'speechTraits' },
  { table: 'character_relation_facts_v2', key: 'relationFacts' },
  { table: 'character_evidence_v2', key: 'evidence' },
  { table: 'character_merge_candidates_v2', key: 'mergeCandidates' },
  { table: 'character_id_redirects_v2', key: 'redirects' },
];

function rowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? null;
}

async function loadGraph(db: CharacterGraphV2Queryable, userId: string, bookId: string): Promise<CharacterGraph> {
  const [characters, relations] = await Promise.all([
    db.query(
      `select id, book_id, canonical_name, aliases, color, description, confidence, is_user_confirmed
       from characters where book_id = $1 and user_id = $2 order by id`,
      [bookId, userId],
    ),
    db.query(
      `select id, book_id, source_character_id, target_character_id, relation_label,
              terms_used_by_source, terms_used_by_target, confidence, evidence
       from character_relations where book_id = $1 order by id`,
      [bookId],
    ),
  ]);
  return {
    novelId: bookId,
    characters: characters.rows.map(mapCharacter),
    relations: relations.rows.map(mapCharacterRelation),
  };
}

export async function loadCharacterGraphKnowledgeV2(
  db: CharacterGraphV2Queryable,
  bookId: string,
  graph?: CharacterGraph,
): Promise<CharacterGraphKnowledgeV2> {
  const rows = await Promise.all(
    KNOWLEDGE_TABLES.map(({ table }) =>
      db.query(`select payload from ${table} where book_id = $1 order by id`, [bookId]),
    ),
  );
  const knowledge: CharacterGraphKnowledgeV2 = {
    version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
    novelId: bookId,
    facts: rows[0]!.rows.map((row) => row.payload),
    mentions: rows[1]!.rows.map((row) => row.payload),
    addressTerms: rows[2]!.rows.map((row) => row.payload),
    speechTraits: rows[3]!.rows.map((row) => row.payload),
    relationFacts: rows[4]!.rows.map((row) => row.payload),
    evidence: rows[5]!.rows.map((row) => row.payload),
    mergeCandidates: rows[6]!.rows.map((row) => row.payload),
    redirects: rows[7]!.rows.map((row) => row.payload),
  } as CharacterGraphKnowledgeV2;
  const activeKnowledge = KNOWLEDGE_TABLES.some(({ key }) => knowledge[key].length > 0)
    ? knowledge
    : backfillCharacterGraphKnowledgeV2(graph ?? { novelId: bookId, characters: [], relations: [] });
  return { ...activeKnowledge, mergeCandidates: deriveCharacterMergeCandidatesV2(activeKnowledge) };
}

export async function loadCharacterGraphKnowledgeForBookV2(
  db: CharacterGraphV2Queryable,
  userId: string,
  bookId: string,
): Promise<CharacterGraphKnowledgeV2> {
  return loadCharacterGraphKnowledgeV2(db, bookId, await loadGraph(db, userId, bookId));
}

async function insertKnowledgeRow(
  db: CharacterGraphV2Queryable,
  table: KnowledgeTable,
  bookId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = String(payload.id);
  if (table.key === 'facts') {
    await db.query(
      `insert into character_facts_v2
       (id, book_id, character_id, field_name, status, from_chapter_index, to_chapter_index, scene_id, locked_by_user, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set character_id=excluded.character_id, field_name=excluded.field_name,
         status=excluded.status, from_chapter_index=excluded.from_chapter_index,
         to_chapter_index=excluded.to_chapter_index, scene_id=excluded.scene_id,
         locked_by_user=excluded.locked_by_user, payload=excluded.payload, updated_at=now()`,
      [
        id,
        bookId,
        payload.characterId,
        payload.field,
        payload.status,
        rowValue(payload.validity as Record<string, unknown>, 'fromChapterIndex'),
        rowValue(payload.validity as Record<string, unknown>, 'toChapterIndex'),
        rowValue(payload.validity as Record<string, unknown>, 'sceneId'),
        payload.lockedByUser,
        payload,
      ],
    );
    return;
  }
  if (table.key === 'mentions') {
    const validity = payload.validity as Record<string, unknown>;
    await db.query(
      `insert into character_mentions_v2
       (id, book_id, character_id, normalized_surface, chapter_id, scene_id, status, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set character_id=excluded.character_id, normalized_surface=excluded.normalized_surface,
         chapter_id=excluded.chapter_id, scene_id=excluded.scene_id, status=excluded.status, payload=excluded.payload, updated_at=now()`,
      [
        id,
        bookId,
        payload.characterId,
        payload.normalizedSurface,
        null,
        rowValue(validity, 'sceneId'),
        payload.status,
        payload,
      ],
    );
    return;
  }
  if (table.key === 'addressTerms') {
    const validity = payload.validity as Record<string, unknown>;
    await db.query(
      `insert into character_address_terms_v2
       (id, book_id, speaker_character_id, target_character_id, normalized_surface, from_chapter_index, to_chapter_index, scene_id, status, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set speaker_character_id=excluded.speaker_character_id,
         target_character_id=excluded.target_character_id, normalized_surface=excluded.normalized_surface,
         from_chapter_index=excluded.from_chapter_index, to_chapter_index=excluded.to_chapter_index,
         scene_id=excluded.scene_id, status=excluded.status, payload=excluded.payload, updated_at=now()`,
      [
        id,
        bookId,
        payload.speakerCharacterId,
        payload.targetCharacterId,
        payload.normalizedSurface,
        rowValue(validity, 'fromChapterIndex'),
        rowValue(validity, 'toChapterIndex'),
        rowValue(validity, 'sceneId'),
        payload.status,
        payload,
      ],
    );
    return;
  }
  if (table.key === 'speechTraits') {
    const validity = payload.validity as Record<string, unknown>;
    await db.query(
      `insert into character_speech_traits_v2
       (id, book_id, character_id, trait, from_chapter_index, to_chapter_index, scene_id, status, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set character_id=excluded.character_id, trait=excluded.trait,
         from_chapter_index=excluded.from_chapter_index, to_chapter_index=excluded.to_chapter_index,
         scene_id=excluded.scene_id, status=excluded.status, payload=excluded.payload, updated_at=now()`,
      [
        id,
        bookId,
        payload.characterId,
        payload.trait,
        rowValue(validity, 'fromChapterIndex'),
        rowValue(validity, 'toChapterIndex'),
        rowValue(validity, 'sceneId'),
        payload.status,
        payload,
      ],
    );
    return;
  }
  if (table.key === 'relationFacts') {
    const validity = payload.validity as Record<string, unknown>;
    await db.query(
      `insert into character_relation_facts_v2
       (id, book_id, source_character_id, target_character_id, relation_label, from_chapter_index, to_chapter_index, scene_id, status, locked_by_user, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (id) do update set source_character_id=excluded.source_character_id,
         target_character_id=excluded.target_character_id, relation_label=excluded.relation_label,
         from_chapter_index=excluded.from_chapter_index, to_chapter_index=excluded.to_chapter_index,
         scene_id=excluded.scene_id, status=excluded.status, locked_by_user=excluded.locked_by_user,
         payload=excluded.payload, updated_at=now()`,
      [
        id,
        bookId,
        payload.sourceCharacterId,
        payload.targetCharacterId,
        payload.relationLabel,
        rowValue(validity, 'fromChapterIndex'),
        rowValue(validity, 'toChapterIndex'),
        rowValue(validity, 'sceneId'),
        payload.status,
        payload.lockedByUser,
        payload,
      ],
    );
    return;
  }
  if (table.key === 'evidence') {
    await db.query(
      `insert into character_evidence_v2
       (id, book_id, chapter_id, paragraph_id, normalized_surface, status, payload)
       values ($1,$2,$3,$4,$5,'candidate',$6)
       on conflict (id) do update set chapter_id=excluded.chapter_id, paragraph_id=excluded.paragraph_id,
         normalized_surface=excluded.normalized_surface, payload=excluded.payload, updated_at=now()`,
      [id, bookId, payload.chapterId, payload.paragraphId, null, payload],
    );
    return;
  }
  if (table.key === 'mergeCandidates') {
    await db.query(
      `insert into character_merge_candidates_v2
       (id, book_id, source_character_id, target_character_id, status, confidence, payload)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set source_character_id=excluded.source_character_id,
         target_character_id=excluded.target_character_id, status=excluded.status,
         confidence=excluded.confidence, payload=excluded.payload, updated_at=now()`,
      [id, bookId, payload.sourceCharacterId, payload.targetCharacterId, payload.status, payload.confidence, payload],
    );
    return;
  }
  await db.query(
    `insert into character_id_redirects_v2
     (id, book_id, source_character_id, target_character_id, operation_id, graph_revision, payload, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (book_id, source_character_id) do update set target_character_id=excluded.target_character_id,
       operation_id=excluded.operation_id, graph_revision=excluded.graph_revision, payload=excluded.payload`,
    [
      id,
      bookId,
      payload.sourceCharacterId,
      payload.targetCharacterId,
      payload.operationId,
      payload.graphRevision,
      payload,
      payload.createdAt,
    ],
  );
}

async function replaceKnowledge(db: CharacterGraphV2Queryable, knowledge: CharacterGraphKnowledgeV2): Promise<void> {
  for (const table of KNOWLEDGE_TABLES) {
    await db.query(`delete from ${table.table} where book_id = $1`, [knowledge.novelId]);
    for (const row of knowledge[table.key]) {
      await insertKnowledgeRow(db, table, knowledge.novelId, row as unknown as Record<string, unknown>);
    }
  }
}

export async function saveCharacterGraphObservationsV2(
  pool: pg.Pool,
  userId: string,
  observations: CharacterGraphKnowledgeV2,
): Promise<void> {
  await withTransaction(pool, async (db) => {
    const access = await db.query('select id from library_books where id = $1 and user_id = $2 for update', [
      observations.novelId,
      userId,
    ]);
    if (!access.rows[0]) throw new Error('book not found');
    const graph = await loadGraph(db, userId, observations.novelId);
    const current = await loadCharacterGraphKnowledgeV2(db, observations.novelId, graph);
    const merge = <T extends { id: string }>(left: readonly T[], right: readonly T[]) => [
      ...new Map([...left, ...right].map((row) => [row.id, row])).values(),
    ];
    const next: CharacterGraphKnowledgeV2 = {
      version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
      novelId: observations.novelId,
      facts: merge(current.facts, observations.facts),
      mentions: merge(current.mentions, observations.mentions),
      addressTerms: merge(current.addressTerms, observations.addressTerms),
      speechTraits: merge(current.speechTraits, observations.speechTraits),
      relationFacts: merge(current.relationFacts, observations.relationFacts),
      evidence: merge(current.evidence, observations.evidence),
      mergeCandidates: merge(current.mergeCandidates, observations.mergeCandidates),
      redirects: merge(current.redirects, observations.redirects),
    };
    await replaceKnowledge(db, { ...next, mergeCandidates: deriveCharacterMergeCandidatesV2(next) });
  });
}

export async function applyHostedCharacterIdentityCommandV2(
  pool: pg.Pool,
  userId: string,
  command: CharacterIdentityCommandV2,
): Promise<CharacterIdentityOperationResultV2> {
  return withTransaction(pool, async (db) => {
    const client = db as pg.PoolClient;
    const book = await db.query(
      `select id, active_content_revision_id, active_character_graph_revision_id
       from library_books where id = $1 and user_id = $2 for update`,
      [command.novelId, userId],
    );
    if (!book.rows[0]) throw new Error('book not found');
    const commandHash = structuredIntegrityHash(command);
    const receipt = await db.query(
      `select command_hash, result from character_identity_operation_receipts_v2 where operation_id = $1`,
      [command.operationId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].command_hash !== commandHash) {
        throw new CharacterIdentityConflictError('Character identity operation id was reused', 'operation_reused');
      }
      return receipt.rows[0].result as CharacterIdentityOperationResultV2;
    }

    const [graph, segmentRows, voiceRows, chapterRows] = await Promise.all([
      loadGraph(db, userId, command.novelId),
      db.query(
        `select id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
                segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
                emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected
         from labeled_segments where book_id = $1 order by chapter_id, segment_index`,
        [command.novelId],
      ),
      db.query(
        `select id, book_id, character_id, role, provider_id, provider_voice_id, provider_model,
                label, language, tone, speed, pitch, emotion_policy, provider_options,
                is_user_selected, created_at, updated_at
         from voice_profiles where book_id = $1 order by id`,
        [command.novelId],
      ),
      db.query('select id, chapter_index from chapters where book_id = $1 order by chapter_index', [command.novelId]),
    ]);
    const knowledge = await loadCharacterGraphKnowledgeV2(db, command.novelId, graph);
    const segments = segmentRows.rows.map(mapSegment);
    const voiceProfiles = voiceRows.rows.map(mapVoiceProfile);
    const plan = buildCharacterIdentityOperationPlanV2({
      command,
      graph,
      knowledge,
      segments,
      voiceProfiles,
      chapterIndexById: Object.fromEntries(chapterRows.rows.map((row) => [String(row.id), Number(row.chapter_index)])),
    });
    const revisionId = persistentId128('character_graph_revision_v2', [command.novelId, command.operationId]);
    const nextRevision = await db.query(
      'select coalesce(max(revision_number), 0) + 1 as next_revision from character_graph_revisions where book_id = $1',
      [command.novelId],
    );
    const activeFingerprint = activeCharacterGraphFingerprintV2(plan.graph, plan.knowledge);
    await db.query(
      `update character_graph_revisions set status = 'superseded', superseded_at = now()
       where book_id = $1 and status = 'active'`,
      [command.novelId],
    );
    await db.query(
      `insert into character_graph_revisions
       (id, book_id, content_revision_id, revision_number, graph_fingerprint, snapshot, status, promoted_at)
       values ($1,$2,$3,$4,$5,$6,'active',now())`,
      [
        revisionId,
        command.novelId,
        book.rows[0].active_content_revision_id,
        nextRevision.rows[0].next_revision,
        activeFingerprint,
        { ...plan.graph, knowledgeV2: plan.knowledge },
      ],
    );
    await upsertCharacters(client, command.novelId, userId, plan.graph.characters, {
      graphRevisionId: revisionId,
      contentRevisionId: book.rows[0].active_content_revision_id,
    });
    await replaceCharacterRelations(client, command.novelId, plan.graph.relations, revisionId);
    await replaceCharacterAliases(client, command.novelId, plan.graph.characters, revisionId);
    await db.query('delete from characters where book_id = $1 and user_id = $2 and not (id = any($3::text[]))', [
      command.novelId,
      userId,
      plan.graph.characters.map((character) => character.id),
    ]);
    await replaceKnowledge(db, plan.knowledge);
    for (const segment of plan.segments) {
      const previous = segments.find((item) => item.id === segment.id);
      if (!previous || structuredIntegrityHash(previous) === structuredIntegrityHash(segment)) continue;
      await db.query(
        `update labeled_segments set speaker_id=$2, candidate_speakers=$3, listener_ids=$4,
           voice_profile_id=$5, graph_revision_id=$6, updated_at=now() where id=$1 and book_id=$7`,
        [
          segment.id,
          segment.speakerId,
          JSON.stringify(segment.candidateSpeakers),
          JSON.stringify(segment.listenerIds),
          segment.voiceProfileId ?? null,
          revisionId,
          command.novelId,
        ],
      );
    }
    const nextVoiceIds = new Set(plan.voiceProfiles.map((profile) => profile.id));
    for (const profile of voiceProfiles) {
      if (!nextVoiceIds.has(profile.id))
        await db.query('delete from voice_profiles where id = $1 and book_id = $2', [profile.id, command.novelId]);
    }
    for (const profile of plan.voiceProfiles) {
      await db.query('update voice_profiles set character_id = $2, updated_at = now() where id = $1 and book_id = $3', [
        profile.id,
        profile.characterId ?? null,
        command.novelId,
      ]);
    }
    await db.query(
      'update library_books set active_character_graph_revision_id = $2, updated_at = now() where id = $1',
      [command.novelId, revisionId],
    );
    const obsolete = await db.query(
      `update analysis_review_artifacts set status='obsolete', updated_at=now()
       where book_id=$1 and status in ('open','editing','approved','promoting') returning id`,
      [command.novelId],
    );
    await db.query(
      `update tts_audio_cache set lifecycle_state='stale', updated_at=now()
       where book_id=$1 and speaker_id = any($2::text[])`,
      [command.novelId, plan.result.affectedCharacterIds],
    );
    const result: CharacterIdentityOperationResultV2 = {
      ...plan.result,
      graphRevision: revisionId,
      redirect: plan.result.redirect ? { ...plan.result.redirect, graphRevision: revisionId } : undefined,
      invalidation: {
        ...plan.result.invalidation,
        staleReviewArtifactIds: obsolete.rows.map((row) => String(row.id)),
      },
    };
    const createdAt = command.createdAt;
    const graphPayload = { mode: 'replace', characters: plan.graph.characters, relations: plan.graph.relations };
    await insertServerSyncEvent(db, userId, {
      seed: `character_graph_updated:${command.operationId}`,
      type: 'character_graph_updated',
      bookId: command.novelId,
      entityId: `character_graph_${command.novelId}`,
      payload: graphPayload,
      revision: serverRevision({
        entityType: 'character_graph',
        entityId: `character_graph_${command.novelId}`,
        novelId: command.novelId,
        updatedAt: createdAt,
        payload: graphPayload,
      }),
      createdAt,
    });
    await db.query(
      `insert into character_identity_operation_receipts_v2
       (operation_id, book_id, command_hash, result, applied_at) values ($1,$2,$3,$4,$5)`,
      [command.operationId, command.novelId, commandHash, result, command.createdAt],
    );
    return result;
  });
}
