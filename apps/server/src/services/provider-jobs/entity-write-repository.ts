import pg from 'pg';
import type { Character, LabeledSegment } from '@noveldesk/contracts';
import { characterAliasId, chapterContextId } from '@noveldesk/text-core/identity/ai';
import type { CharacterRelation, ChapterLabelingResult } from '../../../../../src/providers/ai';

export async function upsertCharacters(
  client: pg.PoolClient,
  bookId: string,
  userId: string,
  characters: Character[],
  provenance?: {
    readonly graphRevisionId?: string;
    readonly contentRevisionId?: string;
    readonly provenanceKind?: 'generated' | 'user_confirmed';
  },
): Promise<void> {
  for (const character of characters) {
    await client.query(
      `
        insert into characters (
          id, book_id, user_id, canonical_name, aliases, color, description,
          confidence, is_user_confirmed, graph_revision_id, source_content_revision_id,
          provenance_kind, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
        on conflict (id) do update
          set canonical_name = case when characters.is_user_confirmed then characters.canonical_name else excluded.canonical_name end,
              aliases = case when characters.is_user_confirmed then characters.aliases else excluded.aliases end,
              color = case when characters.is_user_confirmed then characters.color else excluded.color end,
              description = case when characters.is_user_confirmed then characters.description else excluded.description end,
              confidence = greatest(characters.confidence, excluded.confidence),
              graph_revision_id = excluded.graph_revision_id,
              source_content_revision_id = excluded.source_content_revision_id,
              provenance_kind = case
                when characters.is_user_confirmed then characters.provenance_kind
                else excluded.provenance_kind
              end,
              updated_at = now()
      `,
      [
        character.id,
        bookId,
        userId,
        character.canonicalName,
        JSON.stringify(character.aliases),
        character.color,
        character.description ?? null,
        character.confidence,
        character.isUserConfirmed,
        provenance?.graphRevisionId ?? null,
        provenance?.contentRevisionId ?? null,
        character.isUserConfirmed ? 'user_confirmed' : (provenance?.provenanceKind ?? 'generated'),
      ],
    );
  }
}

export async function replaceCharacterAliases(
  client: pg.PoolClient,
  bookId: string,
  characters: Character[],
  graphRevisionId?: string,
): Promise<void> {
  if (characters.length === 0) return;
  const characterIds = characters.map((character) => character.id);
  await client.query('delete from character_aliases where book_id = $1 and character_id = any($2::text[])', [
    bookId,
    characterIds,
  ]);
  for (const character of characters) {
    const aliases = [
      ...new Set([character.canonicalName, ...character.aliases].map((alias) => alias.trim()).filter(Boolean)),
    ];
    for (const [index, alias] of aliases.entries()) {
      await client.query(
        `
          insert into character_aliases (
            id, book_id, character_id, alias, alias_type, confidence, evidence, created_at, updated_at
            , graph_revision_id
          )
          values ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8)
          on conflict (id) do update
            set alias = excluded.alias,
                alias_type = excluded.alias_type,
                confidence = excluded.confidence,
                evidence = excluded.evidence,
                graph_revision_id = excluded.graph_revision_id,
                updated_at = now()
        `,
        [
          characterAliasId(bookId, character.id, alias),
          bookId,
          character.id,
          alias,
          index === 0 ? 'canonical' : 'name',
          character.confidence,
          JSON.stringify({ source: 'character_graph_merge' }),
          graphRevisionId ?? null,
        ],
      );
    }
  }
}

export async function deleteSupersededGeneratedCharacters(
  client: pg.PoolClient,
  bookId: string,
  activeCharacterIds: readonly string[],
): Promise<void> {
  await client.query(
    `
      delete from characters
      where book_id = $1
        and is_user_confirmed = false
        and not (id = any($2::text[]))
    `,
    [bookId, activeCharacterIds],
  );
}

export async function replaceCharacterRelations(
  client: pg.PoolClient,
  bookId: string,
  relations: CharacterRelation[],
  graphRevisionId?: string,
): Promise<void> {
  await client.query('delete from character_relations where book_id = $1', [bookId]);
  for (const relation of relations) {
    if (relation.sourceCharacterId === relation.targetCharacterId) continue;
    await client.query(
      `
        insert into character_relations (
          id, book_id, source_character_id, target_character_id, relation_label,
          terms_used_by_source, terms_used_by_target, confidence, evidence, created_at, updated_at
          , graph_revision_id
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)
        on conflict (id) do update
          set source_character_id = excluded.source_character_id,
              target_character_id = excluded.target_character_id,
              relation_label = excluded.relation_label,
              terms_used_by_source = excluded.terms_used_by_source,
              terms_used_by_target = excluded.terms_used_by_target,
              confidence = excluded.confidence,
              evidence = excluded.evidence,
              graph_revision_id = excluded.graph_revision_id,
              updated_at = now()
      `,
      [
        relation.id,
        bookId,
        relation.sourceCharacterId,
        relation.targetCharacterId,
        relation.relationLabel,
        JSON.stringify(relation.termsUsedBySource),
        JSON.stringify(relation.termsUsedByTarget),
        relation.confidence,
        JSON.stringify(relation.evidence ?? []),
        graphRevisionId ?? null,
      ],
    );
  }
}

