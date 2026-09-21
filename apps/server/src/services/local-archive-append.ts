import type { LocalArchiveSeries } from '@noveldesk/document-series-core';
import type pg from 'pg';
import type { ParsedNovelImport, ParsedNovelImportAsset } from '@noveldesk/contracts';
import { LOCAL_ARCHIVE_SERIES_TYPE, isLocalArchiveSeries } from '@noveldesk/document-series-core';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';

export type StoredAppendAsset = Omit<ParsedNovelImportAsset, 'bytes'> & { byteLength: number; storageKey: string };
export interface LocalAppendBase {
  id: string;
  format: 'epub' | 'image_archive';
  active_content_revision_id: string;
  source_file_name: string;
  storage_key: string;
  content_type: string;
  raw_text_hash: string;
  size_bytes: string;
  normalized_text_hash: string;
  total_chapters: number;
  total_paragraphs: number;
  total_characters: number;
  document_section_count: number | null;
  chapter_index: number;
  raw_end: number;
  assets: StoredAppendAsset[];
}

export async function loadLocalAppendBase(
  client: pg.PoolClient,
  userId: string,
  bookId: string,
  fileName: string,
): Promise<LocalAppendBase> {
  const result = await client.query<Omit<LocalAppendBase, 'assets'>>(
    `
    select book.id, book.format, book.active_content_revision_id, book.source_file_name,
           object.storage_key, object.content_type, object.raw_text_hash, object.size_bytes,
           book.normalized_text_hash, book.total_chapters, book.total_paragraphs, book.total_characters,
           book.document_section_count,
           coalesce((select max(chapter_index) from chapters where book_id=book.id),0)::integer as chapter_index,
           coalesce((select max(raw_end_offset) from chapters where book_id=book.id),0) as raw_end
      from library_books book join book_objects object on object.id=book.object_id
     where book.id=$1 and book.user_id=$2 and book.deleted_at is null`,
    [bookId, userId],
  );
  const base = result.rows[0];
  if (!base || !base.active_content_revision_id) throw new Error('회차를 추가할 작품을 찾지 못했습니다.');
  const format = /\.epub$/iu.test(fileName) ? 'epub' : /\.(zip|cbz)$/iu.test(fileName) ? 'image_archive' : undefined;
  if (base.format !== format) throw new Error('기존 작품과 같은 형식의 EPUB 또는 ZIP·CBZ를 선택해 주세요.');
  const assets = await client.query(
    `select id, kind, provenance, storage_key, file_name, content_type,
      content_hash, byte_length, page_index from book_assets
    where book_id=$1 and user_id=$2 and status='active'
      and kind in ('epub_resource','document_page','source_part') order by page_index nulls last, id`,
    [bookId, userId],
  );
  return {
    ...base,
    assets: assets.rows.map((row) => ({
      id: row.id,
      bookId,
      kind: row.kind,
      provenance: row.provenance,
      storageKey: row.storage_key,
      fileName: row.file_name,
      contentType: row.content_type,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length),
      pageIndex: row.page_index ?? undefined,
    })),
  };
}

export function localAppendAlreadyPresent(base: LocalAppendBase, hash: string): boolean {
  return base.raw_text_hash === hash || base.assets.some((a) => a.kind === 'source_part' && a.contentHash === hash);
}

export function localSourceAsset(
  bookId: string,
  hash: string,
  fileName: string,
  contentType: string,
  byteLength: number,
  pageIndex: number,
): Omit<StoredAppendAsset, 'storageKey'> {
  return {
    id: persistentId128('local_source_part', [bookId, hash]),
    bookId,
    kind: 'source_part',
    provenance: 'archive_embedded',
    fileName,
    contentType,
    contentHash: hash,
    byteLength,
    pageIndex,
  };
}

export function localAppendSource(base: LocalAppendBase, parts: StoredAppendAsset[]): { blob: Blob; hash: string } {
  const manifest: LocalArchiveSeries = {
    version: 1,
    bookId: base.id,
    format: base.format,
    sources: parts
      .filter((p) => p.kind === 'source_part')
      .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0))
      .map((p) => ({
        assetId: p.id,
        fileName: p.fileName,
        contentHash: p.contentHash,
        byteLength: p.byteLength,
        contentType: p.contentType,
      })),
  };
  if (!isLocalArchiveSeries(manifest)) throw new Error('합친 작품의 원본 목록 한도를 초과했습니다.');
  const json = JSON.stringify(manifest);
  return { blob: new Blob([json], { type: LOCAL_ARCHIVE_SERIES_TYPE }), hash: integrityHash(json) };
}

