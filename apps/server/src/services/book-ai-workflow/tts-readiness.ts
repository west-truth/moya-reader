import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import type {
  BookAIWorkflowRow,
  TTSCacheCoverageRow,
  TTSCacheMissingSegmentRow,
  TTSCacheReadinessReport,
  TTSCacheSummaryRow,
  TTSReadinessMetricsRow,
  TTSReadinessMissingParagraphRow,
  TTSReadinessMissingSpeakerRow,
  TTSReadinessReport,
  TTSReadinessRoleProfileRow,
} from './workflow-contracts.js';
import { loadWorkflow, updateWorkflowProgress } from './workflow-repository.js';
import { numberValue } from './workflow-state.js';

export async function verifyTTSReadiness(
  pool: pg.Pool,
  workflow: BookAIWorkflowRow,
  plan: BookAIWorkflowPlan,
): Promise<TTSReadinessReport> {
  const chapterIds = plan.ttsReady.chapterIds;
  const checkedAt = new Date().toISOString();
  if (chapterIds.length === 0) {
    return {
      ok: false,
      errorCode: 'tts_readiness_no_chapters',
      message: 'No chapters are present in the TTS readiness plan.',
      metrics: {
        plannedChapterCount: 0,
        segmentCount: 0,
        labeledChapterCount: 0,
        plannedParagraphCount: 0,
        labeledPlannedParagraphCount: 0,
        missingPlannedParagraphCount: 0,
        unknownSegmentCount: 0,
        lowConfidenceSegmentCount: 0,
        characterSpeakerCount: 0,
        unknownSegmentRatio: 0,
        missingCharacterVoiceProfileCount: 0,
        narratorProfileCount: 0,
        systemProfileCount: 0,
        unknownProfileCount: 0,
      },
      missingCharacterVoiceSpeakerIds: [],
      missingPlannedParagraphIds: [],
      checkedAt,
    };
  }

  const plannedParagraphIds = [...new Set(plan.labelingWindows.flatMap((window) => window.paragraphIds))];
  const [metricsResult, missingSpeakersResult, roleProfilesResult, missingParagraphsResult] = await Promise.all([
    pool.query<TTSReadinessMetricsRow>(
      `
        select
          count(*) as segment_count,
          count(distinct chapter_id) as labeled_chapter_count,
          count(distinct paragraph_id) filter (where paragraph_id = any($3::text[])) as labeled_planned_paragraph_count,
          count(*) filter (where speaker_id = 'unknown') as unknown_segment_count,
          count(*) filter (where confidence < 0.5) as low_confidence_segment_count,
          count(distinct speaker_id) filter (where speaker_id not in ('narrator', 'system', 'unknown')) as character_speaker_count
        from labeled_segments
        where book_id = $1
          and chapter_id = any($2::text[])
      `,
      [workflow.book_id, chapterIds, plannedParagraphIds],
    ),
    pool.query<TTSReadinessMissingSpeakerRow>(
      `
        select speaker_id
        from labeled_segments
        where book_id = $1
          and chapter_id = any($2::text[])
          and speaker_id not in ('narrator', 'system', 'unknown')
        group by speaker_id
        having not exists (
          select 1
          from voice_profiles vp
          where vp.book_id = $1
            and vp.character_id = labeled_segments.speaker_id
            and vp.role = 'character'
            and vp.is_user_selected = true
            and nullif(trim(vp.provider_id), '') is not null
            and nullif(trim(vp.provider_voice_id), '') is not null
        )
        order by speaker_id
      `,
      [workflow.book_id, chapterIds],
    ),
    pool.query<TTSReadinessRoleProfileRow>(
      `
        select role, count(*) as profile_count
        from voice_profiles
        where book_id = $1
          and role in ('narrator', 'system', 'unknown')
        group by role
      `,
      [workflow.book_id],
    ),
    plannedParagraphIds.length > 0
      ? pool.query<TTSReadinessMissingParagraphRow>(
          `
          select planned.paragraph_id
          from unnest($2::text[]) as planned(paragraph_id)
          where not exists (
            select 1
            from labeled_segments ls
            where ls.book_id = $1
              and ls.paragraph_id = planned.paragraph_id
          )
          order by planned.paragraph_id
        `,
          [workflow.book_id, plannedParagraphIds],
        )
      : Promise.resolve({ rows: [] as TTSReadinessMissingParagraphRow[] }),
  ]);

  const metricsRow = metricsResult.rows[0];
  const segmentCount = numberValue(metricsRow?.segment_count);
  const labeledChapterCount = numberValue(metricsRow?.labeled_chapter_count);
  const labeledPlannedParagraphCount = numberValue(metricsRow?.labeled_planned_paragraph_count);
  const unknownSegmentCount = numberValue(metricsRow?.unknown_segment_count);
  const lowConfidenceSegmentCount = numberValue(metricsRow?.low_confidence_segment_count);
  const characterSpeakerCount = numberValue(metricsRow?.character_speaker_count);
  const missingCharacterVoiceSpeakerIds = missingSpeakersResult.rows.map((row) => row.speaker_id);
  const missingPlannedParagraphIds = missingParagraphsResult.rows.map((row) => row.paragraph_id);
  const roleProfileCounts = new Map(roleProfilesResult.rows.map((row) => [row.role, numberValue(row.profile_count)]));
  const unknownSegmentRatio = segmentCount > 0 ? Number((unknownSegmentCount / segmentCount).toFixed(3)) : 0;
  const metrics = {
    plannedChapterCount: chapterIds.length,
    segmentCount,
    labeledChapterCount,
    plannedParagraphCount: plannedParagraphIds.length,
    labeledPlannedParagraphCount,
    missingPlannedParagraphCount: missingPlannedParagraphIds.length,
    unknownSegmentCount,
    lowConfidenceSegmentCount,
    characterSpeakerCount,
    unknownSegmentRatio,
    missingCharacterVoiceProfileCount: missingCharacterVoiceSpeakerIds.length,
    narratorProfileCount: roleProfileCounts.get('narrator') ?? 0,
    systemProfileCount: roleProfileCounts.get('system') ?? 0,
    unknownProfileCount: roleProfileCounts.get('unknown') ?? 0,
  };

  let errorCode: string | undefined;
  let message: string | undefined;
  if (segmentCount === 0) {
    errorCode = 'tts_readiness_no_segments';
    message = 'No labeled segments were persisted for TTS playback.';
  } else if (labeledChapterCount < chapterIds.length) {
    errorCode = 'tts_readiness_missing_chapters';
    message = 'One or more planned chapters have no persisted labeled segments.';
  } else if (missingPlannedParagraphIds.length > 0) {
    errorCode = 'tts_readiness_missing_paragraphs';
    message = 'One or more planned paragraph windows have missing persisted labels.';
  } else if (unknownSegmentRatio > 0.25) {
    errorCode = 'tts_readiness_unknown_speaker_ratio_high';
    message = 'Too many persisted labeled segments still have unknown speakers for character TTS.';
  } else if (missingCharacterVoiceSpeakerIds.length > 0) {
    errorCode = 'tts_readiness_missing_voice_profiles';
    message = 'One or more character speakers do not have assigned voice profiles.';
  }

  return {
    ok: !errorCode,
    errorCode,
    message,
    metrics,
    missingCharacterVoiceSpeakerIds,
    missingPlannedParagraphIds,
    checkedAt,
  };
}

