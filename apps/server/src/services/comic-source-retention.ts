import type pg from 'pg';
import type { ParsedNovelImportAsset } from '@noveldesk/contracts';
import { validateComicPart, type ComicSourceAppendPlan } from '@noveldesk/fixed-document-core/comic-source';

export type RetainedComicAsset = Omit<ParsedNovelImportAsset, 'bytes'> & { byteLength: number; storageKey: string };

/** Metadata-only normal path. Missing page objects are repaired from their own part, never from a rebuilt series. */
export async function retainComicAssets(input: {
  client: Pick<pg.PoolClient, 'query'>;
  userId: string;
  bookId: string;
  plan: ComicSourceAppendPlan;
  inspect: (key: string) => Promise<{ byteLength?: number; contentType?: string } | undefined>;
  read: (key: string) => Promise<Blob>;
  pageParts: Map<string, Blob>;
  pageIds: Set<string>;
}): Promise<RetainedComicAsset[]> {
  const ids = [...input.plan.retainedPageIds, ...input.plan.retainedPartIds];
  const result = await input.client.query<{
    id: string;
    kind: 'document_page' | 'source_part';
    provenance: 'archive_embedded';
    file_name: string;
    content_type: string;
    content_hash: string;
    byte_length: string;
    storage_key: string;
    page_index: number | null;
  }>(
    `select id, kind, provenance, file_name, content_type, content_hash, byte_length, storage_key, page_index
       from book_assets where user_id = $1 and book_id = $2 and status = 'active' and id = any($3::text[])
         and kind in ('document_page', 'source_part')`,
    [input.userId, input.bookId, ids],
  );
  if (result.rows.length !== ids.length) throw new Error('기존 만화 회차 리소스가 누락되어 변경하지 않았습니다.');
  const pageById = new Map(
    input.plan.manifest.sourcePages.map((page, index) => [input.plan.pageAssetIds[index]!, { page, index }]),
  );
  const retained: RetainedComicAsset[] = [];
  const missingPartHashes = new Set<string>();
  const checks = new Map<string, ReturnType<typeof input.inspect>>();
  for (let offset = 0; offset < result.rows.length; offset += 8) {
    await Promise.all(
      result.rows.slice(offset, offset + 8).map(async (asset) => {
        let pending = checks.get(asset.storage_key);
        if (!pending) {
          pending = input.inspect(asset.storage_key);
          checks.set(asset.storage_key, pending);
        }
        const stored = await pending;
        const valid = stored?.byteLength === Number(asset.byte_length) && stored.contentType === asset.content_type;
        if (!valid) {
          if (asset.kind === 'source_part') throw new Error('기존 만화 회차 원본이 저장소에 없어 변경하지 않았습니다.');
          const page = pageById.get(asset.id)!.page;
          input.pageIds.add(asset.id);
          missingPartHashes.add(page.partHash);
          return;
        }
        retained.push({
          id: asset.id,
          bookId: input.bookId,
          kind: asset.kind,
          provenance: asset.provenance,
          fileName: asset.file_name,
          contentType: asset.content_type,
          contentHash: asset.content_hash,
          byteLength: Number(asset.byte_length),
          storageKey: asset.storage_key,
          pageIndex: pageById.get(asset.id)?.index,
        });
      }),
    );
  }
  for (const hash of missingPartHashes) {
    const part = input.plan.newParts.get(hash);
    if (part) {
      input.pageParts.set(hash, part);
      continue;
    }
    const asset = retained.find((item) => item.kind === 'source_part' && item.contentHash === hash);
    if (!asset) throw new Error('복구할 만화 회차의 원본을 찾지 못했습니다.');
    const blob = await input.read(asset.storageKey);
    await validateComicPart(
      input.plan.manifest.sourceParts.find((part) => part.contentHash === hash)!,
      blob,
    );
    input.pageParts.set(hash, blob);
  }
  return retained;
}
