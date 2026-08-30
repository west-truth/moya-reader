import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { hasSecretLikeKey } from '../../providers/server-provider-settings.js';
import { resolveProviderSecrets } from '../../providers/server-provider-secrets.js';
import { createServerTTSSynthesisProvider } from '../../providers/server-tts-provider-factory.js';
import { matchesIntegrityHash } from '@noveldesk/text-core/hash';
import { segmentTextIntegrityHash } from '@noveldesk/text-core/identity/ai';
import {
  ttsAudioCacheRowId,
  ttsAudioIntegrityHash,
  ttsInputTextIntegrityHash,
  ttsProviderOptionsIntegrityHash,
} from '@noveldesk/text-core/identity/tts';
import {
  matchesTTSRenderSpecHash,
  normalizeTTSRenderSpec,
  ttsRenderSpecHash,
  type TTSRenderSpec,
} from '../../../../../src/providers/tts-render-spec';
import { probeTTSAudioContainer } from '../../../../../src/providers/tts-lifecycle-v2';
import { ttsVoiceSampleText } from '../../../../../src/providers/tts-voice-samples';
import { createS3Client, deleteObject, putTtsAudioObject } from '../object-storage.js';
import {
  ProviderJobCancelledError,
  type ProviderJobRow,
  type ProviderJobServiceDeps,
  type TTSCacheProgress,
  type TTSSegmentTextRow,
} from './contracts.js';
import { loadTTSSegmentTextRows, loadVoiceProfile } from './job-data-loader.js';
import {
  assertProviderJobNotCancelled,
  lockProviderJobForPersistence,
  updateProviderJobProgress,
} from './job-lifecycle.js';
import { recordValue, stringArrayValue } from './job-progress.js';
import { AnalysisInputStaleError, type AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import {
  assertPinnedRenderSpec,
  verifyAnalysisInputBeforeExecution,
} from '../book-ai-workflow/analysis-input-verification.js';
import { lockImageSeriesBookLifecycle } from '../book-operation-lock.js';

function parseTTSCacheProgress(progress: unknown): TTSCacheProgress {
  const root = recordValue(progress);
  const ttsCache = recordValue(root?.ttsCache);
  const cacheKey = typeof ttsCache?.cacheKey === 'string' ? ttsCache.cacheKey : '';
  const voiceProfileId = typeof ttsCache?.voiceProfileId === 'string' ? ttsCache.voiceProfileId : '';
  const speakerId = typeof ttsCache?.speakerId === 'string' ? ttsCache.speakerId : '';
  const inputTextHash = typeof ttsCache?.inputTextHash === 'string' ? ttsCache.inputTextHash : '';
  const optionsHash = typeof ttsCache?.optionsHash === 'string' ? ttsCache.optionsHash : '';
  const segmentIds = stringArrayValue(ttsCache?.segmentIds);
  const renderSpec = ttsCache?.renderSpec === undefined ? undefined : normalizeTTSRenderSpec(ttsCache.renderSpec);
  const renderSpecHash = typeof ttsCache?.renderSpecHash === 'string' ? ttsCache.renderSpecHash : undefined;
  const renderPlanId = typeof ttsCache?.renderPlanId === 'string' ? ttsCache.renderPlanId : undefined;
  const renderItemId = typeof ttsCache?.renderItemId === 'string' ? ttsCache.renderItemId : undefined;
  const sampleTextId = typeof ttsCache?.sampleTextId === 'string' ? ttsCache.sampleTextId : undefined;
  const cachePurpose = sampleTextId ? 'voice_sample' : 'reading';
  const providerOptions = recordValue(ttsCache?.providerOptions) ?? {};
  if (!cacheKey || !voiceProfileId || !speakerId || !inputTextHash || !optionsHash || segmentIds.length === 0) {
    throw new Error('tts_synthesis job progress is missing cache metadata');
  }
  if (renderSpecHash && !renderSpec) {
    throw new Error('tts_synthesis job renderSpecHash is missing renderSpec');
  }
  if (renderSpec) {
    if (!renderSpecHash) {
      throw new Error('tts_synthesis job renderSpecHash is missing renderSpec hash');
    }
    if (!matchesTTSRenderSpecHash(renderSpecHash, renderSpec)) {
      throw new Error('tts_synthesis job renderSpecHash does not match renderSpec');
    }
    if (renderSpec.voiceProfileId !== voiceProfileId || renderSpec.speakerId !== speakerId) {
      throw new Error('tts_synthesis job renderSpec metadata does not match cache metadata');
    }
    const renderSegmentIds = renderSpec.segmentAnchors.map((anchor) => anchor.segmentId);
    if (JSON.stringify(renderSegmentIds) !== JSON.stringify(segmentIds)) {
      throw new Error('tts_synthesis job renderSpec segment anchors do not match segmentIds');
    }
  }
  return {
    cacheKey,
    voiceProfileId,
    speakerId,
    segmentIds,
    inputTextHash,
    optionsHash,
    renderSpec,
    renderSpecHash,
    renderPlanId,
    renderItemId,
    sampleTextId,
    cachePurpose,
    providerOptions,
  };
}

function renderLifecycleProgress(
  progress: unknown,
  state: 'queued' | 'synthesizing' | 'cache_hit' | 'verified',
): Record<string, unknown> {
  const root = recordValue(progress);
  const current = recordValue(root?.renderLifecycle) ?? {};
  return {
    ...current,
    state,
    planned: 1,
    cacheHit: state === 'cache_hit' ? 1 : 0,
    queued: state === 'queued' ? 1 : 0,
    running: state === 'synthesizing' ? 1 : 0,
    succeeded: state === 'cache_hit' || state === 'verified' ? 1 : 0,
    failed: 0,
    unknown: 0,
    corrupt: 0,
    retryableItemIds: [],
  };
}

function positiveBudgetNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function enforceTTSSynthesisBudget(progress: unknown, inputCharacters: number, segmentCount: number): void {
  const budget = recordValue(recordValue(progress)?.budgetEstimate);
  const maxInputSegments = positiveBudgetNumber(budget?.maxInputSegments);
  if (maxInputSegments !== undefined && segmentCount > maxInputSegments) {
    throw new Error(`TTS synthesis segment budget exceeded: ${segmentCount} > ${maxInputSegments}`);
  }
  const maxInputCharacters = positiveBudgetNumber(budget?.maxInputCharacters);
  if (maxInputCharacters !== undefined && inputCharacters > maxInputCharacters) {
    throw new Error(`TTS synthesis character budget exceeded: ${inputCharacters} > ${maxInputCharacters}`);
  }
}

function audioObjectKey(
  bookId: string,
  contentRevisionId: string,
  chapterId: string,
  cacheKey: string,
  contentType: string,
): string {
  return `tts/${bookId}/${contentRevisionId}/${chapterId}/${cacheKey}${extensionForContentType(contentType)}`;
}

async function resolveTTSContentRevisionId(
  pool: pg.Pool,
  job: ProviderJobRow,
  inputRevision: AnalysisInputRevision | undefined,
): Promise<string> {
  if (inputRevision?.contentRevisionId) return inputRevision.contentRevisionId;
  const result = await pool.query<{ active_content_revision_id: string }>(
    `select active_content_revision_id
       from library_books
      where id = $1 and user_id = $2 and deleted_at is null`,
    [job.book_id, job.user_id],
  );
  const contentRevisionId = result.rows[0]?.active_content_revision_id;
  if (!contentRevisionId) throw new Error(`TTS target book is no longer active: ${job.book_id}`);
  return contentRevisionId;
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return '.wav';
  if (normalized === 'audio/pcm') return '.pcm';
  if (normalized === 'audio/opus' || normalized === 'audio/ogg') return '.opus';
  if (normalized === 'audio/aac') return '.aac';
  if (normalized === 'audio/flac') return '.flac';
  return '.mp3';
}

function bufferFromArrayBuffer(value: ArrayBuffer): Buffer {
  return Buffer.from(value);
}

function validateTTSRenderSpecRows(renderSpec: TTSRenderSpec | undefined, rows: TTSSegmentTextRow[]): void {
  if (!renderSpec) return;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const anchor of renderSpec.segmentAnchors) {
    const row = rowById.get(anchor.segmentId);
    if (!row) throw new Error(`TTS render spec segment not found: ${anchor.segmentId}`);
    if (anchor.paragraphId !== undefined && anchor.paragraphId !== row.paragraph_id) {
      throw new Error(`TTS render spec paragraph mismatch for ${anchor.segmentId}`);
    }
    if (anchor.startOffset !== undefined && anchor.startOffset !== Number(row.start_offset)) {
      throw new Error(`TTS render spec start offset mismatch for ${anchor.segmentId}`);
    }
    if (anchor.endOffset !== undefined && anchor.endOffset !== Number(row.end_offset)) {
      throw new Error(`TTS render spec end offset mismatch for ${anchor.segmentId}`);
    }
    if (anchor.segmentTextHash !== undefined) {
      const segmentText = row.text.slice(Number(row.start_offset), Number(row.end_offset));
      if (
        !matchesIntegrityHash(anchor.segmentTextHash, segmentText) ||
        !matchesIntegrityHash(row.segment_text_hash, segmentText)
      ) {
        throw new Error(`TTS render spec text hash mismatch for ${anchor.segmentId}`);
      }
    }
  }
}

