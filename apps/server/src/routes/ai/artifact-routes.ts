import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  resourceCollectionRevision,
  resourceGraphRevision,
  syncPayloadIntegrityHash,
  userCorrectionResourceRevision,
  voiceProfilesResourceRevision,
} from '@noveldesk/text-core/identity/sync';
import type { Character, LabeledSegment, VoiceProfile } from '@noveldesk/contracts';
import type { CharacterRelation } from '../../../../../src/providers/ai';
import type { ServerConfig } from '../../config.js';
import {
  validateCharacter,
  validateCharacterRelation,
  validateCorrection,
  validateSegment,
  validateVoiceProfile,
} from './artifact-contracts.js';
import {
  mapCharacter,
  mapCharacterRelation,
  mapCorrection,
  mapSegment,
  mapVoiceProfile,
} from './artifact-row-mappers.js';
import { jsonFromString } from './database-row-contract.js';
import { optionalStringField, recordBody } from './request-contracts.js';
import { insertServerSyncEvent, serverRevision, withTransaction } from './sync-event-repository.js';
import { bookExists, chapterBookId } from './workflow-query-service.js';
import {
  resolveExactParagraphSourceAnchor,
  type ExactParagraphSourceAnchor,
} from '../../services/book-revision/source-anchor-repository.js';
import {
  assertServerResourceRevision,
  expectedResourceRevision,
  lockBookResource,
  ServerResourceRevisionConflictError,
} from '../resource-revision.js';
import type { QueryRunner } from './sync-event-repository.js';

function sourceParagraphId(value: unknown): string | undefined {
  const body = recordBody(value);
  const anchor = recordBody(body?.sourceAnchor);
  return optionalStringField(anchor ?? {}, 'paragraphId');
}

async function resolveRequestedAnchor(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
  value: unknown,
): Promise<ExactParagraphSourceAnchor | undefined> {
  const paragraphId = sourceParagraphId(value);
  return paragraphId ? resolveExactParagraphSourceAnchor(pool, config.defaultUserId, bookId, paragraphId) : undefined;
}

async function currentCharacterGraphRevision(db: QueryRunner, userId: string, bookId: string): Promise<string> {
  const [characters, relations] = await Promise.all([
    db.query(
      `select id, book_id, canonical_name, aliases, color, description, confidence, is_user_confirmed
       from characters where book_id = $1 and user_id = $2`,
      [bookId, userId],
    ),
    db.query(
      `select id, book_id, source_character_id, target_character_id, relation_label,
              terms_used_by_source, terms_used_by_target, confidence, evidence
       from character_relations where book_id = $1`,
      [bookId],
    ),
  ]);
  return resourceGraphRevision(
    'character_graph',
    characters.rows.map(mapCharacter),
    relations.rows.map(mapCharacterRelation),
  );
}

async function currentVoiceProfilesRevision(db: QueryRunner, bookId: string): Promise<string> {
  const result = await db.query(
    `select id, book_id, character_id, role, provider_id, provider_voice_id,
            provider_model, label, language, tone, speed, pitch, emotion_policy,
            provider_options, is_user_selected, created_at, updated_at
     from voice_profiles where book_id = $1`,
    [bookId],
  );
  return voiceProfilesResourceRevision(result.rows.map(mapVoiceProfile));
}

async function currentSegmentsRevision(db: QueryRunner, bookId: string, chapterId: string): Promise<string> {
  const result = await db.query(
    `select id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
            segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
            emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected
     from labeled_segments where chapter_id = $1 and book_id = $2`,
    [chapterId, bookId],
  );
  return resourceCollectionRevision('chapter_segments', result.rows.map(mapSegment));
}

async function currentCorrectionRevision(db: QueryRunner, bookId: string, correctionId: string): Promise<string> {
  const result = await db.query(
    `select id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
            before_json, after_json, apply_scope, created_at
     from user_corrections where id = $1 and book_id = $2`,
    [correctionId, bookId],
  );
  return userCorrectionResourceRevision(result.rows[0] ? mapCorrection(result.rows[0]) : undefined);
}