function emptyTTSCacheReadinessReport(input: {
  readonly ok: boolean;
  readonly plannedChapterCount: number;
  readonly checkedAt: string;
  readonly errorCode?: string;
  readonly message?: string;
}): TTSCacheReadinessReport {
  return {
    ok: input.ok,
    errorCode: input.errorCode,
    message: input.message,
    metrics: {
      plannedChapterCount: input.plannedChapterCount,
      cacheableSegmentCount: 0,
      cachedSegmentCount: 0,
      missingCachedSegmentCount: 0,
      cacheItemCount: 0,
      cachedByteSize: 0,
      cacheReadyRatio: 0,
    },
    missingCachedSegmentIds: [],
    checkedAt: input.checkedAt,
  };
}

async function verifyTTSCacheReadiness(
  pool: pg.Pool,
  workflow: BookAIWorkflowRow,
  plan: BookAIWorkflowPlan,
): Promise<TTSCacheReadinessReport> {
  const chapterIds = [...new Set(plan.ttsReady.chapterIds)];
  const checkedAt = new Date().toISOString();
  if (chapterIds.length === 0) {
    return emptyTTSCacheReadinessReport({
      ok: false,
      plannedChapterCount: 0,
      checkedAt,
      errorCode: 'tts_cache_readiness_no_chapters',
      message: 'No chapters are present in the TTS cache readiness plan.',
    });
  }

  const [coverageResult, summaryResult, missingResult] = await Promise.all([
    pool.query<TTSCacheCoverageRow>(
      `
        with planned_segments as (
          select distinct on (ls.id)
                 ls.id,
                 ls.speaker_id,
                 ls.segment_text_hash,
                 vp.id as voice_profile_id,
                 vp.provider_id,
                 vp.provider_model,
                 vp.updated_at as voice_profile_updated_at
          from labeled_segments ls
          join voice_profiles vp
            on vp.book_id = ls.book_id
           and vp.is_user_selected = true
           and vp.provider_id <> 'system'
           and nullif(trim(vp.provider_id), '') is not null
           and nullif(trim(vp.provider_voice_id), '') is not null
           and (
             (ls.voice_profile_id is not null and vp.id = ls.voice_profile_id)
             or (
               ls.voice_profile_id is null
               and vp.role = 'character'
               and vp.character_id = ls.speaker_id
               and ls.speaker_id not in ('narrator', 'system', 'unknown')
             )
             or (
               ls.voice_profile_id is null
               and vp.role = 'narrator'
               and vp.character_id is null
               and ls.speaker_id = 'narrator'
             )
             or (
               ls.voice_profile_id is null
               and vp.role = 'unknown'
               and vp.character_id is null
               and ls.speaker_id = 'unknown'
             )
           )
          where ls.book_id = $1
            and ls.chapter_id = any($2::text[])
          order by ls.id,
                   case when ls.voice_profile_id is not null and vp.id = ls.voice_profile_id then 0 else 1 end,
                   vp.updated_at desc,
                   vp.id asc
        ),
        cached_segments as (
          select distinct segment.segment_id,
                 c.voice_profile_id,
                 c.provider_id,
                 c.provider_model,
                 c.speaker_id,
                 coalesce(c.segment_text_hashes, '{}'::jsonb) ->> segment.segment_id as segment_text_hash,
                 c.render_spec_hash,
                 c.updated_at as cache_updated_at
          from tts_audio_cache c
          cross join lateral jsonb_array_elements_text(c.segment_ids) as segment(segment_id)
          where c.book_id = $1
            and c.chapter_id = any($2::text[])
            and c.lifecycle_state = 'active'
            and c.integrity_state = 'verified'
            and c.stale_at is null
            and nullif(trim(c.audio_object_key), '') is not null
            and coalesce(c.byte_size, 0) > 0
        )
        select count(distinct ps.id) as cacheable_segment_count,
               count(distinct cs.segment_id) filter (where cs.segment_id is not null) as cached_segment_count
        from planned_segments ps
        left join cached_segments cs
          on cs.segment_id = ps.id
         and cs.voice_profile_id = ps.voice_profile_id
         and cs.provider_id = ps.provider_id
         and (ps.provider_model is null or cs.provider_model = ps.provider_model)
         and cs.speaker_id = ps.speaker_id
         and cs.segment_text_hash = ps.segment_text_hash
         and nullif(trim(cs.render_spec_hash), '') is not null
         and cs.cache_updated_at >= ps.voice_profile_updated_at
      `,
      [workflow.book_id, chapterIds],
    ),
    pool.query<TTSCacheSummaryRow>(
      `
        with planned_segments as (
          select distinct on (ls.id)
                 ls.id,
                 ls.speaker_id,
                 ls.segment_text_hash,
                 vp.id as voice_profile_id,
                 vp.provider_id,
                 vp.provider_model,
                 vp.updated_at as voice_profile_updated_at
          from labeled_segments ls
          join voice_profiles vp
            on vp.book_id = ls.book_id
           and vp.is_user_selected = true
           and vp.provider_id <> 'system'
           and nullif(trim(vp.provider_id), '') is not null
           and nullif(trim(vp.provider_voice_id), '') is not null
           and (
             (ls.voice_profile_id is not null and vp.id = ls.voice_profile_id)
             or (
               ls.voice_profile_id is null
               and vp.role = 'character'
               and vp.character_id = ls.speaker_id
               and ls.speaker_id not in ('narrator', 'system', 'unknown')
             )
             or (
               ls.voice_profile_id is null
               and vp.role = 'narrator'
               and vp.character_id is null
               and ls.speaker_id = 'narrator'
             )
             or (
               ls.voice_profile_id is null
               and vp.role = 'unknown'
               and vp.character_id is null
               and ls.speaker_id = 'unknown'
             )
           )
          where ls.book_id = $1
            and ls.chapter_id = any($2::text[])
          order by ls.id,
                   case when ls.voice_profile_id is not null and vp.id = ls.voice_profile_id then 0 else 1 end,
                   vp.updated_at desc,
                   vp.id asc
        ),
        matched_cache_items as (
          select distinct c.cache_key, coalesce(c.byte_size, 0) as byte_size
          from tts_audio_cache c
          cross join lateral jsonb_array_elements_text(c.segment_ids) as segment(segment_id)
          join planned_segments ps on ps.id = segment.segment_id
           and c.voice_profile_id = ps.voice_profile_id
           and c.provider_id = ps.provider_id
           and (ps.provider_model is null or c.provider_model = ps.provider_model)
           and c.speaker_id = ps.speaker_id
           and coalesce(c.segment_text_hashes, '{}'::jsonb) ->> segment.segment_id = ps.segment_text_hash
           and nullif(trim(c.render_spec_hash), '') is not null
           and c.updated_at >= ps.voice_profile_updated_at
          where c.book_id = $1
            and c.chapter_id = any($2::text[])
            and c.lifecycle_state = 'active'
            and c.integrity_state = 'verified'
            and c.stale_at is null
            and nullif(trim(c.audio_object_key), '') is not null
            and coalesce(c.byte_size, 0) > 0
        )
        select count(*) as cache_item_count,
               coalesce(sum(byte_size), 0) as cached_byte_size
        from matched_cache_items
      `,
      [workflow.book_id, chapterIds],
    ),
    pool.query<TTSCacheMissingSegmentRow>(
      `
        with planned_segments as (
          select distinct on (ls.id)
                 ls.id,
                 ls.chapter_id,
                 ls.segment_index,
                 ls.speaker_id,
                 ls.segment_text_hash,
                 vp.id as voice_profile_id,
                 vp.provider_id,
                 vp.provider_model,
                 vp.updated_at as voice_profile_updated_at
          from labeled_segments ls
          join voice_profiles vp
            on vp.book_id = ls.book_id
           and vp.is_user_selected = true
           and vp.provider_id <> 'system'
           and nullif(trim(vp.provider_id), '') is not null
           and nullif(trim(vp.provider_voice_id), '') is not null
           and (
             (ls.voice_profile_id is not null and vp.id = ls.voice_profile_id)
             or (
               ls.voice_profile_id is null
               and vp.role = 'character'
               and vp.character_id = ls.speaker_id
               and ls.speaker_id not in ('narrator', 'system', 'unknown')
             )
             or (
               ls.voice_profile_id is null
               and vp.role = 'narrator'
               and vp.character_id is null
               and ls.speaker_id = 'narrator'
             )
             or (
               ls.voice_profile_id is null
               and vp.role = 'unknown'
               and vp.character_id is null
               and ls.speaker_id = 'unknown'
             )
           )
          where ls.book_id = $1
            and ls.chapter_id = any($2::text[])
          order by ls.id,
                   case when ls.voice_profile_id is not null and vp.id = ls.voice_profile_id then 0 else 1 end,
                   vp.updated_at desc,
                   vp.id asc
        ),
        cached_segments as (
          select distinct segment.segment_id,
                 c.voice_profile_id,
                 c.provider_id,
                 c.provider_model,
                 c.speaker_id,
                 coalesce(c.segment_text_hashes, '{}'::jsonb) ->> segment.segment_id as segment_text_hash,
                 c.render_spec_hash,
                 c.updated_at as cache_updated_at
          from tts_audio_cache c
          cross join lateral jsonb_array_elements_text(c.segment_ids) as segment(segment_id)
          where c.book_id = $1
            and c.chapter_id = any($2::text[])
            and c.lifecycle_state = 'active'
            and c.integrity_state = 'verified'
            and c.stale_at is null
            and nullif(trim(c.audio_object_key), '') is not null
            and coalesce(c.byte_size, 0) > 0
        )
        select ps.id as segment_id
        from planned_segments ps
        left join cached_segments cs
          on cs.segment_id = ps.id
         and cs.voice_profile_id = ps.voice_profile_id
         and cs.provider_id = ps.provider_id
         and (ps.provider_model is null or cs.provider_model = ps.provider_model)
         and cs.speaker_id = ps.speaker_id
         and cs.segment_text_hash = ps.segment_text_hash
         and nullif(trim(cs.render_spec_hash), '') is not null
         and cs.cache_updated_at >= ps.voice_profile_updated_at
        where cs.segment_id is null
        order by ps.chapter_id asc, ps.segment_index asc, ps.id asc
        limit 50
      `,
      [workflow.book_id, chapterIds],
    ),
  ]);

  const coverage = coverageResult.rows[0];
  const summary = summaryResult.rows[0];
  const cacheableSegmentCount = numberValue(coverage?.cacheable_segment_count);
  const cachedSegmentCount = numberValue(coverage?.cached_segment_count);
  const missingCachedSegmentCount = Math.max(0, cacheableSegmentCount - cachedSegmentCount);
  const cacheReadyRatio = cacheableSegmentCount > 0 ? cachedSegmentCount / cacheableSegmentCount : 0;
  let errorCode: string | undefined;
  let message: string | undefined;
  if (cacheableSegmentCount === 0) {
    errorCode = 'tts_cache_readiness_no_cacheable_segments';
    message = 'No cacheable TTS segments were found for hosted provider voice profiles.';
  } else if (missingCachedSegmentCount > 0) {
    errorCode = 'tts_cache_readiness_missing_audio_cache';
    message = 'One or more TTS segments do not have hosted audio cache yet.';
  }

  return {
    ok: !errorCode,
    errorCode,
    message,
    metrics: {
      plannedChapterCount: chapterIds.length,
      cacheableSegmentCount,
      cachedSegmentCount,
      missingCachedSegmentCount,
      cacheItemCount: numberValue(summary?.cache_item_count),
      cachedByteSize: numberValue(summary?.cached_byte_size),
      cacheReadyRatio,
    },
    missingCachedSegmentIds: missingResult.rows.map((row) => row.segment_id),
    checkedAt,
  };
}

