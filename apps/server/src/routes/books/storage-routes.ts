import { readStorageCapacity } from '../../services/storage-capacity.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { LibraryStorageUsage } from '@noveldesk/contracts';
import type { ServerConfig } from '../../config.js';

// One statement keeps summary and book rows on the same DB snapshot. Never reads object bodies.
export const storageUsageSql = `
with books as (
  select id, title, metadata_revision, deleted_at is not null as trashed, object_id, format
  from library_books where user_id=$1
), files as (
  select b.id as book_id, o.storage_key, o.size_bytes as bytes,
    case when b.format in ('txt','markdown','epub','pdf') then 1
         when b.format='image_archive' then 2 else 4 end as category
  from books b join book_objects o on o.id=b.object_id
  union all
  select a.book_id, a.storage_key, a.byte_length as bytes,
    case when a.kind in ('document_page','cover') then 2
         when a.kind='source_part' and a.content_type like 'text/%' then 1
         when a.kind='source_part' and a.content_type in ('application/epub+zip','application/pdf') then 1
         when a.kind='source_part' and b.format='image_archive' then 2
         when a.content_type like 'image/%' then 2
         when a.content_type like 'audio/%' then 3 else 4 end as category
  from book_assets a join books b on b.id=a.book_id
  where a.user_id=$1 and a.status='active'
  union all
  select t.book_id, t.audio_object_key, t.byte_size, 3
  from tts_audio_cache t join books b on b.id=t.book_id
  where t.byte_size is not null and t.byte_size >= 0
), book_files as (
  select book_id, storage_key, max(bytes) as bytes, min(category) as category from files group by book_id, storage_key
), unique_files as (
  select f.storage_key, max(f.bytes) as bytes, min(f.category) as category, bool_and(b.trashed) as trash_only
  from book_files f join books b on b.id=f.book_id group by f.storage_key
), book_totals as (
  select b.id, b.title, b.metadata_revision, b.trashed, coalesce(sum(f.bytes),0) as bytes
  from books b left join book_files f on f.book_id=b.id
  group by b.id, b.title, b.metadata_revision, b.trashed
)
select jsonb_build_object(
  'breakdown', jsonb_build_object(
    'document', coalesce((select sum(bytes) from unique_files where category=1),0),
    'image', coalesce((select sum(bytes) from unique_files where category=2),0),
    'audio', coalesce((select sum(bytes) from unique_files where category=3),0),
    'other', coalesce((select sum(bytes) from unique_files where category=4),0)),
  'unmeasuredAudioFiles', (select count(*) from tts_audio_cache t join books b on b.id=t.book_id where t.byte_size is null),
  'totalBytes', coalesce((select sum(bytes) from unique_files),0),
  'libraryBytes', coalesce((select sum(bytes) from unique_files where not trash_only),0),
  'trashBytes', coalesce((select sum(bytes) from unique_files where trash_only),0),
  'books', coalesce((select jsonb_agg(jsonb_build_object(
    'id', id, 'title', title, 'metadataRevision', metadata_revision, 'trashed', trashed, 'bytes', bytes
  ) order by bytes desc, id) from book_totals),'[]'::jsonb)
) as usage`;

export async function registerStorageRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig) {
  app.get('/api/storage/usage', async (_request, reply): Promise<LibraryStorageUsage> => {
    reply.header('Cache-Control', 'no-store');
    const [result, capacity] = await Promise.all([
      pool.query(storageUsageSql, [config.defaultUserId]),
      readStorageCapacity(config),
    ]);
    return { ...result.rows[0].usage, capacity };
  });
}
