import type pg from 'pg';
import type { PreparedBookReplacement } from './contracts.js';

const exactParagraphMatches = `
  select quarantine.source_entity_id,
         quarantine.payload,
         quarantine.source_anchor_hash,
         paragraph.paragraph_id,
         paragraph.chapter_id,
         paragraph.paragraph_index,
         chapter.chapter_index,
         count(*) over (partition by quarantine.source_entity_id) as match_count
  from book_revision_quarantine quarantine
  join chapters chapter
    on chapter.book_id = quarantine.book_id
   and chapter.chapter_index = (quarantine.source_anchor->>'chapterIndex')::integer
  join paragraph_search paragraph
    on paragraph.book_id = quarantine.book_id
   and paragraph.chapter_id = chapter.id
   and paragraph.paragraph_index = (quarantine.source_anchor->>'paragraphIndex')::integer
   and coalesce(paragraph.paragraph->>'textHash', paragraph.paragraph->>'text_hash', '') = quarantine.source_anchor_hash
  where quarantine.replacement_run_id = $1
    and quarantine.artifact_type = $2
    and quarantine.remap_status = 'quarantined'
    and quarantine.source_anchor->>'kind' = 'paragraph'
    and quarantine.source_anchor_hash is not null
`;

export async function remapExactAnchoredCharacters(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<number> {
  const result = await client.query(
    `
      with matches as (${exactParagraphMatches}),
      unique_matches as (
        select * from matches where match_count = 1 and payload->>'is_user_confirmed' = 'true'
      ),
      inserted as (
        insert into characters (
          id, book_id, user_id, canonical_name, aliases, color, description,
          confidence, is_user_confirmed, graph_revision_id, source_content_revision_id,
          source_anchor, source_anchor_hash, provenance_kind, created_at, updated_at
        )
        select
          source_entity_id,
          $3,
          payload->>'user_id',
          payload->>'canonical_name',
          coalesce(payload->'aliases', '[]'::jsonb),
          payload->>'color',
          payload->>'description',
          coalesce((payload->>'confidence')::numeric, 0),
          true,
          null,
          $4,
          jsonb_build_object(
            'kind', 'paragraph',
            'chapterIndex', chapter_index,
            'paragraphIndex', paragraph_index,
            'paragraphId', paragraph_id,
            'textHash', source_anchor_hash
          ),
          source_anchor_hash,
          'user_confirmed',
          coalesce((payload->>'created_at')::timestamptz, now()),
          now()
        from unique_matches
        returning id
      )
      update book_revision_quarantine quarantine
      set remap_status = 'remapped', remapped_entity_id = inserted.id, remapped_at = now()
      from inserted
      where quarantine.replacement_run_id = $1
        and quarantine.artifact_type = $2
        and quarantine.source_entity_id = inserted.id
    `,
    [replacement.runId, 'character', replacement.bookId, replacement.toContentRevisionId],
  );
  return result.rowCount ?? 0;
}

export async function remapConfirmedCharacterRelations(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<number> {
  const result = await client.query(
    `
      with inserted as (
        insert into character_relations (
          id, book_id, source_character_id, target_character_id, relation_label,
          terms_used_by_source, terms_used_by_target, confidence, evidence,
          graph_revision_id, created_at, updated_at
        )
        select
          quarantine.source_entity_id,
          $2,
          quarantine.payload->>'source_character_id',
          quarantine.payload->>'target_character_id',
          quarantine.payload->>'relation_label',
          coalesce(quarantine.payload->'terms_used_by_source', '[]'::jsonb),
          coalesce(quarantine.payload->'terms_used_by_target', '[]'::jsonb),
          coalesce((quarantine.payload->>'confidence')::numeric, 0),
          coalesce(quarantine.payload->'evidence', '[]'::jsonb),
          null,
          coalesce((quarantine.payload->>'created_at')::timestamptz, now()),
          now()
        from book_revision_quarantine quarantine
        where quarantine.replacement_run_id = $1
          and quarantine.artifact_type = 'character_relation'
          and quarantine.remap_status = 'quarantined'
          and exists (
            select 1 from characters source
            where source.id = quarantine.payload->>'source_character_id' and source.book_id = $2
          )
          and exists (
            select 1 from characters target
            where target.id = quarantine.payload->>'target_character_id' and target.book_id = $2
          )
        returning id
      )
      update book_revision_quarantine quarantine
      set remap_status = 'remapped', remapped_entity_id = inserted.id, remapped_at = now()
      from inserted
      where quarantine.replacement_run_id = $1
        and quarantine.artifact_type = 'character_relation'
        and quarantine.source_entity_id = inserted.id
    `,
    [replacement.runId, replacement.bookId],
  );
  return result.rowCount ?? 0;
}

export async function remapExactAnchoredVoiceProfiles(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<number> {
  const result = await client.query(
    `
      with matches as (${exactParagraphMatches}),
      unique_matches as (
        select * from matches
        where match_count = 1
          and payload->>'is_user_selected' = 'true'
          and (
            nullif(payload->>'character_id', '') is null
            or exists (
              select 1 from characters character
              where character.id = payload->>'character_id' and character.book_id = $3
            )
          )
      ),
      inserted as (
        insert into voice_profiles (
          id, book_id, character_id, role, provider_id, provider_voice_id,
          provider_model, label, language, tone, speed, pitch, emotion_policy,
          provider_options, is_user_selected, source_content_revision_id,
          source_anchor, source_anchor_hash, lifecycle_state, created_at, updated_at
        )
        select
          source_entity_id,
          $3,
          nullif(payload->>'character_id', ''),
          payload->>'role',
          payload->>'provider_id',
          payload->>'provider_voice_id',
          payload->>'provider_model',
          payload->>'label',
          payload->>'language',
          payload->>'tone',
          coalesce((payload->>'speed')::numeric, 1),
          nullif(payload->>'pitch', '')::numeric,
          payload->>'emotion_policy',
          coalesce(payload->'provider_options', '{}'::jsonb),
          true,
          $4,
          jsonb_build_object(
            'kind', 'paragraph',
            'chapterIndex', chapter_index,
            'paragraphIndex', paragraph_index,
            'paragraphId', paragraph_id,
            'textHash', source_anchor_hash
          ),
          source_anchor_hash,
          'active',
          coalesce((payload->>'created_at')::timestamptz, now()),
          now()
        from unique_matches
        returning id
      )
      update book_revision_quarantine quarantine
      set remap_status = 'remapped', remapped_entity_id = inserted.id, remapped_at = now()
      from inserted
      where quarantine.replacement_run_id = $1
        and quarantine.artifact_type = $2
        and quarantine.source_entity_id = inserted.id
    `,
    [replacement.runId, 'voice_profile', replacement.bookId, replacement.toContentRevisionId],
  );
  return result.rowCount ?? 0;
}

export async function remapExactAnchoredCorrections(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<number> {
  const result = await client.query(
    `
      with matches as (${exactParagraphMatches}),
      unique_matches as (select * from matches where match_count = 1),
      inserted as (
        insert into user_corrections (
          id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
          before_json, after_json, apply_scope, source_content_revision_id,
          source_anchor, source_anchor_hash, lifecycle_state, created_at
        )
        select
          source_entity_id,
          $3,
          chapter_id,
          paragraph_id,
          null,
          payload->>'correction_type',
          payload->'before_json',
          coalesce(payload->'after_json', '{}'::jsonb),
          payload->>'apply_scope',
          $4,
          jsonb_build_object(
            'kind', 'paragraph',
            'chapterIndex', chapter_index,
            'paragraphIndex', paragraph_index,
            'paragraphId', paragraph_id,
            'textHash', source_anchor_hash
          ),
          source_anchor_hash,
          'active',
          coalesce((payload->>'created_at')::timestamptz, now())
        from unique_matches
        returning id
      )
      update book_revision_quarantine quarantine
      set remap_status = 'remapped', remapped_entity_id = inserted.id, remapped_at = now()
      from inserted
      where quarantine.replacement_run_id = $1
        and quarantine.artifact_type = $2
        and quarantine.source_entity_id = inserted.id
    `,
    [replacement.runId, 'user_correction', replacement.bookId, replacement.toContentRevisionId],
  );
  return result.rowCount ?? 0;
}
