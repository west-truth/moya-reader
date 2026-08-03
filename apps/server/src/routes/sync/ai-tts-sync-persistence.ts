import pg from 'pg';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import {
  booleanValue,
  jsonFromString,
  numberValue,
  parseChapterSegmentsPayload,
  parseCharacterGraphPayload,
  parseCorrectionDeletedPayload,
  parseCorrectionPayload,
  parseVoiceProfilesPayload,
  parseVoiceCastingUpdatedPayload,
  record,
  stringValue,
} from './event-contracts.js';
import { createEmptyVoiceCastingState } from '../../../../../src/providers/voice-casting/state.js';

export async function persistAiTtsSyncEvent(client: pg.PoolClient, userId: string, event: SyncEvent): Promise<boolean> {
  if (event.type === 'voice_casting_updated') {
    const parsed = parseVoiceCastingUpdatedPayload(event);
    if (!parsed.ok) return true;
    const state = createEmptyVoiceCastingState({
      bookId: parsed.bookId,
      contentRevisionId: parsed.payload.contentRevisionId,
      status: 'staging',
    });
    const emptyDerived = {
      importanceProfiles: [],
      traitEvidence: [],
      traitProfiles: [],
      pools: [],
      automaticAssignments: [],
      pinnedAssignments: [],
      reviews: [],
    };
    await client.query(
      `
        insert into voice_casting_states (
          user_id, book_id, version, revision, state_payload, user_authored_payload, derived_payload,
          created_at, updated_at
        )
        values ($1, $2, $3, 1, $4::jsonb, $5::jsonb, $6::jsonb, $7::timestamptz, $7::timestamptz)
        on conflict (user_id, book_id) do update set
          version = excluded.version,
          revision = voice_casting_states.revision + 1,
          state_payload = excluded.state_payload,
          user_authored_payload = excluded.user_authored_payload,
          derived_payload = excluded.derived_payload,
          updated_at = excluded.updated_at
      `,
      [
        userId,
        parsed.bookId,
        parsed.payload.version,
        JSON.stringify(state),
        JSON.stringify(parsed.payload.userArtifacts),
        JSON.stringify(emptyDerived),
        parsed.updatedAt,
      ],
    );
    return true;
  }

  if (event.type === 'character_graph_updated') {
    const parsed = parseCharacterGraphPayload(event);
    if (!parsed.ok) return true;
    const incomingIds = parsed.characters.map((character) => character.id);
    if (parsed.mode === 'replace') {
      await client.query(
        'delete from characters where book_id = $1 and user_id = $2 and not (id = any($3::text[])) and is_user_confirmed = false',
        [parsed.bookId, userId, incomingIds],
      );
    }
    // Omitted relations make this a character-only replacement; an explicit array replaces the full relation projection.
    if (parsed.mode === 'replace' && parsed.relations !== undefined) {
      await client.query('delete from character_relations where book_id = $1', [parsed.bookId]);
    }
    for (const character of parsed.characters) {
      await client.query(
        `
          insert into characters (
            id, book_id, user_id, canonical_name, aliases, color, description,
            confidence, is_user_confirmed, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
          on conflict (id) do update set
            canonical_name = case
              when characters.is_user_confirmed and excluded.is_user_confirmed = false then characters.canonical_name
              else excluded.canonical_name
            end,
            aliases = case
              when characters.is_user_confirmed and excluded.is_user_confirmed = false then characters.aliases
              else excluded.aliases
            end,
            color = case
              when characters.is_user_confirmed and excluded.is_user_confirmed = false then characters.color
              else excluded.color
            end,
            description = case
              when characters.is_user_confirmed and excluded.is_user_confirmed = false then characters.description
              else excluded.description
            end,
            confidence = greatest(characters.confidence, excluded.confidence),
            is_user_confirmed = characters.is_user_confirmed or excluded.is_user_confirmed,
            updated_at = excluded.updated_at
        `,
        [
          character.id,
          parsed.bookId,
          userId,
          character.canonicalName,
          JSON.stringify(character.aliases),
          character.color,
          character.description ?? null,
          character.confidence,
          character.isUserConfirmed,
          parsed.updatedAt,
        ],
      );
    }
    if (parsed.relations) {
      for (const relation of parsed.relations) {
        await client.query(
          `
            insert into character_relations (
              id, book_id, source_character_id, target_character_id, relation_label,
              terms_used_by_source, terms_used_by_target, confidence, evidence, created_at, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
            on conflict (id) do update set
              source_character_id = excluded.source_character_id,
              target_character_id = excluded.target_character_id,
              relation_label = excluded.relation_label,
              terms_used_by_source = excluded.terms_used_by_source,
              terms_used_by_target = excluded.terms_used_by_target,
              confidence = excluded.confidence,
              evidence = excluded.evidence,
              updated_at = excluded.updated_at
          `,
          [
            relation.id,
            parsed.bookId,
            relation.sourceCharacterId,
            relation.targetCharacterId,
            relation.relationLabel,
            JSON.stringify(relation.termsUsedBySource),
            JSON.stringify(relation.termsUsedByTarget),
            relation.confidence,
            JSON.stringify(relation.evidence ?? []),
            parsed.updatedAt,
          ],
        );
      }
    }
    return true;
  }

  if (event.type === 'chapter_segments_updated') {
    const parsed = parseChapterSegmentsPayload(event);
    if (!parsed.ok) return true;
    const incomingIds = parsed.segments.map((segment) => segment.id);
    if (parsed.mode === 'patch') {
      await client.query(
        'delete from labeled_segments where book_id = $1 and chapter_id = $2 and paragraph_id = any($3::text[]) and not (id = any($4::text[])) and is_user_corrected = false',
        [parsed.bookId, parsed.chapterId, parsed.paragraphIds, incomingIds],
      );
    } else {
      await client.query(
        'delete from labeled_segments where book_id = $1 and chapter_id = $2 and not (id = any($3::text[])) and is_user_corrected = false',
        [parsed.bookId, parsed.chapterId, incomingIds],
      );
    }
    for (const segment of parsed.segments) {
      await client.query(
        `
          insert into labeled_segments (
            id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
            segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
            emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, now(), $19)
          on conflict (id) do update set
            paragraph_id = excluded.paragraph_id,
            segment_index = excluded.segment_index,
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
            updated_at = excluded.updated_at
          where labeled_segments.is_user_corrected = false or excluded.is_user_corrected = true
        `,
        [
          segment.id,
          parsed.bookId,
          parsed.chapterId,
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
          parsed.updatedAt,
        ],
      );
    }
    return true;
  }

  if (event.type === 'voice_profiles_updated') {
    const parsed = parseVoiceProfilesPayload(event);
    if (!parsed.ok) return true;
    const bookId = parsed.bookId;
    await client.query('delete from voice_profiles where book_id = $1', [bookId]);
    for (const profile of parsed.profiles) {
      const id = stringValue(profile.id);
      const role = stringValue(profile.role);
      const providerId = stringValue(profile.providerId);
      const providerVoiceId = stringValue(profile.providerVoiceId);
      const label = stringValue(profile.label);
      await client.query(
        `
          insert into voice_profiles (
            id, book_id, character_id, role, provider_id, provider_voice_id,
            provider_model, label, language, tone, speed, pitch, emotion_policy,
            provider_options, is_user_selected, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          on conflict (id) do update set
            character_id = excluded.character_id,
            role = excluded.role,
            provider_id = excluded.provider_id,
            provider_voice_id = excluded.provider_voice_id,
            provider_model = excluded.provider_model,
            label = excluded.label,
            language = excluded.language,
            tone = excluded.tone,
            speed = excluded.speed,
            pitch = excluded.pitch,
            emotion_policy = excluded.emotion_policy,
            provider_options = excluded.provider_options,
            is_user_selected = excluded.is_user_selected,
            updated_at = excluded.updated_at
        `,
        [
          id,
          bookId,
          stringValue(profile.characterId) ?? null,
          role,
          providerId,
          providerVoiceId,
          stringValue(profile.providerModel) ?? null,
          label,
          stringValue(profile.language) ?? null,
          stringValue(profile.tone) ?? null,
          numberValue(profile.speed, 1),
          profile.pitch === undefined ? null : numberValue(profile.pitch),
          stringValue(profile.emotionPolicy) ?? null,
          JSON.stringify(record(profile.providerOptions)),
          booleanValue(profile.isUserSelected),
          String(profile.createdAt ?? event.createdAt),
          String(profile.updatedAt ?? event.createdAt),
        ],
      );
    }
    return true;
  }

  if (event.type === 'user_correction_created') {
    const parsed = parseCorrectionPayload(event);
    if (!parsed.ok) return true;
    const { bookId, correction } = parsed;
    const id = stringValue(correction.id) ?? event.entityId;
    const chapterId = stringValue(correction.chapterId);
    const correctionType = stringValue(correction.correctionType);
    const afterJson = stringValue(correction.afterJson);
    const applyScope = stringValue(correction.applyScope);
    if (!bookId || !id || !chapterId || !correctionType || !afterJson || !applyScope) {
      return true;
    }
    await client.query(
      `
        insert into user_corrections (
          id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
          before_json, after_json, apply_scope, operation_id, intent_kind, intent_json,
          provenance_kind, source_review_artifact_id, created_at
        )
        values (
          $1, $2, $3, $4,
          (select id from labeled_segments where id = $5 and book_id = $2),
          $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15
        )
        on conflict (id) do update
          set before_json = excluded.before_json,
              after_json = excluded.after_json,
              apply_scope = excluded.apply_scope,
              operation_id = excluded.operation_id,
              intent_kind = excluded.intent_kind,
              intent_json = excluded.intent_json,
              provenance_kind = excluded.provenance_kind,
              source_review_artifact_id = excluded.source_review_artifact_id
      `,
      [
        id,
        bookId,
        chapterId,
        stringValue(correction.paragraphId) ?? null,
        stringValue(correction.segmentId) ?? null,
        correctionType,
        JSON.stringify(jsonFromString(stringValue(correction.beforeJson)) ?? null),
        JSON.stringify(jsonFromString(afterJson)),
        applyScope,
        stringValue(correction.operationId) ?? null,
        stringValue(correction.intentKind) ?? null,
        JSON.stringify(jsonFromString(stringValue(correction.intentJson)) ?? null),
        stringValue(correction.provenanceKind) ?? 'legacy',
        stringValue(correction.sourceReviewArtifactId) ?? null,
        String(correction.createdAt ?? event.createdAt),
      ],
    );
    const after = record(jsonFromString(afterJson));
    if (correctionType === 'speaker' && stringValue(correction.segmentId)) {
      const speakerId = stringValue(after.speakerId);
      if (speakerId) {
        await client.query(
          `
            update labeled_segments
            set speaker_id = $4,
                candidate_speakers = case when $4 <> 'unknown' then to_jsonb(array[$4]::text[]) else candidate_speakers end,
                confidence = case when $4 <> 'unknown' then 1 else confidence end,
                evidence = case when $4 <> 'unknown' then 'User-corrected label.' else evidence end,
                voice_profile_id = null,
                is_user_corrected = case when $4 <> 'unknown' then true else is_user_corrected end,
                updated_at = $5::timestamptz
            where id = $1 and book_id = $2 and chapter_id = $3
          `,
          [
            stringValue(correction.segmentId),
            bookId,
            chapterId,
            speakerId,
            String(correction.createdAt ?? event.createdAt),
          ],
        );
      }
    }
    if (correctionType === 'emotion' && stringValue(correction.segmentId)) {
      const emotion = stringValue(after.emotion);
      if (emotion) {
        await client.query(
          `
            update labeled_segments
            set emotion = $4,
                updated_at = $5::timestamptz
            where id = $1 and book_id = $2 and chapter_id = $3
          `,
          [
            stringValue(correction.segmentId),
            bookId,
            chapterId,
            emotion,
            String(correction.createdAt ?? event.createdAt),
          ],
        );
      }
    }
    return true;
  }

  if (event.type === 'user_correction_deleted') {
    const parsed = parseCorrectionDeletedPayload(event);
    if (!parsed.ok) return true;
    await client.query('delete from user_corrections where id = $1 and book_id = $2', [parsed.id, parsed.bookId]);
    return true;
  }

  return false;
}
