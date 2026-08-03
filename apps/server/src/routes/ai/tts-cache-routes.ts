import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { providerJobId, providerRequestIntegrityHash } from '@noveldesk/text-core/identity/provider';
import {
  ttsAudioIntegrityHash,
  ttsCacheKey,
  ttsInputTextIntegrityHash,
  ttsProviderOptionsIntegrityHash,
} from '@noveldesk/text-core/identity/tts';
import { persistentId128 } from '@noveldesk/text-core/hash';
import {
  normalizeTTSRenderSpec,
  ttsRenderSpecHash,
  type TTSRenderSpec,
} from '../../../../../src/providers/tts-render-spec';
import { providerJobAdmissionLimits, type ServerConfig } from '../../config.js';
import { enqueueProviderJob } from '../../queue.js';
import { loadServerAISettings } from '../../providers/server-ai-config.js';
import { listServerProviderCatalog } from '../../providers/server-provider-catalog.js';
import {
  hasSecretLikeKey,
  loadProviderSettingsBundle,
  modelFromSettings,
  providerEnabledBySettings,
  providerOptionsFromSettings,
} from '../../providers/server-provider-settings.js';
import { providerSecretStatusBundle } from '../../providers/server-provider-secrets.js';
import { createS3Client, getObjectBuffer } from '../../services/object-storage.js';
import { mapProviderJob } from './provider-job-contract.js';
import { preparePinnedTTSWorkflowJob } from '../../services/book-ai-workflow/tts-workflow-service.js';
import { withBookAITransaction } from '../../services/book-ai-workflow/transaction.js';
import { sendProviderJobAdmissionRejection } from './provider-admission-response.js';
import {
  resolveProviderTaskProfile,
  resolveTTSCapabilitySnapshot,
} from '../../../../../src/providers/provider-capability';
import { arrayOfStrings, numberField, optionalStringField, recordBody, stringField } from './request-contracts.js';
import {
  buildServerTTSRenderSpec,
  isServerTTSProviderId,
  mapTTSCacheItem,
  ttsBudgetModelForProvider,
  ttsSynthesisBudgetRejection,
  type TTSCacheRow,
  type TTSVoiceProfileResolveRow,
  voiceProfileForRenderSpec,
} from './tts-cache-contract.js';
import { chapterBookId } from './workflow-query-service.js';
import { ttsVoiceSampleSegmentId, ttsVoiceSampleText } from '../../../../../src/providers/tts-voice-samples';
import {
  insertTTSProviderJob,
  loadTTSProviderJob,
  requeueTTSProviderJob,
  type TTSProviderJobRow,
} from '../../services/book-ai-workflow/tts-job-repository.js';
import { hasStaleHostedTTSVoiceCasting } from '../../services/voice-casting-tts-guard.js';

