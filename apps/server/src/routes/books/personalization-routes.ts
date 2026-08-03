import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { integrityHash } from '@noveldesk/text-core/hash';
import type { ServerConfig } from '../../config.js';
import { createS3Client, deleteObject, getObjectBuffer, putRawBookObject } from '../../services/object-storage.js';

const MAX_FONT_BYTES = 10 * 1024 * 1024;
const FONT_TYPES = new Set(['font/woff2', 'font/woff', 'font/ttf', 'font/otf']);

type HeaderValue = string | string[] | undefined;
function header(value: HeaderValue): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function decodedHeader(value: HeaderValue): string {
  const raw = header(value);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

function detectedFontType(body: Buffer): string | undefined {
  if (body.length < 4) return undefined;
  const signature = body.subarray(0, 4).toString('latin1');
  if (signature === 'wOF2') return 'font/woff2';
  if (signature === 'wOFF') return 'font/woff';
  if (signature === 'OTTO') return 'font/otf';
  if (signature === '\u0000\u0001\u0000\u0000' || signature === 'true') return 'font/ttf';
  return undefined;
}

function safeDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function fontRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    familyLabel: row.family_label,
    fileName: row.file_name,
    style: row.style,
    weight: Number(row.weight),
    contentHash: row.content_hash,
    contentType: row.content_type,
    byteLength: Number(row.byte_length),
    storageKey: row.storage_key,
    licenseNote: row.license_note ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function sessionRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    deviceId: row.device_id,
    bookId: row.book_id,
    mode: row.mode,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    endedAt: row.ended_at instanceof Date ? row.ended_at.toISOString() : row.ended_at,
    activeSeconds: Number(row.active_seconds),
    startAnchor: row.start_anchor ?? undefined,
    endAnchor: row.end_anchor ?? undefined,
    charactersAdvanced: row.characters_advanced == null ? undefined : Number(row.characters_advanced),
    operationId: row.operation_id,
  };
}