/** Append-only: old chapters, paragraphs and assets are never regenerated. */
export function offsetLocalAppend(
  parsed: ParsedNovelImport,
  base: LocalAppendBase,
  sourceHash: string,
  title: string,
): ParsedNovelImport {
  const offset = Number(base.raw_end) + 3;
  const sectionId = persistentId128('local_archive_section', [base.id, sourceHash]);
  const pageOffset = base.assets.reduce(
    (max, a) => (a.kind === 'document_page' ? Math.max(max, (a.pageIndex ?? -1) + 1) : max),
    0,
  );
  const chapters = parsed.chapters.map((chapter, index) => ({
    ...chapter,
    id: persistentId128('local_append_chapter', [base.id, sourceHash, chapter.id]),
    index: Number(base.chapter_index) + index + 1,
    rawStartOffset: chapter.rawStartOffset + offset,
    rawEndOffset: chapter.rawEndOffset + offset,
    ...(base.format === 'image_archive'
      ? {
          documentSectionId: sectionId,
          documentSectionTitle: title,
          documentSectionIndex: (base.document_section_count ?? 1) + 1,
          documentPageIndexInSection: index + 1,
          documentSectionSourceContentHash: sourceHash,
        }
      : {}),
  }));
  const sourceHref = (href: string | undefined) =>
    href && !/^https?:\/\//iu.test(href) ? `.moya-append/${sourceHash}/${href}` : href;
  if (
    Number(base.total_characters) + parsed.novel.totalCharacters > 2_147_483_647 ||
    chapters.some((chapter) => chapter.rawEndOffset > 2_147_483_647)
  )
    throw new Error('작품의 전체 본문 길이 한도를 초과했습니다. 별도 작품으로 가져와 주세요.');
  const mapping = new Map(parsed.chapters.map((chapter, index) => [chapter.id, chapters[index]!]));
  return {
    ...parsed,
    chapters,
    novel: {
      ...parsed.novel,
      totalChapters: Number(base.total_chapters) + parsed.novel.totalChapters,
      totalParagraphs: Number(base.total_paragraphs) + parsed.novel.totalParagraphs,
      totalCharacters: Number(base.total_characters) + parsed.novel.totalCharacters,
      normalizedTextHash: integrityHash(
        JSON.stringify([base.normalized_text_hash, sourceHash, parsed.novel.normalizedTextHash]),
      ),
      ...(base.format === 'image_archive' ? { documentSectionCount: (base.document_section_count ?? 1) + 1 } : {}),
    },
    async *consumeChapterParagraphs() {
      for await (const row of parsed.consumeChapterParagraphs()) {
        const chapter = mapping.get(row.chapter.id)!;
        yield {
          chapter,
          paragraphs: Array.from(row.paragraphs, (p) => ({
            ...p,
            chapterId: chapter.id,
            id: persistentId128('local_append_paragraph', [base.id, sourceHash, p.id]),
            ...(base.format === 'epub'
              ? {
                  sourceHref: sourceHref(p.sourceHref),
                  inlineMarks: p.inlineMarks?.map((mark) =>
                    mark.kind === 'link' ? { ...mark, href: sourceHref(mark.href) } : mark,
                  ),
                  inlineSemantics: p.inlineSemantics?.map((semantic) =>
                    semantic.kind === 'footnote_reference'
                      ? { ...semantic, relatedBlockId: sourceHref(semantic.relatedBlockId) }
                      : semantic,
                  ),
                }
              : {}),
          })),
        };
      }
    },
    consumeEmbeddedAssets: parsed.consumeEmbeddedAssets
      ? async function* () {
          for await (const asset of parsed.consumeEmbeddedAssets!())
            yield {
              ...asset,
              ...(asset.kind === 'document_page' ? { pageIndex: pageOffset + (asset.pageIndex ?? 0) } : {}),
            };
        }
      : undefined,
  };
}

/** A formerly standalone comic becomes the first volume; only a fully read volume gets a read marker. */
export async function promoteLocalComicSection(
  client: pg.PoolClient,
  base: LocalAppendBase,
  userId: string,
): Promise<void> {
  const sectionId = persistentId128('local_archive_section', [base.id, base.raw_text_hash]);
  const updated = await client.query(
    `update chapters set document_section_id=$2, document_section_title=$3,
      document_section_index=1,document_page_index_in_section=chapter_index
      where book_id=$1 and document_section_id is null`,
    [base.id, sectionId, base.source_file_name.replace(/\.(zip|cbz)$/iu, '')],
  );
  if (!updated.rowCount) return;
  await client.query(
    `insert into fixed_document_section_read_states (book_id,user_id,document_section_id,last_read_at)
      select $1,$2,$3,max(state.last_read_at) from chapters chapter
      left join fixed_document_section_read_states state on state.book_id=chapter.book_id
        and state.user_id=$2 and state.document_section_id=chapter.id
      where chapter.book_id=$1 and chapter.document_section_id=$3
      having count(*)>0 and count(*)=count(state.last_read_at)
      on conflict (book_id,user_id,document_section_id) do nothing`,
    [base.id, userId, sectionId],
  );
}
