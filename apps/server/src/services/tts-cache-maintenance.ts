import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { createS3Client, deleteObject } from './object-storage.js';

export interface TTSCacheMaintenanceSummary {
  readonly markedStale: number;
  readonly deleted: number;
  readonly failed: number;
}

interface GCRow extends pg.QueryResultRow {
  id: string;
  audio_object_key: string;
}

export async function maintainTTSCache(
  pool: pg.Pool,
  config: ServerConfig,
  deps: { readonly deleteAudioObject?: (key: string) => Promise<void> } = {},
): Promise<TTSCacheMaintenanceSummary> {
  await pool.query(
    `update tts_render_items_v2 item
     set lifecycle_state = case
       when job.status = 'failed' and attempt.outcome_state = 'outcome_unknown' then 'unknown'
       when job.status = 'failed' then 'failed'
       when job.status = 'cancelled' then 'cancelled'
       when job.status = 'running' then 'running'
       else 'queued'
     end,
     updated_at = now()
     from provider_jobs job
     left join provider_job_attempts attempt on attempt.id = job.current_attempt_id
     where item.provider_job_id = job.id
       and item.lifecycle_state not in ('succeeded', 'cache_hit', 'stale', 'corrupt')
       and job.status in ('queued', 'running', 'failed', 'cancelled')
       and item.lifecycle_state is distinct from case
         when job.status = 'failed' and attempt.outcome_state = 'outcome_unknown' then 'unknown'
         when job.status = 'failed' then 'failed'
         when job.status = 'cancelled' then 'cancelled'
         when job.status = 'running' then 'running'
         else 'queued'
       end`,
  );
  const stale = await pool.query(
    `update tts_audio_cache cache
     set stale_at = coalesce(cache.stale_at, now()),
         gc_after = coalesce(cache.gc_after, now() + interval '7 days'),
         lifecycle_state = 'stale',
         updated_at = now()
     from library_books book
     join voice_profiles voice on voice.book_id = book.id
     left join pronunciation_profiles pronunciation
       on pronunciation.book_id = book.id and pronunciation.user_id = book.user_id
     where cache.book_id = book.id
       and cache.voice_profile_id = voice.id
       and cache.stale_at is null
       and (
         (cache.cache_purpose = 'reading' and cache.content_revision_id is distinct from book.active_content_revision_id)
         or cache.updated_at < voice.updated_at
         or (
           pronunciation.id is not null
           and not (
             (pronunciation.revision = 0 and cache.pronunciation_revision_id is null)
             or cache.pronunciation_revision_id = pronunciation.revision_id
           )
         )
         or (
           cache.voice_entry_fingerprint is not null
           and exists (
             select 1 from voice_catalog_snapshots current_catalog
             where current_catalog.book_id = cache.book_id
               and current_catalog.provider_id = cache.provider_id
               and (current_catalog.model_id is null or current_catalog.model_id is not distinct from cache.provider_model)
           )
           and not exists (
             select 1
             from voice_catalog_entries current_voice
             join voice_catalog_snapshots current_catalog on current_catalog.id = current_voice.snapshot_id
             where current_voice.book_id = cache.book_id
               and current_voice.provider_id = cache.provider_id
               and current_voice.voice_id = voice.provider_voice_id
               and current_voice.fingerprint = cache.voice_entry_fingerprint
               and current_voice.available
               and (current_catalog.model_id is null or current_catalog.model_id is not distinct from cache.provider_model)
           )
         )
       )`,
  );
  await pool.query(
    `update tts_render_items_v2 item
     set lifecycle_state = case when cache.integrity_state = 'quarantined' then 'corrupt' else 'stale' end,
         updated_at = now()
     from tts_audio_cache cache
     where (cache.render_item_id = item.id or (cache.render_item_id is null and cache.cache_key = item.cache_key))
       and (cache.stale_at is not null or cache.integrity_state = 'quarantined')
       and item.lifecycle_state is distinct from
         case when cache.integrity_state = 'quarantined' then 'corrupt' else 'stale' end`,
  );
  await pool.query(
    `with summaries as (
       select plan_id,
              count(*) as total,
              count(*) filter (where lifecycle_state in ('succeeded', 'cache_hit')) as ready,
              count(*) filter (where lifecycle_state = 'running') as running,
              count(*) filter (where lifecycle_state = 'queued') as queued,
              count(*) filter (where lifecycle_state = 'unknown') as unknown,
              count(*) filter (where lifecycle_state = 'cancelled') as cancelled,
              count(*) filter (where lifecycle_state in ('failed', 'missing', 'stale', 'corrupt')) as retryable
       from tts_render_items_v2
       group by plan_id
     )
     update tts_render_plans_v2 plan
     set status = case
       when summary.total > 0 and summary.ready = summary.total then 'audio_cache_ready'
       when summary.unknown > 0 then 'outcome_unknown'
       when summary.running > 0 then 'synthesizing'
       when summary.queued > 0 then 'queued'
       when summary.ready > 0 and summary.retryable > 0 then 'partial'
       when summary.retryable > 0 then 'failed_retryable'
       when summary.total > 0 and summary.cancelled = summary.total then 'cancelled'
       else 'planned'
     end,
     updated_at = now()
     from summaries summary
     where plan.id = summary.plan_id
       and plan.status is distinct from case
         when summary.total > 0 and summary.ready = summary.total then 'audio_cache_ready'
         when summary.unknown > 0 then 'outcome_unknown'
         when summary.running > 0 then 'synthesizing'
         when summary.queued > 0 then 'queued'
         when summary.ready > 0 and summary.retryable > 0 then 'partial'
         when summary.retryable > 0 then 'failed_retryable'
         when summary.total > 0 and summary.cancelled = summary.total then 'cancelled'
         else 'planned'
       end`,
  );
  const candidates = await pool.query<GCRow>(
    `with candidates as (
       select cache.id, cache.audio_object_key
       from tts_audio_cache cache
       left join tts_audio_gc_leases_v2 lease
         on lease.cache_id = cache.id and lease.expires_at > now()
       where cache.gc_after <= now()
         and lease.cache_id is null
         and (cache.stale_at is not null or cache.integrity_state = 'quarantined')
       order by cache.gc_after asc
       for update of cache skip locked
       limit 20
     ), leased as (
       insert into tts_audio_gc_leases_v2 (cache_id, lease_owner, expires_at)
       select id, $1, now() + interval '2 minutes' from candidates
       on conflict (cache_id) do update
         set lease_owner = excluded.lease_owner, expires_at = excluded.expires_at, updated_at = now()
         where tts_audio_gc_leases_v2.expires_at <= now()
       returning cache_id
     )
     select candidate.id, candidate.audio_object_key
     from candidates candidate
     join leased lease on lease.cache_id = candidate.id`,
    [`tts-cache-maintenance:${process.pid}`],
  );
  const s3Client = deps.deleteAudioObject ? undefined : createS3Client(config);
  const remove = deps.deleteAudioObject ?? ((key: string) => deleteObject(s3Client!, config, key));
  let deleted = 0;
  let failed = 0;
  for (const row of candidates.rows) {
    try {
      await remove(row.audio_object_key);
      await pool.query('delete from tts_audio_cache where id = $1 and gc_after <= now()', [row.id]);
      deleted += 1;
    } catch {
      await pool.query('delete from tts_audio_gc_leases_v2 where cache_id = $1', [row.id]);
      failed += 1;
    }
  }
  return { markedStale: stale.rowCount ?? 0, deleted, failed };
}
