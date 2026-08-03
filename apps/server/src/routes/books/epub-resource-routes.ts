import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { createS3Client, getObjectBuffer } from '../../services/object-storage.js';

interface ResourceRow {
  id: string;
  book_id: string;
  storage_key: string;
  file_name: string | null;
  content_type: string;
  byte_length: string | number;
  content_hash: string;
  kind: 'epub_resource' | 'document_page';
  page_index: number | null;
}

export async function registerEpubResourceRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string; assetId: string } }>(
    '/api/books/:bookId/resources/:assetId',
    async (request, reply) => {
      const result = await pool.query<ResourceRow>(
        `select asset.id, asset.book_id, asset.storage_key, asset.file_name, asset.content_type,
                asset.byte_length, asset.content_hash, asset.kind, asset.page_index
           from book_assets asset
           join library_books book on book.id = asset.book_id and book.user_id = asset.user_id
          where asset.id = $1 and asset.book_id = $2 and asset.user_id = $3
            and asset.kind in ('epub_resource', 'document_page') and asset.status = 'active'`,
        [request.params.assetId, request.params.bookId, config.defaultUserId],
      );
      const resource = result.rows[0];
      if (!resource) return reply.code(404).send({ error: 'Document resource not found' });
      const stored = await getObjectBuffer(createS3Client(config), config, resource.storage_key);
      return reply
        .header('Content-Type', resource.content_type)
        .header('Content-Length', String(resource.byte_length))
        .header('ETag', resource.content_hash)
        .header('X-Asset-Id', resource.id)
        .header('X-Asset-Kind', resource.kind)
        .header('X-Page-Index', resource.page_index === null ? '' : String(resource.page_index))
        .header('X-Asset-File-Name', encodeURIComponent(resource.file_name ?? 'resource'))
        .send(stored);
    },
  );
}