export async function registerTTSCacheRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  providerQueue?: Queue,
): Promise<void> {
  app.post<{
    Params: { chapterId: string };
    Body: {
      providerId?: unknown;
      providerModel?: unknown;
      providerVersion?: unknown;
      voiceProfileId?: unknown;
      speakerId?: unknown;
      segmentIds?: unknown;
      inputTextHash?: unknown;
      sampleTextId?: unknown;
      renderSpec?: unknown;
      providerOptions?: unknown;
      audioCharacters?: unknown;
      force?: unknown;
    };
  }>('/api/chapters/:chapterId/tts-cache/resolve', async (request, reply) => {
    const body = recordBody(request.body);
    if (!body) return reply.code(400).send({ error: 'request body is required' });
    const providerId = stringField(body, 'providerId');
    const providerModel = optionalStringField(body, 'providerModel');
    const providerVersion = optionalStringField(body, 'providerVersion');
    const voiceProfileId = stringField(body, 'voiceProfileId');
    const speakerId = stringField(body, 'speakerId');
    const inputTextHash = stringField(body, 'inputTextHash');
    const sampleTextId = optionalStringField(body, 'sampleTextId');
    let requestedRenderSpec: TTSRenderSpec | undefined;
    try {
      requestedRenderSpec = body.renderSpec === undefined ? undefined : normalizeTTSRenderSpec(body.renderSpec);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'renderSpec is invalid' });
    }
    const segmentIds = body.segmentIds === undefined ? undefined : arrayOfStrings(body.segmentIds);
    const providerOptions = body.providerOptions === undefined ? {} : recordBody(body.providerOptions);
    const audioCharacters = numberField(body, 'audioCharacters', 0);
    const force = body.force === true;

    if (!isServerTTSProviderId(providerId)) return reply.code(400).send({ error: 'providerId is invalid' });
    if (providerId === 'system') return reply.code(400).send({ error: 'system TTS is not cacheable on the server' });
    if (!voiceProfileId) return reply.code(400).send({ error: 'voiceProfileId is required' });
    if (!speakerId) return reply.code(400).send({ error: 'speakerId is required' });
    if (!inputTextHash) return reply.code(400).send({ error: 'inputTextHash is required' });
    if (!segmentIds || segmentIds.length === 0)
      return reply.code(400).send({ error: 'segmentIds must be a non-empty string array' });
    const sampleText = sampleTextId ? ttsVoiceSampleText(sampleTextId) : undefined;
    if (sampleTextId && !sampleText) return reply.code(400).send({ error: 'sampleTextId is invalid' });
    if (sampleTextId && (segmentIds.length !== 1 || segmentIds[0] !== ttsVoiceSampleSegmentId(sampleTextId))) {
      return reply.code(400).send({ error: 'sample segment anchor is invalid' });
    }
    if (sampleText && ttsInputTextIntegrityHash(sampleText) !== inputTextHash) {
      return reply.code(400).send({ error: 'sample inputTextHash is invalid' });
    }
    if (!providerOptions) return reply.code(400).send({ error: 'providerOptions must be an object' });
    if (hasSecretLikeKey(providerOptions))
      return reply.code(400).send({ error: 'providerOptions must not contain secret-like keys or values' });
    if (!Number.isFinite(audioCharacters) || audioCharacters < 0)
      return reply.code(400).send({ error: 'audioCharacters is invalid' });
    const baseCatalog = listServerProviderCatalog(process.env, loadServerAISettings());
    const baseTTSProvider = baseCatalog.ttsProviders.find((provider) => provider.providerId === providerId);
    if (!baseTTSProvider) return reply.code(400).send({ error: 'providerId is invalid' });
    if (!baseTTSProvider.implemented)
      return reply.code(400).send({ error: 'TTS provider is not implemented on this server yet' });
    const earlyBudgetRejection = ttsSynthesisBudgetRejection({
      budgetModel: ttsBudgetModelForProvider(baseTTSProvider, providerModel),
      segmentCount: segmentIds.length,
      audioCharacters,
    });
    if (earlyBudgetRejection) return reply.code(413).send(earlyBudgetRejection);
    const ttsProvider = (
      await providerSecretStatusBundle(pool, config, baseCatalog, process.env)
    ).catalog.ttsProviders.find((provider) => provider.providerId === providerId);
    if (!ttsProvider?.secretConfigured)
      return reply.code(400).send({ error: 'TTS provider secret is not configured on this server yet' });
    const ttsSettings = (await loadProviderSettingsBundle(pool, config, process.env, loadServerAISettings()))
      .ttsSynthesis;
    if (!providerEnabledBySettings(ttsSettings, providerId)) {
      return reply.code(400).send({ error: 'TTS provider is disabled by saved provider settings' });
    }

    const bookId = await chapterBookId(pool, config, request.params.chapterId);
    if (!bookId) return reply.code(404).send({ error: 'chapter not found' });
    const voiceProfileResult = await pool.query<TTSVoiceProfileResolveRow>(
      `
          select id, book_id, character_id, role, provider_id, provider_voice_id, provider_model,
                 label, language, tone, speed, pitch, emotion_policy, provider_options,
                 is_user_selected, created_at, updated_at
          from voice_profiles
          where id = $1 and book_id = $2
        `,
      [voiceProfileId, bookId],
    );
    const voiceProfile = voiceProfileResult.rows[0];
    if (!voiceProfile) return reply.code(404).send({ error: 'voice profile not found' });
    if (voiceProfile.provider_id !== providerId) {
      return reply.code(400).send({ error: 'voice profile provider does not match requested TTS provider' });
    }
    if (
      !sampleTextId &&
      (await hasStaleHostedTTSVoiceCasting(pool, {
        userId: config.defaultUserId,
        bookId,
        chapterId: request.params.chapterId,
        segmentIds,
        speakerId,
        voiceProfileId,
        requestedProviderId: voiceProfile.provider_id,
      }))
    ) {
      return reply.code(409).send({ error: 'voice_casting_stale', code: 'voice_casting_stale' });
    }

    const catalogProviderModel = ttsProvider.models.find((model) => model.enabled)?.modelId;
    const resolvedProviderModel =
      providerModel ??
      voiceProfile.provider_model ??
      modelFromSettings(ttsSettings, providerId) ??
      catalogProviderModel ??
      undefined;
    const budgetModel = ttsBudgetModelForProvider(ttsProvider, resolvedProviderModel);
    const resolvedBudgetRejection = ttsSynthesisBudgetRejection({
      budgetModel,
      segmentCount: segmentIds.length,
      audioCharacters,
    });
    if (resolvedBudgetRejection) return reply.code(413).send(resolvedBudgetRejection);
    const resolvedProviderOptions = {
      ...providerOptionsFromSettings(ttsSettings, providerId),
      ...providerOptions,
    };
    const optionsHash = ttsProviderOptionsIntegrityHash(resolvedProviderOptions);
    const capabilitySnapshot = resolveTTSCapabilitySnapshot({
      providerId,
      modelId: resolvedProviderModel,
      providerOptions: {
        ...resolvedProviderOptions,
        maxInputCharacters: budgetModel?.maxInputCharacters,
        maxInputSegments: budgetModel?.maxInputSegments,
      },
    });
    const taskProfileSnapshot = resolveProviderTaskProfile({
      jobType: 'tts_synthesis',
      requestProfile: {
        id: 'tts-synthesis-v1',
        promptVersion: 'tts-synthesis-v1',
        schemaVersion: 'tts-synthesis-v1',
      },
      providerId,
      modelId: resolvedProviderModel,
      providerOptions: resolvedProviderOptions,
    });
    let renderSpec: TTSRenderSpec;
    try {
      renderSpec = buildServerTTSRenderSpec({
        bookId,
        chapterId: request.params.chapterId,
        providerId,
        providerModel: resolvedProviderModel,
        providerVersion,
        voiceProfile,
        speakerId,
        segmentIds,
        inputTextHash,
        optionsHash,
        requestedRenderSpec,
        providerOptions: resolvedProviderOptions,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'renderSpec is invalid' });
    }
    const renderSpecHash = ttsRenderSpecHash(renderSpec);
    const cacheKey = ttsCacheKey({
      novelId: bookId,
      chapterId: request.params.chapterId,
      segmentIds,
      speakerId,
      voiceProfileId,
      providerId,
      providerModel: resolvedProviderModel ?? '',
      providerVersion: providerVersion ?? '',
      inputTextHash,
      optionsHash,
      renderSpecHash,
    });
    const cached = await pool.query<TTSCacheRow>(
      `
          select id, book_id, chapter_id, cache_key, provider_id, provider_model, provider_version,
                 voice_profile_id, speaker_id, segment_ids, input_text_hash, options_hash,
                 audio_object_key, content_type, byte_size, audio_hash, duration_ms, created_at, updated_at,
                 render_fingerprint, voice_entry_fingerprint, pronunciation_revision_id, integrity_state, stale_at
          from tts_audio_cache
          where cache_key = $1 and book_id = $2 and chapter_id = $3
            and lifecycle_state = 'active'
            and integrity_state = 'verified'
            and stale_at is null
        `,
      [cacheKey, bookId, request.params.chapterId],
    );
    const cachedItem = cached.rows[0] ? mapTTSCacheItem(cached.rows[0]) : undefined;
    if (cachedItem && !force) return { cacheHit: true, cacheKey, optionsHash, cacheItem: cachedItem };

    const inputHash = providerRequestIntegrityHash({
      bookId,
      chapterId: request.params.chapterId,
      jobType: 'tts_synthesis',
      providerId,
      providerModel: resolvedProviderModel ?? '',
      providerVersion: providerVersion ?? '',
      voiceProfileId,
      speakerId,
      segmentIds,
      inputTextHash,
      optionsHash,
      renderSpecHash,
      cacheKey,
      capabilitySnapshotId: capabilitySnapshot.id,
      taskProfileId: taskProfileSnapshot.id,
      sampleTextId: sampleTextId ?? '',
    });
    const jobId = providerJobId({
      userId: config.defaultUserId,
      novelId: bookId,
      chapterId: request.params.chapterId,
      jobType: 'tts_synthesis',
      providerId,
      modelId: resolvedProviderModel,
      inputHash,
    });
    const renderPlanId = persistentId128('tts_render_plan_v2', [bookId, request.params.chapterId, renderSpecHash]);
    const renderItemId = persistentId128('tts_render_item_v2', [renderPlanId, renderSpecHash]);
    const progress = {
      budgetEstimate: {
        providerId,
        modelId: resolvedProviderModel,
        audioCharacters,
        inputCharacters: audioCharacters,
        segmentCount: segmentIds.length,
        maxInputCharacters: budgetModel?.maxInputCharacters,
        maxInputSegments: budgetModel?.maxInputSegments,
        cacheHit: false,
        renderSpecHash,
        capabilitySnapshotId: capabilitySnapshot.id,
      },
      capabilitySnapshot,
      taskProfileSnapshot,
      renderLifecycle: {
        planFingerprint: renderSpecHash,
        state: 'queued',
        planned: 1,
        cacheHit: 0,
        queued: 1,
        running: 0,
        succeeded: 0,
        failed: 0,
        unknown: 0,
        corrupt: 0,
        retryableItemIds: [],
      },
      ttsCache: {
        cacheKey,
        voiceProfileId,
        speakerId,
        segmentIds,
        inputTextHash,
        optionsHash,
        renderSpecHash,
        renderSpec,
        renderPlanId,
        renderItemId,
        sampleTextId,
        cachePurpose: sampleTextId ? 'voice_sample' : 'reading',
        providerOptions: resolvedProviderOptions,
      },
    };
    const row = await withBookAITransaction(pool, async (client) => {
      let prepared: TTSProviderJobRow;
      if (sampleTextId) {
        await client.query(
          `insert into provider_capability_snapshots
           (id,user_id,capability_kind,provider_id,requested_model_id,resolved_model_version,
            source,freshness,fingerprint,payload,verified_at,expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
           on conflict (id) do nothing`,
          [
            capabilitySnapshot.id,
            config.defaultUserId,
            capabilitySnapshot.kind,
            capabilitySnapshot.providerId,
            capabilitySnapshot.requestedModelId,
            capabilitySnapshot.resolvedModelVersion ?? null,
            capabilitySnapshot.source,
            capabilitySnapshot.freshness,
            capabilitySnapshot.fingerprint,
            JSON.stringify(capabilitySnapshot),
            capabilitySnapshot.verifiedAt,
            capabilitySnapshot.expiresAt ?? null,
          ],
        );
        const jobInput = {
          id: jobId,
          userId: config.defaultUserId,
          bookId,
          chapterId: request.params.chapterId,
          providerId,
          modelId: resolvedProviderModel,
          inputHash,
          progress,
        };
        let sampleJob = await loadTTSProviderJob(client, jobInput);
        if (!sampleJob) sampleJob = await insertTTSProviderJob(client, jobInput);
        if (!sampleJob) sampleJob = await loadTTSProviderJob(client, jobInput);
        if (!sampleJob) throw new Error('TTS sample provider job could not be created');
        if (
          sampleJob.status === 'failed' ||
          sampleJob.status === 'cancelled' ||
          (force && sampleJob.status === 'succeeded')
        ) {
          sampleJob = (await requeueTTSProviderJob(client, sampleJob, config.defaultUserId, progress)) ?? sampleJob;
        }
        prepared = sampleJob;
      } else {
        prepared = await preparePinnedTTSWorkflowJob(client, {
          id: jobId,
          userId: config.defaultUserId,
          bookId,
          chapterId: request.params.chapterId,
          providerId,
          modelId: resolvedProviderModel,
          inputHash,
          progress,
          force,
          cacheKey,
          renderSpec,
          renderSpecHash,
          voiceProfile: voiceProfileForRenderSpec(voiceProfile),
          providerOptions: resolvedProviderOptions,
          capabilitySnapshot,
          taskProfileSnapshot,
        });
      }
      await client.query(
        `insert into tts_render_plans_v2
         (id,user_id,book_id,chapter_id,capability_snapshot_id,fingerprint,status,payload,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now(),now())
         on conflict (id) do update set status = excluded.status, payload = excluded.payload, updated_at = now()`,
        [
          renderPlanId,
          config.defaultUserId,
          bookId,
          request.params.chapterId,
          capabilitySnapshot.id,
          renderSpecHash,
          prepared.status === 'succeeded' ? 'audio_cache_ready' : 'queued',
          JSON.stringify({ renderPlanId, renderSpecHash, capabilitySnapshotId: capabilitySnapshot.id, itemCount: 1 }),
        ],
      );
      await client.query(
        `insert into tts_render_items_v2
         (id,plan_id,book_id,chapter_id,sequence,render_fingerprint,lifecycle_state,provider_job_id,cache_key,payload,updated_at)
         values ($1,$2,$3,$4,0,$5,$6,$7,$8,$9::jsonb,now())
         on conflict (id) do update set lifecycle_state = excluded.lifecycle_state,
           provider_job_id = excluded.provider_job_id, cache_key = excluded.cache_key,
           payload = excluded.payload, updated_at = now()`,
        [
          renderItemId,
          renderPlanId,
          bookId,
          request.params.chapterId,
          renderSpecHash,
          prepared.status === 'succeeded' ? 'cache_hit' : 'queued',
          prepared.id,
          cacheKey,
          JSON.stringify({ renderItemId, renderFingerprint: renderSpecHash, renderSpec }),
        ],
      );
      return prepared;
    });
    if (row.status === 'queued' && providerQueue) {
      try {
        await enqueueProviderJob(pool, providerQueue, row.id, providerJobAdmissionLimits(config));
      } catch (error) {
        const rejection = sendProviderJobAdmissionRejection(reply, error);
        if (rejection) return rejection;
        throw error;
      }
    }
    return reply.code(row.status === 'queued' ? 202 : 200).send({
      cacheHit: false,
      cacheKey,
      optionsHash,
      cacheItem: cachedItem,
      job: mapProviderJob(row),
    });
  });

  app.get<{ Params: { chapterId: string; cacheKey: string } }>(
    '/api/chapters/:chapterId/tts-cache/:cacheKey/audio',
    async (request, reply) => {
      const bookId = await chapterBookId(pool, config, request.params.chapterId);
      if (!bookId) return reply.code(404).send({ error: 'chapter not found' });
      const cached = await pool.query<TTSCacheRow>(
        `
            select c.id, c.book_id, c.chapter_id, c.cache_key, c.provider_id, c.provider_model, c.provider_version,
                   c.voice_profile_id, c.speaker_id, c.segment_ids, c.input_text_hash, c.options_hash,
                   c.audio_object_key, c.content_type, c.byte_size, c.audio_hash, c.duration_ms,
                   c.created_at, c.updated_at, c.integrity_state, c.pronunciation_revision_id,
                   c.voice_entry_fingerprint, c.stale_at
            from tts_audio_cache c
            join library_books b on b.id = c.book_id
            join voice_profiles vp on vp.id = c.voice_profile_id and vp.book_id = c.book_id
            left join pronunciation_profiles pp on pp.book_id = c.book_id and pp.user_id = b.user_id
            where c.cache_key = $1 and c.book_id = $2 and c.chapter_id = $3
              and c.lifecycle_state = 'active'
              and c.integrity_state = 'verified'
              and c.stale_at is null
              and c.updated_at >= vp.updated_at
              and (c.cache_purpose = 'voice_sample' or c.content_revision_id = b.active_content_revision_id)
              and (
                pp.id is null
                or (pp.revision = 0 and c.pronunciation_revision_id is null)
                or c.pronunciation_revision_id = pp.revision_id
              )
              and (
                c.voice_entry_fingerprint is null
                or not exists (
                  select 1 from voice_catalog_snapshots current_catalog
                  where current_catalog.book_id = c.book_id
                    and current_catalog.provider_id = c.provider_id
                    and (current_catalog.model_id is null or current_catalog.model_id is not distinct from c.provider_model)
                )
                or exists (
                  select 1
                  from voice_catalog_entries current_voice
                  join voice_catalog_snapshots current_catalog on current_catalog.id = current_voice.snapshot_id
                  where current_voice.book_id = c.book_id
                    and current_voice.provider_id = c.provider_id
                    and current_voice.voice_id = vp.provider_voice_id
                    and current_voice.fingerprint = c.voice_entry_fingerprint
                    and current_voice.available
                    and (current_catalog.model_id is null or current_catalog.model_id is not distinct from c.provider_model)
                )
              )
          `,
        [request.params.cacheKey, bookId, request.params.chapterId],
      );
      const row = cached.rows[0];
      if (!row) return reply.code(404).send({ error: 'TTS cache item not found' });
      let object;
      try {
        object = await getObjectBuffer(createS3Client(config), config, row.audio_object_key);
      } catch {
        const reason = 'playback_object_missing';
        await pool.query(
          `with quarantined as (
             update tts_audio_cache
             set integrity_state = 'quarantined', quarantine_reason = $2,
                 gc_after = now() + interval '7 days', updated_at = now()
             where id = $1
             returning id, book_id
           )
           insert into tts_audio_quarantine_v2 (id, cache_id, book_id, reason, evidence)
           select $3, id, book_id, $2, $4::jsonb from quarantined
           on conflict (id) do nothing`,
          [
            row.id,
            reason,
            persistentId128('tts_audio_quarantine_v2', [row.id, reason]),
            JSON.stringify({ objectKeyFingerprint: persistentId128('tts_object_key', [row.audio_object_key]) }),
          ],
        );
        return reply.code(409).send({ error: 'TTS cache audio object is missing' });
      }
      const actualHash = ttsAudioIntegrityHash(object.body);
      const integrityMismatch =
        object.body.byteLength <= 0 ||
        (row.byte_size !== null && row.byte_size !== object.body.byteLength) ||
        (row.audio_hash !== null && row.audio_hash !== actualHash) ||
        !(object.contentType ?? row.content_type ?? '').startsWith('audio/');
      if (integrityMismatch) {
        const reason = 'playback_integrity_mismatch';
        await pool.query(
          `with quarantined as (
             update tts_audio_cache
             set integrity_state = 'quarantined', quarantine_reason = $2,
                 gc_after = now() + interval '7 days', updated_at = now()
             where id = $1
             returning id, book_id
           )
           insert into tts_audio_quarantine_v2 (id, cache_id, book_id, reason, evidence)
           select $3, id, book_id, $2, $4::jsonb from quarantined
           on conflict (id) do nothing`,
          [
            row.id,
            reason,
            persistentId128('tts_audio_quarantine_v2', [row.id, row.audio_hash ?? '', actualHash]),
            JSON.stringify({
              expectedHash: row.audio_hash,
              actualHash,
              expectedSize: row.byte_size,
              actualSize: object.body.byteLength,
            }),
          ],
        );
        return reply.code(409).send({ error: 'TTS cache audio failed integrity verification' });
      }
      await pool.query('update tts_audio_cache set last_accessed_at = now() where id = $1', [row.id]);
      reply.header('Content-Type', object.contentType ?? row.content_type ?? 'application/octet-stream');
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('Content-Length', String(object.body.byteLength));
      return reply.send(object.body);
    },
  );
}
