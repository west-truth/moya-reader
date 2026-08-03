import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import {
  emptyVoiceProductState,
  VOICE_PRODUCT_VERSION,
  type PronunciationProfileV1,
  type VoiceCatalogSnapshotV1,
  type VoiceProductStateV1,
  type VoiceSampleApprovalV1,
  type VoiceSampleRequestV1,
  type VoiceSuggestionV1,
} from '../../../../../src/providers/voice-product';
import { recordBody } from './request-contracts.js';
import { bookExists } from './workflow-query-service.js';
import { withBookAITransaction } from '../../services/book-ai-workflow/transaction.js';
import { hasSecretLikeKey } from '../../providers/server-provider-settings.js';

function payload<T>(row: Record<string, unknown> | undefined): T | undefined {
  return row?.payload && typeof row.payload === 'object' ? (row.payload as T) : undefined;
}

function validateState(value: unknown, bookId: string): VoiceProductStateV1 | undefined {
  const body = recordBody(value);
  if (!body || body.version !== VOICE_PRODUCT_VERSION || body.novelId !== bookId) return undefined;
  if (hasSecretLikeKey(value)) return undefined;
  if (
    !Array.isArray(body.catalogSnapshots) ||
    !Array.isArray(body.suggestions) ||
    !Array.isArray(body.sampleRequests) ||
    !Array.isArray(body.approvals) ||
    !recordBody(body.pronunciationProfile)
  )
    return undefined;
  const majorCharacterLimit = Number(body.majorCharacterLimit);
  if (!Number.isInteger(majorCharacterLimit) || majorCharacterLimit < 1 || majorCharacterLimit > 50) return undefined;
  const pronunciation = recordBody(body.pronunciationProfile);
  if (
    body.catalogSnapshots.length > 100 ||
    body.suggestions.length > 10_000 ||
    body.sampleRequests.length > 10_000 ||
    body.approvals.length > 10_000 ||
    !Array.isArray(pronunciation?.rules) ||
    pronunciation.rules.length > 10_000
  )
    return undefined;
  const scopedRows = [
    ...body.catalogSnapshots,
    ...body.suggestions,
    ...body.sampleRequests,
    ...body.approvals,
    body.pronunciationProfile,
  ];
  if (scopedRows.some((item) => recordBody(item)?.novelId !== bookId)) return undefined;
  return value as VoiceProductStateV1;
}