function reconstructTTSText(rows: TTSSegmentTextRow[]): string {
  return rows
    .map((row) => {
      const start = Number(row.start_offset);
      const end = Number(row.end_offset);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > row.text.length) {
        throw new Error(`Invalid TTS segment offsets for ${row.id}`);
      }
      return row.text.slice(start, end);
    })
    .join('\n');
}

function segmentTextHashesFromRows(rows: TTSSegmentTextRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      segmentTextIntegrityHash(row.text.slice(Number(row.start_offset), Number(row.end_offset))),
    ]),
  );
}

async function ttsCacheExists(pool: pg.Pool, job: ProviderJobRow, cacheKey: string): Promise<boolean> {
  if (!job.chapter_id) throw new Error(`Provider job ${job.id} does not target a chapter`);
  const result = await pool.query(
    `
      select id
      from tts_audio_cache
      where cache_key = $1 and book_id = $2 and chapter_id = $3
        and lifecycle_state = 'active'
        and integrity_state = 'verified'
        and stale_at is null
    `,
    [cacheKey, job.book_id, job.chapter_id],
  );
  return Boolean(result.rows[0]);
}

export async function processTTSJob(
  pool: pg.Pool,
  config: ServerConfig,
  job: ProviderJobRow,
  deps: ProviderJobServiceDeps,
  signal?: AbortSignal,
  inputRevision?: AnalysisInputRevision,
): Promise<void> {
  if (!job.chapter_id) throw new Error(`Provider job ${job.id} does not target a chapter`);
  const ttsCache = parseTTSCacheProgress(job.progress);
  const contentRevisionId = await resolveTTSContentRevisionId(pool, job, inputRevision);
  if (inputRevision) {
    if (inputRevision.sourceSnapshot.kind !== 'tts_synthesis' || !inputRevision.renderSpec) {
      throw new AnalysisInputStaleError('analysis_render_spec_stale', `Pinned TTS input is invalid: ${job.id}`);
    }
    assertPinnedRenderSpec(inputRevision, ttsCache.renderSpec ?? inputRevision.renderSpec);
    if (ttsProviderOptionsIntegrityHash(inputRevision.providerOptions) !== ttsCache.optionsHash) {
      throw new AnalysisInputStaleError('analysis_render_spec_stale', `Pinned TTS provider options changed: ${job.id}`);
    }
    ttsCache.providerOptions = { ...inputRevision.providerOptions };
    await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  }
  await updateProviderJobProgress(pool, job, {
    stage: 'loading_tts_input',
    progress: {
      ...recordValue(job.progress),
      ttsCache,
      loaded: false,
      renderLifecycle: renderLifecycleProgress(job.progress, 'queued'),
    },
  });
  await assertProviderJobNotCancelled(pool, job);

  if (!inputRevision && (await ttsCacheExists(pool, job, ttsCache.cacheKey))) {
    await updateProviderJobProgress(pool, job, {
      status: 'succeeded',
      stage: 'ready',
      progress: {
        ...recordValue(job.progress),
        ttsCache,
        budgetEstimate: { cacheHit: true },
        renderLifecycle: renderLifecycleProgress(job.progress, 'cache_hit'),
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: true,
    });
    return;
  }

  const [liveVoiceProfile, rows] = await Promise.all([
    loadVoiceProfile(pool, job, ttsCache.voiceProfileId),
    ttsCache.sampleTextId
      ? Promise.resolve([])
      : loadTTSSegmentTextRows(pool, job, ttsCache.segmentIds, ttsCache.renderSpec),
  ]);
  const voiceProfile = inputRevision?.voiceProfileSnapshot ?? liveVoiceProfile;
  if (
    inputRevision?.voiceProfileSnapshot &&
    (liveVoiceProfile.updatedAt !== inputRevision.voiceProfileSnapshot.updatedAt ||
      liveVoiceProfile.providerId !== inputRevision.voiceProfileSnapshot.providerId ||
      liveVoiceProfile.providerVoiceId !== inputRevision.voiceProfileSnapshot.providerVoiceId)
  ) {
    throw new AnalysisInputStaleError(
      'analysis_render_spec_stale',
      `Voice profile changed before synthesis: ${job.id}`,
    );
  }
  if (hasSecretLikeKey(voiceProfile.providerOptions) || hasSecretLikeKey(ttsCache.providerOptions)) {
    throw new Error('TTS provider options must not contain secret-like keys or values');
  }
  const liveText = ttsCache.sampleTextId ? ttsVoiceSampleText(ttsCache.sampleTextId) : reconstructTTSText(rows);
  if (!liveText) throw new Error('TTS voice sample text is not registered');
  const text = inputRevision?.sourceSnapshot.kind === 'tts_synthesis' ? inputRevision.sourceSnapshot.text : liveText;
  if (inputRevision && text !== liveText) {
    throw new AnalysisInputStaleError('analysis_source_stale', `TTS source text changed before synthesis: ${job.id}`);
  }
  if (inputRevision && (await ttsCacheExists(pool, job, ttsCache.cacheKey))) {
    await updateProviderJobProgress(pool, job, {
      status: 'succeeded',
      stage: 'ready',
      progress: {
        ...recordValue(job.progress),
        ttsCache,
        budgetEstimate: { cacheHit: true },
        renderLifecycle: renderLifecycleProgress(job.progress, 'cache_hit'),
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: true,
    });
    return;
  }
  if (!ttsCache.sampleTextId) validateTTSRenderSpecRows(ttsCache.renderSpec, rows);
  const reconstructedTextHash = ttsInputTextIntegrityHash(text);
  if (!matchesIntegrityHash(ttsCache.inputTextHash, text)) {
    throw new Error(`TTS input text hash mismatch: expected ${ttsCache.inputTextHash}, got ${reconstructedTextHash}`);
  }
  if (ttsCache.renderSpec && !matchesIntegrityHash(ttsCache.renderSpec.inputTextHash, text)) {
    throw new Error('TTS render spec input text hash does not match reconstructed text');
  }
  const canonicalOptionsHash = ttsProviderOptionsIntegrityHash(ttsCache.providerOptions);
  const canonicalRenderSpecHash = ttsCache.renderSpec ? ttsRenderSpecHash(ttsCache.renderSpec) : undefined;
  enforceTTSSynthesisBudget(job.progress, text.length, Math.max(1, rows.length));

  await updateProviderJobProgress(pool, job, {
    stage: 'synthesizing_tts',
    progress: {
      ...recordValue(job.progress),
      ttsCache,
      inputCharacters: text.length,
      segmentCount: rows.length,
      renderLifecycle: renderLifecycleProgress(job.progress, 'synthesizing'),
    },
  });
  await assertProviderJobNotCancelled(pool, job);
  const provider =
    deps.createTTSProvider?.({ providerId: job.provider_id, modelId: job.model_id }) ??
    createServerTTSSynthesisProvider({
      providerId: job.provider_id,
      modelId: job.model_id,
      secrets: await resolveProviderSecrets(pool, config, 'tts_synthesis', job.provider_id),
    });
  if (inputRevision) {
    const callRenderSpec = ttsCache.renderSpec ?? inputRevision.renderSpec;
    if (!callRenderSpec) {
      throw new AnalysisInputStaleError('analysis_render_spec_stale', `Pinned TTS render spec is missing: ${job.id}`);
    }
    assertPinnedRenderSpec(inputRevision, callRenderSpec);
    await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  }
  await deps.beforeProviderDispatch?.();
  const result = await provider.synthesize({
    text,
    voiceProfile,
    emotion: ttsCache.renderSpec?.emotion ?? rows.find((row) => row.emotion && row.emotion !== 'neutral')?.emotion,
    tone: ttsCache.renderSpec?.tone ?? voiceProfile.tone,
    speed: ttsCache.renderSpec?.speed ?? voiceProfile.speed,
    format: ttsCache.renderSpec?.format ?? 'mp3',
    providerOptions: ttsCache.providerOptions,
    signal,
  });
  await assertProviderJobNotCancelled(pool, job);
  const audio = bufferFromArrayBuffer(result.audio);
  const contentType = result.contentType || 'audio/mpeg';
  const audioProbe = probeTTSAudioContainer(audio, contentType);
  if (!audioProbe.ok) throw new Error(`TTS audio integrity check failed: ${audioProbe.reason}`);
  const objectKey = audioObjectKey(job.book_id, contentRevisionId, job.chapter_id, ttsCache.cacheKey, contentType);
  const audioHash = ttsAudioIntegrityHash(audio);

  await updateProviderJobProgress(pool, job, {
    stage: 'writing_tts_cache',
    progress: {
      ...recordValue(job.progress),
      ttsCache,
      byteSize: audio.byteLength,
      renderLifecycle: renderLifecycleProgress(job.progress, 'synthesizing'),
    },
  });
  const s3Client = deps.s3Client ?? createS3Client(config);
  const putAudio = deps.putTtsAudioObject ?? putTtsAudioObject;
  await putAudio(s3Client, config, objectKey, audio, contentType);
  const client = await pool.connect();
  let commitAttempted = false;
  try {
    await client.query('begin');
    await lockImageSeriesBookLifecycle(client, job.book_id);
    const activeBook = await client.query<{ active_content_revision_id: string }>(
      `select active_content_revision_id
         from library_books
        where id = $1 and user_id = $2 and deleted_at is null
        for share`,
      [job.book_id, job.user_id],
    );
    if (activeBook.rows[0]?.active_content_revision_id !== contentRevisionId) {
      throw new AnalysisInputStaleError('analysis_content_revision_stale', `TTS target content changed: ${job.id}`);
    }
    await lockProviderJobForPersistence(client, job);
    await client.query(
      `
        insert into tts_audio_cache (
          id, book_id, chapter_id, cache_key, provider_id, provider_model, provider_version,
          voice_profile_id, speaker_id, segment_ids, segment_text_hashes, input_text_hash, options_hash, render_spec_hash,
          audio_object_key, content_type, byte_size, audio_hash, duration_ms,
          content_revision_id, graph_revision_id, input_revision_id, lifecycle_state,
          cache_purpose, sample_text_id,
          render_item_id, render_fingerprint, voice_entry_fingerprint, pronunciation_revision_id,
          integrity_state, verified_at, quarantine_reason, stale_at,
          created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, null, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, 'active', $22, $23, $24, $25, $26, $27, 'verified', now(), null, null, now(), now()
        )
        on conflict (cache_key) do update
          set audio_object_key = excluded.audio_object_key,
              segment_text_hashes = excluded.segment_text_hashes,
              render_spec_hash = excluded.render_spec_hash,
              content_type = excluded.content_type,
              byte_size = excluded.byte_size,
              audio_hash = excluded.audio_hash,
              duration_ms = excluded.duration_ms,
              content_revision_id = excluded.content_revision_id,
              graph_revision_id = excluded.graph_revision_id,
              input_revision_id = excluded.input_revision_id,
              lifecycle_state = 'active',
              cache_purpose = excluded.cache_purpose,
              sample_text_id = excluded.sample_text_id,
              render_item_id = excluded.render_item_id,
              render_fingerprint = excluded.render_fingerprint,
              voice_entry_fingerprint = excluded.voice_entry_fingerprint,
              pronunciation_revision_id = excluded.pronunciation_revision_id,
              integrity_state = 'verified',
              verified_at = now(),
              quarantine_reason = null,
              stale_at = null,
              updated_at = now()
      `,
      [
        ttsAudioCacheRowId(job.book_id, job.chapter_id, ttsCache.cacheKey),
        job.book_id,
        job.chapter_id,
        ttsCache.cacheKey,
        job.provider_id,
        job.model_id,
        ttsCache.voiceProfileId,
        ttsCache.speakerId,
        JSON.stringify(ttsCache.segmentIds),
        JSON.stringify(segmentTextHashesFromRows(rows)),
        reconstructedTextHash,
        canonicalOptionsHash,
        canonicalRenderSpecHash ?? null,
        objectKey,
        contentType,
        audio.byteLength,
        audioHash,
        result.durationMs ?? null,
        contentRevisionId,
        inputRevision?.characterGraphRevisionId ?? null,
        inputRevision?.id ?? null,
        ttsCache.cachePurpose,
        ttsCache.sampleTextId ?? null,
        ttsCache.renderItemId ?? null,
        canonicalRenderSpecHash ?? null,
        ttsCache.renderSpec?.voiceEntryFingerprint ?? null,
        ttsCache.renderSpec?.pronunciationRevisionId ?? null,
      ],
    );
    const completionApplied = await updateProviderJobProgress(client, job, {
      status: 'succeeded',
      stage: 'ready',
      progress: {
        ...recordValue(job.progress),
        ttsCache: { ...ttsCache, audioObjectKey: objectKey },
        audio: {
          contentType,
          byteSize: audio.byteLength,
          audioHash,
          durationMs: result.durationMs,
        },
        budgetEstimate: {
          providerId: job.provider_id,
          modelId: job.model_id ?? undefined,
          audioCharacters: text.length,
          cacheHit: false,
        },
        renderLifecycle: renderLifecycleProgress(job.progress, 'verified'),
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: true,
    });
    if (!completionApplied) throw new ProviderJobCancelledError(job.id);
    if (ttsCache.renderPlanId && ttsCache.renderItemId) {
      await client.query(
        `update tts_render_items_v2
         set lifecycle_state = 'succeeded', provider_job_id = $3, cache_key = $4, updated_at = now()
         where id = $1 and plan_id = $2 and render_fingerprint = $5`,
        [ttsCache.renderItemId, ttsCache.renderPlanId, job.id, ttsCache.cacheKey, canonicalRenderSpecHash],
      );
      await client.query(
        `update tts_render_plans_v2
         set status = case
           when not exists (
             select 1 from tts_render_items_v2
             where plan_id = $1 and lifecycle_state not in ('succeeded', 'cache_hit')
           ) then 'audio_cache_ready'
           else 'partial'
         end, updated_at = now()
         where id = $1`,
        [ttsCache.renderPlanId],
      );
    }
    commitAttempted = true;
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // The original persistence error is more useful than a rollback transport error.
    }
    if (!commitAttempted) {
      try {
        await deleteObject(s3Client, config, objectKey);
      } catch {
        // The playback integrity path quarantines a row/object mismatch if compensating cleanup also fails.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