function resourceConflictPayload(error: ServerResourceRevisionConflictError) {
  return {
    error: 'resource revision conflict',
    resourceKind: error.resourceKind,
    expectedRevision: error.expectedRevision,
    actualRevision: error.actualRevision,
  };
}

export async function registerArtifactRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/characters', async (request, reply) => {
    if (!(await bookExists(pool, config, request.params.bookId)))
      return reply.code(404).send({ error: 'book not found' });
    const result = await pool.query(
      `
          select id, book_id, canonical_name, aliases, color, description, confidence, is_user_confirmed
          from characters
          where book_id = $1 and user_id = $2
          order by canonical_name asc
        `,
      [request.params.bookId, config.defaultUserId],
    );
    return { characters: result.rows.map(mapCharacter) };
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/character-graph', async (request, reply) => {
    if (!(await bookExists(pool, config, request.params.bookId)))
      return reply.code(404).send({ error: 'book not found' });
    const [characters, relations] = await Promise.all([
      pool.query(
        `
            select id, book_id, canonical_name, aliases, color, description, confidence, is_user_confirmed
            from characters
            where book_id = $1 and user_id = $2
            order by canonical_name asc
          `,
        [request.params.bookId, config.defaultUserId],
      ),
      pool.query(
        `
            select id, book_id, source_character_id, target_character_id, relation_label,
                   terms_used_by_source, terms_used_by_target, confidence, evidence
            from character_relations
            where book_id = $1
            order by relation_label asc, id asc
          `,
        [request.params.bookId],
      ),
    ]);
    return {
      graph: {
        novelId: request.params.bookId,
        characters: characters.rows.map(mapCharacter),
        relations: relations.rows.map(mapCharacterRelation),
      },
    };
  });

  app.put<{ Params: { bookId: string }; Body: { characters?: unknown[] } }>(
    '/api/books/:bookId/characters',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      const body = recordBody(request.body);
      if (!body || !Array.isArray(body.characters))
        return reply.code(400).send({ error: 'characters must be an array' });
      const expectedRevision = expectedResourceRevision(body);
      const characters: Character[] = [];
      const characterAnchors = new Map<string, ExactParagraphSourceAnchor>();
      for (const item of body.characters) {
        const parsed = validateCharacter(item, request.params.bookId);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        characters.push(parsed.character);
        const requestedParagraphId = sourceParagraphId(item);
        const anchor = await resolveRequestedAnchor(pool, config, request.params.bookId, item);
        if (requestedParagraphId && !anchor)
          return reply.code(400).send({ error: 'character sourceAnchor is invalid' });
        if (parsed.character.isUserConfirmed && anchor) characterAnchors.set(parsed.character.id, anchor);
      }
      const eventCreatedAt = new Date().toISOString();
      try {
        await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (expectedRevision) {
            assertServerResourceRevision(
              'character_graph',
              expectedRevision,
              await currentCharacterGraphRevision(db, config.defaultUserId, request.params.bookId),
            );
          }
          for (const character of characters) {
            await db.query(
              `
                insert into characters (
                  id, book_id, user_id, canonical_name, aliases, color, description,
                  confidence, is_user_confirmed, source_content_revision_id,
                  source_anchor, source_anchor_hash, provenance_kind, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
                on conflict (id) do update set
                  canonical_name = excluded.canonical_name,
                  aliases = excluded.aliases,
                  color = excluded.color,
                  description = excluded.description,
                  confidence = excluded.confidence,
                  is_user_confirmed = excluded.is_user_confirmed,
                  source_content_revision_id = case
                    when excluded.source_anchor_hash is not null then excluded.source_content_revision_id
                    else characters.source_content_revision_id
                  end,
                  source_anchor = coalesce(excluded.source_anchor, characters.source_anchor),
                  source_anchor_hash = coalesce(excluded.source_anchor_hash, characters.source_anchor_hash),
                  provenance_kind = case
                    when excluded.is_user_confirmed then 'user_confirmed'
                    else characters.provenance_kind
                  end,
                  updated_at = now()
              `,
              [
                character.id,
                request.params.bookId,
                config.defaultUserId,
                character.canonicalName,
                JSON.stringify(character.aliases),
                character.color,
                character.description ?? null,
                character.confidence,
                character.isUserConfirmed,
                characterAnchors.get(character.id)?.contentRevisionId ?? null,
                characterAnchors.get(character.id) ? JSON.stringify(characterAnchors.get(character.id)?.anchor) : null,
                characterAnchors.get(character.id)?.hash ?? null,
                character.isUserConfirmed ? 'user_confirmed' : 'generated',
              ],
            );
          }
          await db.query('delete from characters where book_id = $1 and user_id = $2 and not (id = any($3::text[]))', [
            request.params.bookId,
            config.defaultUserId,
            characters.map((character) => character.id),
          ]);
          const payload = { mode: 'replace', characters };
          const entityId = `character_graph_${request.params.bookId}`;
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `character_graph_updated:${request.params.bookId}:${eventCreatedAt}`,
            type: 'character_graph_updated',
            bookId: request.params.bookId,
            entityId,
            payload,
            revision: serverRevision({
              entityType: 'character_graph',
              entityId,
              novelId: request.params.bookId,
              updatedAt: eventCreatedAt,
              payload,
            }),
            createdAt: eventCreatedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        throw error;
      }
      return { ok: true, characters };
    },
  );

  app.put<{ Params: { bookId: string }; Body: { graph?: unknown; characters?: unknown[]; relations?: unknown[] } }>(
    '/api/books/:bookId/character-graph',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      const body = recordBody(request.body);
      const graphBody = recordBody(body?.graph) ?? body;
      if (!graphBody || !Array.isArray(graphBody.characters))
        return reply.code(400).send({ error: 'characters must be an array' });
      if (!Array.isArray(graphBody.relations)) return reply.code(400).send({ error: 'relations must be an array' });
      const expectedRevision = expectedResourceRevision(body);
      const characters: Character[] = [];
      const characterAnchors = new Map<string, ExactParagraphSourceAnchor>();
      for (const item of graphBody.characters) {
        const parsed = validateCharacter(item, request.params.bookId);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        characters.push(parsed.character);
        const requestedParagraphId = sourceParagraphId(item);
        const anchor = await resolveRequestedAnchor(pool, config, request.params.bookId, item);
        if (requestedParagraphId && !anchor)
          return reply.code(400).send({ error: 'character sourceAnchor is invalid' });
        if (parsed.character.isUserConfirmed && anchor) characterAnchors.set(parsed.character.id, anchor);
      }
      const characterIds = new Set(characters.map((character) => character.id));
      const relations: CharacterRelation[] = [];
      for (const item of graphBody.relations) {
        const parsed = validateCharacterRelation(item, request.params.bookId, characterIds);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        relations.push(parsed.relation);
      }
      const eventCreatedAt = new Date().toISOString();
      try {
        await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (expectedRevision) {
            assertServerResourceRevision(
              'character_graph',
              expectedRevision,
              await currentCharacterGraphRevision(db, config.defaultUserId, request.params.bookId),
            );
          }
          for (const character of characters) {
            await db.query(
              `
                insert into characters (
                  id, book_id, user_id, canonical_name, aliases, color, description,
                  confidence, is_user_confirmed, source_content_revision_id,
                  source_anchor, source_anchor_hash, provenance_kind, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
                on conflict (id) do update set
                  canonical_name = excluded.canonical_name,
                  aliases = excluded.aliases,
                  color = excluded.color,
                  description = excluded.description,
                  confidence = excluded.confidence,
                  is_user_confirmed = excluded.is_user_confirmed,
                  source_content_revision_id = case
                    when excluded.source_anchor_hash is not null then excluded.source_content_revision_id
                    else characters.source_content_revision_id
                  end,
                  source_anchor = coalesce(excluded.source_anchor, characters.source_anchor),
                  source_anchor_hash = coalesce(excluded.source_anchor_hash, characters.source_anchor_hash),
                  provenance_kind = case
                    when excluded.is_user_confirmed then 'user_confirmed'
                    else characters.provenance_kind
                  end,
                  updated_at = now()
              `,
              [
                character.id,
                request.params.bookId,
                config.defaultUserId,
                character.canonicalName,
                JSON.stringify(character.aliases),
                character.color,
                character.description ?? null,
                character.confidence,
                character.isUserConfirmed,
                characterAnchors.get(character.id)?.contentRevisionId ?? null,
                characterAnchors.get(character.id) ? JSON.stringify(characterAnchors.get(character.id)?.anchor) : null,
                characterAnchors.get(character.id)?.hash ?? null,
                character.isUserConfirmed ? 'user_confirmed' : 'generated',
              ],
            );
          }
          await db.query('delete from character_relations where book_id = $1', [request.params.bookId]);
          await db.query('delete from characters where book_id = $1 and user_id = $2 and not (id = any($3::text[]))', [
            request.params.bookId,
            config.defaultUserId,
            characters.map((character) => character.id),
          ]);
          for (const relation of relations) {
            await db.query(
              `
                insert into character_relations (
                  id, book_id, source_character_id, target_character_id, relation_label,
                  terms_used_by_source, terms_used_by_target, confidence, evidence, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
                on conflict (id) do update set
                  source_character_id = excluded.source_character_id,
                  target_character_id = excluded.target_character_id,
                  relation_label = excluded.relation_label,
                  terms_used_by_source = excluded.terms_used_by_source,
                  terms_used_by_target = excluded.terms_used_by_target,
                  confidence = excluded.confidence,
                  evidence = excluded.evidence,
                  updated_at = now()
              `,
              [
                relation.id,
                request.params.bookId,
                relation.sourceCharacterId,
                relation.targetCharacterId,
                relation.relationLabel,
                JSON.stringify(relation.termsUsedBySource),
                JSON.stringify(relation.termsUsedByTarget),
                relation.confidence,
                JSON.stringify(relation.evidence ?? []),
              ],
            );
          }
          const payload = { mode: 'replace', characters, relations };
          const entityId = `character_graph_${request.params.bookId}`;
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `character_graph_updated:${request.params.bookId}:${eventCreatedAt}`,
            type: 'character_graph_updated',
            bookId: request.params.bookId,
            entityId,
            payload,
            revision: serverRevision({
              entityType: 'character_graph',
              entityId,
              novelId: request.params.bookId,
              updatedAt: eventCreatedAt,
              payload,
            }),
            createdAt: eventCreatedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        throw error;
      }
      return { ok: true, graph: { novelId: request.params.bookId, characters, relations } };
    },
  );

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/voice-profiles', async (request, reply) => {
    if (!(await bookExists(pool, config, request.params.bookId)))
      return reply.code(404).send({ error: 'book not found' });
    const result = await pool.query(
      `
          select id, book_id, character_id, role, provider_id, provider_voice_id,
                 provider_model, label, language, tone, speed, pitch, emotion_policy,
                 provider_options, is_user_selected, created_at, updated_at
          from voice_profiles
          where book_id = $1
          order by role asc, label asc
        `,
      [request.params.bookId],
    );
    return { voiceProfiles: result.rows.map(mapVoiceProfile) };
  });

  app.put<{ Params: { bookId: string }; Body: { voiceProfiles?: unknown[] } }>(
    '/api/books/:bookId/voice-profiles',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      const body = recordBody(request.body);
      if (!body || !Array.isArray(body.voiceProfiles))
        return reply.code(400).send({ error: 'voiceProfiles must be an array' });
      const expectedRevision = expectedResourceRevision(body);
      const voiceProfiles: VoiceProfile[] = [];
      const voiceAnchors = new Map<string, ExactParagraphSourceAnchor>();
      for (const item of body.voiceProfiles) {
        const parsed = validateVoiceProfile(item, request.params.bookId);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        voiceProfiles.push(parsed.voiceProfile);
        const requestedParagraphId = sourceParagraphId(item);
        const anchor = await resolveRequestedAnchor(pool, config, request.params.bookId, item);
        if (requestedParagraphId && !anchor) return reply.code(400).send({ error: 'voice sourceAnchor is invalid' });
        if (parsed.voiceProfile.isUserSelected && anchor) voiceAnchors.set(parsed.voiceProfile.id, anchor);
      }
      const eventCreatedAt = new Date().toISOString();
      const syncedVoiceProfiles = voiceProfiles.map((profile) => ({
        ...profile,
        updatedAt: eventCreatedAt,
        createdAt: profile.createdAt ?? eventCreatedAt,
      }));
      try {
        await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (expectedRevision) {
            assertServerResourceRevision(
              'voice_profiles',
              expectedRevision,
              await currentVoiceProfilesRevision(db, request.params.bookId),
            );
          }
          for (const profile of voiceProfiles) {
            await db.query(
              `
                insert into voice_profiles (
                  id, book_id, character_id, role, provider_id, provider_voice_id,
                  provider_model, label, language, tone, speed, pitch, emotion_policy,
                  provider_options, is_user_selected, source_content_revision_id,
                  source_anchor, source_anchor_hash, lifecycle_state, created_at, updated_at
                )
                values (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                  $16, $17, $18, 'active', now(), now()
                )
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
                  source_content_revision_id = case
                    when excluded.source_anchor_hash is not null then excluded.source_content_revision_id
                    else voice_profiles.source_content_revision_id
                  end,
                  source_anchor = coalesce(excluded.source_anchor, voice_profiles.source_anchor),
                  source_anchor_hash = coalesce(excluded.source_anchor_hash, voice_profiles.source_anchor_hash),
                  lifecycle_state = 'active',
                  updated_at = now()
              `,
              [
                profile.id,
                request.params.bookId,
                profile.characterId ?? null,
                profile.role,
                profile.providerId,
                profile.providerVoiceId,
                profile.providerModel ?? null,
                profile.label,
                profile.language ?? null,
                profile.tone ?? null,
                profile.speed,
                profile.pitch ?? null,
                profile.emotionPolicy ?? null,
                JSON.stringify(profile.providerOptions ?? {}),
                profile.isUserSelected,
                voiceAnchors.get(profile.id)?.contentRevisionId ?? null,
                voiceAnchors.get(profile.id) ? JSON.stringify(voiceAnchors.get(profile.id)?.anchor) : null,
                voiceAnchors.get(profile.id)?.hash ?? null,
              ],
            );
          }
          await db.query('delete from voice_profiles where book_id = $1 and not (id = any($2::text[]))', [
            request.params.bookId,
            voiceProfiles.map((profile) => profile.id),
          ]);
          const payload = { voiceProfiles: syncedVoiceProfiles };
          const entityId = `voice_profiles_${request.params.bookId}`;
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `voice_profiles_updated:${request.params.bookId}:${eventCreatedAt}`,
            type: 'voice_profiles_updated',
            bookId: request.params.bookId,
            entityId,
            payload,
            revision: serverRevision({
              entityType: 'voice_profiles',
              entityId,
              novelId: request.params.bookId,
              updatedAt: eventCreatedAt,
              payload,
            }),
            createdAt: eventCreatedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        throw error;
      }
      return { ok: true, voiceProfiles };
    },
  );

  app.get<{ Params: { chapterId: string } }>('/api/chapters/:chapterId/segments', async (request, reply) => {
    const bookId = await chapterBookId(pool, config, request.params.chapterId);
    if (!bookId) return reply.code(404).send({ error: 'chapter not found' });
    const result = await pool.query(
      `
          select id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
                 segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
                 emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected
          from labeled_segments
          where chapter_id = $1 and book_id = $2
          order by segment_index asc
        `,
      [request.params.chapterId, bookId],
    );
    return { segments: result.rows.map(mapSegment) };
  });

  app.put<{ Params: { chapterId: string }; Body: { segments?: unknown[] } }>(
    '/api/chapters/:chapterId/segments',
    async (request, reply) => {
      const bookId = await chapterBookId(pool, config, request.params.chapterId);
      if (!bookId) return reply.code(404).send({ error: 'chapter not found' });
      const body = recordBody(request.body);
      if (!body || !Array.isArray(body.segments)) return reply.code(400).send({ error: 'segments must be an array' });
      const expectedRevision = expectedResourceRevision(body);
      const segments: LabeledSegment[] = [];
      for (const item of body.segments) {
        const parsed = validateSegment(item, bookId, request.params.chapterId);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        segments.push(parsed.segment);
      }
      const eventCreatedAt = new Date().toISOString();
      try {
        await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, bookId))) throw new Error('book not found');
          if ((await chapterBookId(db, config, request.params.chapterId)) !== bookId) {
            throw new Error('chapter not found');
          }
          if (expectedRevision) {
            assertServerResourceRevision(
              'chapter_segments',
              expectedRevision,
              await currentSegmentsRevision(db, bookId, request.params.chapterId),
            );
          }
          for (const segment of segments) {
            await db.query(
              `
                insert into labeled_segments (
                  id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
                  segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
                  emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, now(), now())
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
                  updated_at = now()
              `,
              [
                segment.id,
                bookId,
                request.params.chapterId,
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
              ],
            );
          }
          await db.query(
            'delete from labeled_segments where chapter_id = $1 and book_id = $2 and not (id = any($3::text[]))',
            [request.params.chapterId, bookId, segments.map((segment) => segment.id)],
          );
          const payload = { chapterId: request.params.chapterId, segments };
          const entityId = `chapter_segments_${request.params.chapterId}`;
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `chapter_segments_updated:${request.params.chapterId}:${eventCreatedAt}`,
            type: 'chapter_segments_updated',
            bookId,
            entityId,
            payload,
            revision: serverRevision({
              entityType: 'chapter_segments',
              entityId,
              novelId: bookId,
              updatedAt: eventCreatedAt,
              payload,
            }),
            createdAt: eventCreatedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && ['book not found', 'chapter not found'].includes(error.message)) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true, segments };
    },
  );

  app.get<{ Params: { bookId: string }; Querystring: { chapterId?: string } }>(
    '/api/books/:bookId/corrections',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      const values = [request.params.bookId] as unknown[];
      let chapterFilter = '';
      if (request.query.chapterId) {
        values.push(request.query.chapterId);
        chapterFilter = `and chapter_id = $${values.length}`;
      }
      const result = await pool.query(
        `
            select id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
                   before_json, after_json, apply_scope, created_at
            from user_corrections
            where book_id = $1 ${chapterFilter}
            order by created_at desc
            limit 200
          `,
        values,
      );
      return { corrections: result.rows.map(mapCorrection) };
    },
  );

  app.post<{ Params: { bookId: string }; Body: unknown }>('/api/books/:bookId/corrections', async (request, reply) => {
    if (!(await bookExists(pool, config, request.params.bookId)))
      return reply.code(404).send({ error: 'book not found' });
    const parsed = validateCorrection(request.body, request.params.bookId);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const expectedRevision = expectedResourceRevision(recordBody(request.body));
    const correction = parsed.correction;
    if (correction.chapterId) {
      const bookId = await chapterBookId(pool, config, correction.chapterId);
      if (bookId !== request.params.bookId) return reply.code(404).send({ error: 'chapter not found' });
    }
    const correctionAnchor = correction.paragraphId
      ? await resolveExactParagraphSourceAnchor(
          pool,
          config.defaultUserId,
          request.params.bookId,
          correction.paragraphId,
        )
      : undefined;
    if (correction.paragraphId && !correctionAnchor) {
      return reply.code(400).send({ error: 'correction paragraph anchor is invalid' });
    }
    try {
      await withTransaction(pool, async (db) => {
        if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
          throw new Error('book not found');
        }
        if (correction.chapterId && (await chapterBookId(db, config, correction.chapterId)) !== request.params.bookId) {
          throw new Error('chapter not found');
        }
        if (expectedRevision) {
          assertServerResourceRevision(
            'user_correction',
            expectedRevision,
            await currentCorrectionRevision(db, request.params.bookId, correction.id),
          );
        }
        await db.query(
          `
            insert into user_corrections (
              id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
              before_json, after_json, apply_scope, source_content_revision_id,
              source_anchor, source_anchor_hash, lifecycle_state, created_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13)
            on conflict (id) do update
              set before_json = excluded.before_json,
                  after_json = excluded.after_json,
                  apply_scope = excluded.apply_scope,
                  source_content_revision_id = coalesce(
                    excluded.source_content_revision_id,
                    user_corrections.source_content_revision_id
                  ),
                  source_anchor = coalesce(excluded.source_anchor, user_corrections.source_anchor),
                  source_anchor_hash = coalesce(excluded.source_anchor_hash, user_corrections.source_anchor_hash),
                  lifecycle_state = 'active'
          `,
          [
            correction.id,
            request.params.bookId,
            correction.chapterId ?? null,
            correction.paragraphId ?? null,
            correction.segmentId ?? null,
            correction.correctionType,
            JSON.stringify(jsonFromString(correction.beforeJson) ?? null),
            JSON.stringify(jsonFromString(correction.afterJson)),
            correction.applyScope,
            correctionAnchor?.contentRevisionId ?? null,
            correctionAnchor ? JSON.stringify(correctionAnchor.anchor) : null,
            correctionAnchor?.hash ?? null,
            correction.createdAt,
          ],
        );
        const payload = { correction };
        await insertServerSyncEvent(db, config.defaultUserId, {
          seed: `user_correction_created:${correction.id}:${correction.createdAt}`,
          type: 'user_correction_created',
          bookId: request.params.bookId,
          entityId: correction.id,
          payload,
          revision: serverRevision({
            entityType: 'user_correction',
            entityId: correction.id,
            novelId: request.params.bookId,
            updatedAt: correction.createdAt,
            payload,
          }),
          createdAt: correction.createdAt,
        });
      });
    } catch (error) {
      if (error instanceof ServerResourceRevisionConflictError) {
        return reply.code(409).send(resourceConflictPayload(error));
      }
      if (error instanceof Error && ['book not found', 'chapter not found'].includes(error.message)) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
    return { ok: true, correction };
  });

  app.delete<{ Params: { bookId: string; correctionId: string }; Body: Record<string, unknown> }>(
    '/api/books/:bookId/corrections/:correctionId',
    async (request, reply) => {
      if (!(await bookExists(pool, config, request.params.bookId)))
        return reply.code(404).send({ error: 'book not found' });
      const expectedRevision = expectedResourceRevision(recordBody(request.body));
      const deletedAt = new Date().toISOString();
      const payload = { id: request.params.correctionId, deletedAt };
      try {
        await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (expectedRevision) {
            assertServerResourceRevision(
              'user_correction',
              expectedRevision,
              await currentCorrectionRevision(db, request.params.bookId, request.params.correctionId),
            );
          }
          await db.query('delete from user_corrections where id = $1 and book_id = $2', [
            request.params.correctionId,
            request.params.bookId,
          ]);
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `user_correction_deleted:${request.params.correctionId}:${deletedAt}`,
            type: 'user_correction_deleted',
            bookId: request.params.bookId,
            entityId: request.params.correctionId,
            payload,
            revision: {
              entityType: 'user_correction',
              entityId: request.params.correctionId,
              novelId: request.params.bookId,
              localSequence: 0,
              deletedAt,
              payloadHash: syncPayloadIntegrityHash(payload),
            },
            createdAt: deletedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        throw error;
      }
      return { ok: true, id: request.params.correctionId, deletedAt };
    },
  );
}