export async function registerVoiceProductRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/voice-product', async (request, reply) => {
    const { bookId } = request.params;
    if (!(await bookExists(pool, config, bookId))) return reply.code(404).send({ error: 'book not found' });
    const [catalog, suggestions, samples, approvals, pronunciation, preferences] = await Promise.all([
      pool.query(
        'select payload from voice_catalog_snapshots where user_id = $1 and book_id = $2 order by captured_at',
        [config.defaultUserId, bookId],
      ),
      pool.query('select payload from voice_suggestions where user_id = $1 and book_id = $2 order by created_at', [
        config.defaultUserId,
        bookId,
      ]),
      pool.query('select payload from voice_sample_requests where user_id = $1 and book_id = $2 order by created_at', [
        config.defaultUserId,
        bookId,
      ]),
      pool.query('select payload from voice_sample_approvals where user_id = $1 and book_id = $2 order by updated_at', [
        config.defaultUserId,
        bookId,
      ]),
      pool.query('select payload from pronunciation_profiles where user_id = $1 and book_id = $2', [
        config.defaultUserId,
        bookId,
      ]),
      pool.query(
        'select minor_fallback_enabled, major_character_limit, updated_at from voice_product_preferences where user_id = $1 and book_id = $2',
        [config.defaultUserId, bookId],
      ),
    ]);
    const fallback = emptyVoiceProductState(bookId);
    const preference = preferences.rows[0] as Record<string, unknown> | undefined;
    return {
      state: {
        ...fallback,
        catalogSnapshots: catalog.rows
          .map((row) => payload<VoiceCatalogSnapshotV1>(row))
          .filter((item): item is VoiceCatalogSnapshotV1 => Boolean(item)),
        suggestions: suggestions.rows
          .map((row) => payload<VoiceSuggestionV1>(row))
          .filter((item): item is VoiceSuggestionV1 => Boolean(item)),
        sampleRequests: samples.rows
          .map((row) => payload<VoiceSampleRequestV1>(row))
          .filter((item): item is VoiceSampleRequestV1 => Boolean(item)),
        approvals: approvals.rows
          .map((row) => payload<VoiceSampleApprovalV1>(row))
          .filter((item): item is VoiceSampleApprovalV1 => Boolean(item)),
        pronunciationProfile: payload<PronunciationProfileV1>(pronunciation.rows[0]) ?? fallback.pronunciationProfile,
        minorFallbackEnabled: Boolean(preference?.minor_fallback_enabled),
        majorCharacterLimit: Number(preference?.major_character_limit ?? 5),
        updatedAt:
          preference?.updated_at instanceof Date
            ? preference.updated_at.toISOString()
            : typeof preference?.updated_at === 'string'
              ? preference.updated_at
              : fallback.updatedAt,
      } satisfies VoiceProductStateV1,
    };
  });

  app.put<{ Params: { bookId: string }; Body: { state?: unknown } }>(
    '/api/books/:bookId/voice-product',
    async (request, reply) => {
      const { bookId } = request.params;
      if (!(await bookExists(pool, config, bookId))) return reply.code(404).send({ error: 'book not found' });
      const state = validateState(recordBody(request.body)?.state, bookId);
      if (!state) return reply.code(400).send({ error: 'voice product state is invalid' });
      await withBookAITransaction(pool, async (client) => {
        await client.query('delete from voice_catalog_snapshots where user_id = $1 and book_id = $2', [
          config.defaultUserId,
          bookId,
        ]);
        for (const snapshot of state.catalogSnapshots) {
          await client.query(
            `insert into voice_catalog_snapshots
             (id, user_id, book_id, provider_id, model_id, fingerprint, payload, captured_at)
             values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
            [
              snapshot.id,
              config.defaultUserId,
              bookId,
              snapshot.providerId,
              snapshot.modelId ?? null,
              snapshot.fingerprint,
              JSON.stringify(snapshot),
              snapshot.capturedAt,
            ],
          );
          for (const entry of snapshot.entries) {
            await client.query(
              `insert into voice_catalog_entries
               (id, snapshot_id, book_id, provider_id, voice_id, fingerprint, available, payload)
               values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
              [
                entry.id,
                snapshot.id,
                bookId,
                snapshot.providerId,
                entry.voiceId,
                entry.fingerprint,
                entry.available,
                JSON.stringify(entry),
              ],
            );
          }
        }
        await client.query('delete from voice_suggestions where user_id = $1 and book_id = $2', [
          config.defaultUserId,
          bookId,
        ]);
        for (const item of state.suggestions)
          await client.query(
            `insert into voice_suggestions (id,user_id,book_id,voice_profile_id,character_id,major,payload,created_at)
             values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
            [
              item.id,
              config.defaultUserId,
              bookId,
              item.voiceProfileId,
              item.characterId ?? null,
              item.major,
              JSON.stringify(item),
              item.createdAt,
            ],
          );
        await client.query('delete from voice_sample_requests where user_id = $1 and book_id = $2', [
          config.defaultUserId,
          bookId,
        ]);
        for (const item of state.sampleRequests)
          await client.query(
            `insert into voice_sample_requests (id,user_id,book_id,voice_profile_id,kind,payload,created_at)
             values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
            [
              item.id,
              config.defaultUserId,
              bookId,
              item.voiceProfileId,
              item.kind,
              JSON.stringify(item),
              item.createdAt,
            ],
          );
        await client.query('delete from voice_sample_approvals where user_id = $1 and book_id = $2', [
          config.defaultUserId,
          bookId,
        ]);
        for (const item of state.approvals)
          await client.query(
            `insert into voice_sample_approvals
             (approval_id,user_id,book_id,voice_profile_id,decision,stale_reason,payload,updated_at)
             values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
            [
              item.approvalId,
              config.defaultUserId,
              bookId,
              item.voiceProfileId,
              item.decision,
              item.staleReason ?? null,
              JSON.stringify(item),
              item.approvedAt ?? state.updatedAt,
            ],
          );
        await client.query(
          `insert into pronunciation_profiles (id,user_id,book_id,revision,revision_id,payload,updated_at)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7)
           on conflict (id) do update set revision=excluded.revision, revision_id=excluded.revision_id,
             payload=excluded.payload, updated_at=excluded.updated_at`,
          [
            state.pronunciationProfile.id,
            config.defaultUserId,
            bookId,
            state.pronunciationProfile.revision,
            state.pronunciationProfile.revisionId,
            JSON.stringify(state.pronunciationProfile),
            state.pronunciationProfile.updatedAt,
          ],
        );
        await client.query(
          `insert into voice_product_preferences
           (book_id,user_id,minor_fallback_enabled,major_character_limit,updated_at)
           values ($1,$2,$3,$4,$5)
           on conflict (book_id) do update set minor_fallback_enabled=excluded.minor_fallback_enabled,
             major_character_limit=excluded.major_character_limit, updated_at=excluded.updated_at`,
          [bookId, config.defaultUserId, state.minorFallbackEnabled, state.majorCharacterLimit, state.updatedAt],
        );
      });
      return { ok: true, state };
    },
  );
}
