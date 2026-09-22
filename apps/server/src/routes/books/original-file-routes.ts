import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { LOCAL_ARCHIVE_SERIES_TYPE } from '@noveldesk/document-series-core';
import type { OriginalFileEntry } from '@noveldesk/contracts';
import type { ServerConfig } from '../../config.js';
import { createS3Client, getObjectStream } from '../../services/object-storage.js';

interface StoredOriginal extends OriginalFileEntry {
  storageKey: string;
}

function attachmentName(name: string): string {
  const clean =
    Array.from(name.replace(/.*[\\/]/u, ''))
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join('') || 'original';
  const fallback = clean.replace(/[^\x20-\x7e]|["\\]/gu, '_').slice(0, 180);
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function registerOriginalFileRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig) {
  const s3 = createS3Client(config);
  // Scoped to this server instance; a restart invalidates unused links, not existing downloads.
  const tickets = new Map<string, { bookId: string; fileId: string; hash: string; expires: number }>();
  app.addHook('onClose', async () => {
    tickets.clear();
    s3.destroy();
  });

  async function originals(bookId: string): Promise<StoredOriginal[] | null | undefined> {
    const result = await pool.query(
      `select o.id, o.storage_key as "storageKey", o.file_name as "fileName",
              o.content_type as "contentType", o.size_bytes as "byteLength", o.raw_text_hash as "contentHash"
         from library_books b join book_objects o on o.id=b.object_id
        where b.id=$1 and b.user_id=$2 and b.deleted_at is null`,
      [bookId, config.defaultUserId],
    );
    const source = result.rows[0];
    if (!source) return undefined;
    if (source.contentType === LOCAL_ARCHIVE_SERIES_TYPE) {
      // These same active source_part assets, in page_index order, form the local append manifest.
      const parts = await pool.query(
        `select a.id, a.storage_key as "storageKey", a.file_name as "fileName",
                a.content_type as "contentType", a.byte_length as "byteLength", a.content_hash as "contentHash"
           from book_assets a join library_books b on b.id=a.book_id and b.user_id=a.user_id
          where a.book_id=$1 and a.user_id=$2 and a.kind='source_part' and a.status='active'
            and b.deleted_at is null and b.object_id=$3
          order by a.page_index nulls last, a.id limit 2001`,
        [bookId, config.defaultUserId, source.id],
      );
      if (!parts.rows.length || parts.rows.length > 2000) throw new Error('보관된 원본 목록을 확인하지 못했습니다.');
      return parts.rows.map((part) => ({ ...part, byteLength: Number(part.byteLength) }));
    }
    // These formats need the existing portable export, not a raw internal container download.
    if (String(source.contentType).startsWith('application/vnd.moya.')) return null;
    return [{ ...source, fileName: source.fileName || 'original', byteLength: Number(source.byteLength) }];
  }

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/original-files', async (request, reply) => {
    const files = await originals(request.params.bookId);
    reply.header('Cache-Control', 'no-store');
    if (!files) return files === null ? { files: null } : reply.code(404).send({ error: '보관된 원본이 없습니다.' });
    return {
      files: files.map(({ id, fileName, contentType, byteLength, contentHash }) => ({
        id,
        fileName,
        contentType,
        byteLength,
        contentHash,
      })),
    };
  });

  app.post<{ Params: { bookId: string; fileId: string } }>(
    '/api/books/:bookId/original-files/:fileId/download',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const files = await originals(request.params.bookId);
      const file = files?.find((item) => item.id === request.params.fileId);
      if (!file) return reply.code(404).send({ error: '보관된 원본이 없습니다. 목록을 다시 열어 주세요.' });
      const now = Date.now();
      for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
      if (tickets.size >= 128) return reply.code(429).send({ error: '잠시 후 다시 시도해 주세요.' });
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, {
        bookId: request.params.bookId,
        fileId: file.id,
        hash: file.contentHash,
        expires: now + 60_000,
      });
      return { ticket };
    },
  );

  // Only this exact GET is exempt from account authentication. The single-file ticket is its credential.
  app.get<{ Params: { ticket: string } }>('/api/original-downloads/:ticket', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const ticket = tickets.get(request.params.ticket);
    tickets.delete(request.params.ticket);
    if (!ticket || ticket.expires <= Date.now())
      return reply.code(410).send({ error: '다운로드 주소가 만료되었습니다. 원본 목록에서 다시 눌러 주세요.' });
    const files = await originals(ticket.bookId);
    const file = files?.find((item) => item.id === ticket.fileId && item.contentHash === ticket.hash);
    if (!file) return reply.code(404).send({ error: '보관된 원본이 변경되거나 삭제되었습니다.' });
    const stored = await getObjectStream(s3, config, file.storageKey);
    const close = () => stored.body.destroy();
    reply.raw.once('close', close);
    if (reply.raw.destroyed) {
      close();
      return reply;
    }
    return reply
      .header('Content-Type', file.contentType || 'application/octet-stream')
      .header('Content-Length', String(file.byteLength))
      .header('Content-Disposition', attachmentName(file.fileName))
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Accel-Buffering', 'no')
      .send(stored.body);
  });
}