export async function registerReaderPersonalizationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get('/api/fonts', async () => {
    const result = await pool.query(
      'select * from user_fonts where user_id = $1 order by family_label, updated_at desc',
      [config.defaultUserId],
    );
    return { fonts: result.rows.map(fontRow) };
  });

  app.get<{ Params: { fontId: string } }>('/api/fonts/:fontId/content', async (request, reply) => {
    const result = await pool.query('select * from user_fonts where id = $1 and user_id = $2', [
      request.params.fontId,
      config.defaultUserId,
    ]);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'font_not_found' });
    const object = await getObjectBuffer(createS3Client(config), config, String(row.storage_key));
    return reply
      .header('Content-Type', String(row.content_type))
      .header('ETag', String(row.content_hash))
      .send(object.body);
  });

  app.put<{ Params: { fontId: string }; Body: Buffer }>(
    '/api/fonts/:fontId',
    { bodyLimit: MAX_FONT_BYTES },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || !request.body.length)
        return reply.code(400).send({ error: 'font_body_required' });
      const contentType = detectedFontType(request.body);
      const declaredType = header(request.headers['x-font-content-type']);
      if (!contentType || !FONT_TYPES.has(declaredType) || declaredType !== contentType) {
        return reply.code(400).send({ error: 'font_format_invalid' });
      }
      const familyLabel = decodedHeader(request.headers['x-font-family']).slice(0, 120);
      const fileName = decodedHeader(request.headers['x-font-file-name']).slice(0, 255);
      const style = header(request.headers['x-font-style']);
      const weight = Number(header(request.headers['x-font-weight']));
      const contentHash = integrityHash(request.body);
      if (
        !familyLabel ||
        !fileName ||
        !['normal', 'italic'].includes(style) ||
        !Number.isInteger(weight) ||
        weight < 100 ||
        weight > 900 ||
        header(request.headers['x-font-content-hash']) !== contentHash
      ) {
        return reply.code(400).send({ error: 'font_metadata_invalid' });
      }
      const licenseNote = decodedHeader(request.headers['x-font-license-note']).slice(0, 500) || undefined;
      const storageKey = `${config.defaultUserId}/fonts/${request.params.fontId}/${fileName}`;
      await putRawBookObject(createS3Client(config), config, storageKey, request.body, contentType);
      const now = new Date().toISOString();
      try {
        const result = await pool.query(
          `insert into user_fonts
             (id, user_id, family_label, file_name, style, weight, content_hash, content_type, byte_length, storage_key, license_note, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
           on conflict (id) do update set family_label = excluded.family_label, file_name = excluded.file_name,
             style = excluded.style, weight = excluded.weight, content_hash = excluded.content_hash,
             content_type = excluded.content_type, byte_length = excluded.byte_length, storage_key = excluded.storage_key,
             license_note = excluded.license_note, updated_at = excluded.updated_at
           where user_fonts.user_id = excluded.user_id returning *`,
          [
            request.params.fontId,
            config.defaultUserId,
            familyLabel,
            fileName,
            style,
            weight,
            contentHash,
            contentType,
            request.body.length,
            storageKey,
            licenseNote,
            now,
          ],
        );
        if (!result.rows[0]) throw new Error('font_owner_mismatch');
        return { font: fontRow(result.rows[0]) };
      } catch (error) {
        await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
        if (error instanceof Error && 'code' in error && error.code === '23505')
          return reply.code(409).send({ error: 'font_duplicate' });
        throw error;
      }
    },
  );

  app.patch<{ Params: { fontId: string }; Body: { familyLabel?: string; licenseNote?: string } }>(
    '/api/fonts/:fontId',
    async (request, reply) => {
      const familyLabel = request.body?.familyLabel?.trim().slice(0, 120);
      if (!familyLabel) return reply.code(400).send({ error: 'font_family_required' });
      const result = await pool.query(
        `update user_fonts set family_label = $1, license_note = $2, updated_at = now()
         where id = $3 and user_id = $4 returning *`,
        [
          familyLabel,
          request.body.licenseNote?.trim().slice(0, 500) || null,
          request.params.fontId,
          config.defaultUserId,
        ],
      );
      return result.rows[0] ? { font: fontRow(result.rows[0]) } : reply.code(404).send({ error: 'font_not_found' });
    },
  );

  app.delete<{ Params: { fontId: string } }>('/api/fonts/:fontId', async (request, reply) => {
    const result = await pool.query('delete from user_fonts where id = $1 and user_id = $2 returning storage_key', [
      request.params.fontId,
      config.defaultUserId,
    ]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'font_not_found' });
    await deleteObject(createS3Client(config), config, String(result.rows[0].storage_key)).catch(() => undefined);
    return { ok: true };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/reading-sessions', async (request, reply) => {
    const body = request.body ?? {};
    const startedAt = safeDate(body.startedAt);
    const endedAt = safeDate(body.endedAt);
    const activeSeconds = Number(body.activeSeconds);
    if (
      typeof body.id !== 'string' ||
      typeof body.operationId !== 'string' ||
      typeof body.deviceId !== 'string' ||
      typeof body.bookId !== 'string' ||
      !['reading', 'listening'].includes(String(body.mode)) ||
      !startedAt ||
      !endedAt ||
      endedAt < startedAt ||
      !Number.isInteger(activeSeconds) ||
      activeSeconds < 1 ||
      activeSeconds > 86400
    ) {
      return reply.code(400).send({ error: 'reading_session_invalid' });
    }
    const result = await pool.query(
      `insert into reading_session_events
         (id,user_id,book_id,device_id,mode,started_at,ended_at,active_seconds,start_anchor,end_anchor,characters_advanced,operation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (user_id, operation_id) do update set operation_id = excluded.operation_id returning *`,
      [
        body.id,
        config.defaultUserId,
        body.bookId,
        body.deviceId,
        body.mode,
        startedAt,
        endedAt,
        activeSeconds,
        body.startAnchor ?? null,
        body.endAnchor ?? null,
        body.charactersAdvanced ?? null,
        body.operationId,
      ],
    );
    return { session: sessionRow(result.rows[0]) };
  });

  app.get<{ Querystring: { bookId?: string; from?: string; to?: string } }>(
    '/api/reading-sessions',
    async (request) => {
      const values: unknown[] = [config.defaultUserId];
      const where = ['user_id = $1'];
      if (request.query.bookId) {
        values.push(request.query.bookId);
        where.push(`book_id = $${values.length}`);
      }
      if (safeDate(request.query.from)) {
        values.push(safeDate(request.query.from));
        where.push(`ended_at >= $${values.length}`);
      }
      if (safeDate(request.query.to)) {
        values.push(safeDate(request.query.to));
        where.push(`started_at <= $${values.length}`);
      }
      const result = await pool.query(
        `select * from reading_session_events where ${where.join(' and ')} order by ended_at desc limit 5000`,
        values,
      );
      return { sessions: result.rows.map(sessionRow) };
    },
  );

  app.delete<{ Querystring: { bookId?: string; before?: string } }>('/api/reading-sessions', async (request) => {
    const values: unknown[] = [config.defaultUserId];
    const where = ['user_id = $1'];
    if (request.query.bookId) {
      values.push(request.query.bookId);
      where.push(`book_id = $${values.length}`);
    }
    if (safeDate(request.query.before)) {
      values.push(safeDate(request.query.before));
      where.push(`ended_at < $${values.length}`);
    }
    const result = await pool.query(
      `delete from reading_session_events where ${where.join(' and ')} returning id`,
      values,
    );
    return { deleted: result.rowCount ?? 0 };
  });
}