export async function refreshBookAIWorkflowTTSCacheReadiness(
  pool: pg.Pool,
  config: ServerConfig,
  workflowId: string,
): Promise<TTSCacheReadinessReport | undefined> {
  const loaded = await loadWorkflow(pool, config, workflowId);
  if (!loaded) return undefined;
  const { row: workflow } = loaded;
  const plan = workflow.plan as BookAIWorkflowPlan;
  const readyForCacheCheck =
    workflow.status === 'succeeded' && (workflow.stage === 'ready_for_tts' || workflow.stage === 'audio_cache_ready');
  if (!readyForCacheCheck) {
    return emptyTTSCacheReadinessReport({
      ok: false,
      plannedChapterCount: plan.ttsReady.chapterIds.length,
      checkedAt: new Date().toISOString(),
      errorCode: 'tts_cache_readiness_requires_label_voice_ready',
      message: 'Label and voice-profile readiness must pass before hosted TTS cache readiness can be checked.',
    });
  }

  const ttsCacheReadiness = await verifyTTSCacheReadiness(pool, workflow, plan);
  await updateWorkflowProgress(pool, workflow, {
    status: 'succeeded',
    stage: ttsCacheReadiness.ok ? 'audio_cache_ready' : 'ready_for_tts',
    progress: {
      ttsCacheReadiness,
      audioCacheReadyAt: ttsCacheReadiness.ok ? ttsCacheReadiness.checkedAt : null,
    },
  });
  return ttsCacheReadiness;
}