export async function replaceGeneratedSegments(
  client: pg.PoolClient,
  bookId: string,
  chapterId: string,
  analysisRunId: string,
  segments: LabeledSegment[],
  paragraphIds: readonly string[] = [],
  provenance?: {
    readonly contentRevisionId?: string;
    readonly graphRevisionId?: string;
    readonly artifactId?: string;
  },
): Promise<void> {
  if (paragraphIds.length > 0) {
    await client.query(
      'delete from labeled_segments where book_id = $1 and chapter_id = $2 and paragraph_id = any($3::text[]) and is_user_corrected = false',
      [bookId, chapterId, paragraphIds],
    );
  } else {
    await client.query(
      'delete from labeled_segments where book_id = $1 and chapter_id = $2 and is_user_corrected = false',
      [bookId, chapterId],
    );
  }
  for (const segment of segments) {
    await client.query(
      `
        insert into labeled_segments (
          id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
          segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
          emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected, analysis_run_id,
          content_revision_id, graph_revision_id, artifact_id, lifecycle_state,
          created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19,
          $20, $21, $22, 'active', now(), now()
        )
        on conflict (id) do update
          set segment_index = excluded.segment_index,
              start_offset = excluded.start_offset,
              end_offset = excluded.end_offset,
              segment_text_hash = excluded.segment_text_hash,
              segment_type = excluded.segment_type,
              speaker_id = excluded.speaker_id,
              candidate_speakers = excluded.candidate_speakers,
              listener_ids = excluded.listener_ids,
              emotion = excluded.emotion,
              prosody_intent = excluded.prosody_intent,
              confidence = excluded.confidence,
              evidence = excluded.evidence,
              voice_profile_id = excluded.voice_profile_id,
              is_user_corrected = excluded.is_user_corrected,
              analysis_run_id = excluded.analysis_run_id,
              content_revision_id = excluded.content_revision_id,
              graph_revision_id = excluded.graph_revision_id,
              artifact_id = excluded.artifact_id,
              lifecycle_state = 'active',
              updated_at = now()
          where labeled_segments.is_user_corrected = false or excluded.is_user_corrected = true
      `,
      [
        segment.id,
        bookId,
        chapterId,
        segment.paragraphId,
        segment.segmentIndex,
        segment.startOffset,
        segment.endOffset,
        segment.segmentTextHash,
        segment.type,
        segment.speakerId,
        JSON.stringify(segment.candidateSpeakers),
        JSON.stringify(segment.listenerIds),
        segment.emotion,
        segment.prosodyIntent ? JSON.stringify(segment.prosodyIntent) : null,
        segment.confidence,
        segment.evidence ?? null,
        segment.voiceProfileId ?? null,
        segment.isUserCorrected,
        analysisRunId,
        provenance?.contentRevisionId ?? null,
        provenance?.graphRevisionId ?? null,
        provenance?.artifactId ?? null,
      ],
    );
  }
}

export async function upsertChapterContext(
  client: pg.PoolClient,
  bookId: string,
  chapterId: string,
  analysisRunId: string,
  result: ChapterLabelingResult,
  provenance?: {
    readonly contentRevisionId?: string;
    readonly graphRevisionId?: string;
    readonly artifactId?: string;
  },
): Promise<void> {
  if (!result.episodeContextSummary) return;
  const context = result.episodeContextSummary;
  await client.query(
    `
      insert into chapter_contexts (
        id, book_id, chapter_id, analysis_run_id, summary,
        active_character_ids, unresolved, created_at, updated_at
        , content_revision_id, graph_revision_id, artifact_id, lifecycle_state
      )
      values ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, $9, $10, 'active')
      on conflict (chapter_id) do update
        set analysis_run_id = excluded.analysis_run_id,
            summary = excluded.summary,
            active_character_ids = excluded.active_character_ids,
            unresolved = excluded.unresolved,
            content_revision_id = excluded.content_revision_id,
            graph_revision_id = excluded.graph_revision_id,
            artifact_id = excluded.artifact_id,
            lifecycle_state = 'active',
            updated_at = now()
    `,
    [
      chapterContextId(bookId, chapterId),
      bookId,
      chapterId,
      analysisRunId,
      context.summaryForNextChapter || context.scene,
      JSON.stringify(context.activeCharacterIds),
      JSON.stringify(context.unresolved),
      provenance?.contentRevisionId ?? null,
      provenance?.graphRevisionId ?? null,
      provenance?.artifactId ?? null,
    ],
  );
}
