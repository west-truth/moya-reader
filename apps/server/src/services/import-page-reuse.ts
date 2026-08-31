import type pg from 'pg';
import type { ParsedNovelImportAsset } from '@noveldesk/contracts';

interface PageCandidate {
  storage_key: string;
  content_hash: string;
  content_type: string;
  byte_length: number | string;
}

interface ObjectMetadata {
  byteLength?: number;
  contentType?: string;
}

const pageKey = (hash: string, size: number, type: string) => JSON.stringify([hash, size, type]);

/** Request-scoped reuse, never a cross-book cache or an asset identity migration. */
export async function loadImportPageReuse(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string,
  bookId: string,
  inspectObject: (key: string) => Promise<ObjectMetadata | undefined>,
): Promise<(asset: ParsedNovelImportAsset) => Promise<string | undefined>> {
  const result = await client.query<PageCandidate>(
    `select storage_key, content_hash, content_type, byte_length from book_assets
      where user_id = $1 and book_id = $2 and kind = 'document_page' and status = 'active'
      order by id`,
    [userId, bookId],
  );
  const candidates = new Map<string, PageCandidate>();
  for (const row of result.rows) {
    const size = Number(row.byte_length);
    if (!/^sha256:[a-f0-9]{64}$/.test(row.content_hash ?? '') || !Number.isSafeInteger(size) || size <= 0) continue;
    const key = pageKey(row.content_hash, size, row.content_type);
    if (!candidates.has(key)) candidates.set(key, row);
  }
  const checks = new Map<string, Promise<ObjectMetadata | undefined>>();
  return async (asset) => {
    if (asset.kind !== 'document_page') return undefined;
    const candidate = candidates.get(pageKey(asset.contentHash, asset.bytes.byteLength, asset.contentType));
    if (!candidate) return undefined;
    let check = checks.get(candidate.storage_key);
    if (!check) {
      // A missing object is repaired from the verified archive bytes. Connectivity/auth
      // errors propagate; they must not silently trigger a full rewrite during an outage.
      check = inspectObject(candidate.storage_key);
      checks.set(candidate.storage_key, check);
    }
    const metadata = await check;
    return metadata?.byteLength === asset.bytes.byteLength && metadata.contentType === asset.contentType
      ? candidate.storage_key
      : undefined;
  };
}
