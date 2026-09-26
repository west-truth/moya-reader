import { createHash } from 'node:crypto';
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js';
import { persistentId128 } from '@noveldesk/text-core/hash';
import type { BackupManifestV1 } from '../../../../src/repositories/backup-repository.js';
import {
  HOSTED_BACKUP_FORMAT,
  HOSTED_BACKUP_VERSION,
  type HostedBackupAsset,
  type HostedBackupBook,
  type HostedBackupManifestV1,
  type HostedBackupTableName,
  type HostedBookObjectRow,
  type ParsedHostedBackupArchive,
} from './hosted-backup-archive.js';

const MAX_LOCAL_ENTRIES = 500;
const MAX_LOCAL_BYTES = 256 * 1024 * 1024;
const CORE_STORES = new Set([
  'novels',
  'book_content_revisions',
  'book_content_chapters',
  'book_content_paragraphs',
  'book_content_paragraph_pages',
  'book_content_domain_heads',
  'book_assets',
  'settings',
  'reading_positions',
  'bookmarks',
  'highlights',
  'notes',
  'listening_positions',
  'document_annotations',
]);

type Row = Record<string, unknown>;

function record(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return value as Row;
}

function rows(value: unknown, label: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`${label} 목록이 올바르지 않습니다.`);
  return value.map((item) => record(item, label));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} 값이 없습니다.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return Number(value);
}

function hash(value: Blob | Uint8Array | string): Promise<string> | string {
  if (value instanceof Blob)
    return value
      .arrayBuffer()
      .then((bytes) => `sha256:${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`);
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safePath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function add(tables: Map<HostedBackupTableName, Row[]>, name: HostedBackupTableName, value: Row) {
  const existing = tables.get(name) ?? [];
  existing.push(value);
  tables.set(name, existing);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function rejectPopulated(row: Row, fields: readonly string[], label: string): void {
  for (const field of fields) {
    const value = row[field];
    if (value !== undefined && value !== null && value !== '' && value !== false && value !== 0) {
      throw new Error(`${label}: ${field} 항목은 아직 무손실 이전할 수 없습니다. 원본 ZIP은 보존됩니다.`);
    }
  }
}

function assertUniqueIds(items: readonly Row[], label: string): void {
  const ids = items.map((item) => requiredString(item.id, `${label} ID`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ID가 중복되었습니다.`);
}

function assertKnownFields(row: Row, label: string, fields: readonly string[]): void {
  const known = new Set(fields);
  for (const key of Object.keys(row)) {
    if (!known.has(key)) {
      throw new Error(`${label}: ${key} 항목의 이전 규칙이 없습니다. 원본 ZIP은 보존됩니다.`);
    }
  }
}

const NOVEL_FIELDS = [
  'id',
  'cloudVaultBookId',
  'activeContentRevisionId',
  'sourceAssetId',
  'sourceProvenance',
  'sourceByteLength',
  'sourceContentType',
  'sourceContentHash',
  'format',
  'title',
  'author',
  'seriesTitle',
  'seriesIndex',
  'tags',
  'description',
  'language',
  'readingDirection',
  'coverAssetId',
  'coverContentHash',
  'coverFit',
  'coverPositionX',
  'coverPositionY',
  'coverUpdatedAt',
  'coverRemovedAt',
  'sourceFileName',
  'sourceEncoding',
  'rawText',
  'normalizedText',
  'rawTextHash',
  'normalizedTextHash',
  'createdAt',
  'updatedAt',
  'totalChapters',
  'documentSectionCount',
  'totalCharacters',
  'totalParagraphs',
  'coverSeed',
  'lastReadChapterId',
  'lastReadChapterIndex',
  'lastReadParagraphId',
  'lastReadOffset',
  'lastReadProgress',
  'readingSeconds',
  'lastReadAt',
  'favorite',
  'analysisStatus',
  'metadataRevision',
  'deletedAt',
  'deletedByDeviceId',
] as const;
const REVISION_FIELDS = [
  'id',
  'novelId',
  'status',
  'source',
  'sourceRevision',
  'sourceHash',
  'normalizedHash',
  'baseActiveRevisionId',
  'baseNovelPresent',
  'baseMutableMetadata',
  'expected',
  'stagedCounts',
  'actual',
  'composition',
  'createdAt',
  'activatedAt',
] as const;
const CHAPTER_FIELDS = [
  'id',
  'novelId',
  'index',
  'title',
  'normalizedText',
  'textHash',
  'rawStartOffset',
  'rawEndOffset',
  'characterCount',
  'paragraphCount',
  'documentSectionId',
  'documentSectionTitle',
  'documentSectionIndex',
  'documentPageIndexInSection',
  'documentSectionSourceContentHash',
  'documentSectionRemoteRevision',
  'documentSectionReadAt',
  'createdAt',
  'updatedAt',
  'storageId',
  'contentRevisionId',
] as const;
const PAGE_FIELDS = [
  'id',
  'novelId',
  'chapterId',
  'pageIndex',
  'startParagraphIndex',
  'endParagraphIndex',
  'paragraphs',
  'paragraphIds',
  'textHash',
  'createdAt',
  'storageId',
  'contentRevisionId',
] as const;
const PARAGRAPH_FIELDS = [
  'id',
  'novelId',
  'chapterId',
  'index',
  'text',
  'startOffsetInChapter',
  'endOffsetInChapter',
  'textHash',
  'documentKind',
  'inlineMarks',
  'inlineSemantics',
  'assetId',
  'sourceHref',
  'documentPageType',
  'documentPageDouble',
  'sourceLocator',
] as const;
const ASSET_FIELDS = [
  'id',
  'bookId',
  'contentRevisionId',
  'kind',
  'provenance',
  'status',
  'storageKey',
  'fileName',
  'contentType',
  'byteLength',
  'contentHash',
  'encoding',
  'pixelWidth',
  'pixelHeight',
  'pageIndex',
  'createdAt',
  'activatedAt',
] as const;
const POSITION_FIELDS = [
  'id',
  'novelId',
  'chapterId',
  'paragraphId',
  'paragraphIndex',
  'offsetInParagraph',
  'chapterProgress',
  'scrollTop',
  'deviceId',
  'updatedAt',
  'anchor',
] as const;
const BOOKMARK_FIELDS = [
  'id',
  'novelId',
  'chapterId',
  'paragraphId',
  'label',
  'progress',
  'scrollTop',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;
const HIGHLIGHT_FIELDS = [
  'id',
  'novelId',
  'chapterId',
  'paragraphId',
  'quote',
  'color',
  'progress',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;
const NOTE_FIELDS = [
  'id',
  'novelId',
  'chapterId',
  'paragraphId',
  'quote',
  'body',
  'progress',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;
const LISTENING_FIELDS = [
  'id',
  'bookId',
  'chapterId',
  'anchor',
  'queueItemFingerprint',
  'contentRevisionId',
  'settingsFingerprint',
  'deviceId',
  'updatedAt',
] as const;
const DOCUMENT_ANNOTATION_FIELDS = [
  'id',
  'bookId',
  'pageIndex',
  'type',
  'anchor',
  'quote',
  'body',
  'color',
  'textAnchorRemap',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;

/** Converts only verified local v1 records into the existing hosted restore model. */
export async function convertLocalBackup(
  archive: Blob,
  userId: string,
  archiveHash: string,
  signal?: AbortSignal,
): Promise<ParsedHostedBackupArchive> {
  const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false, signal });
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory);
    if (entries.length === 0 || entries.length > MAX_LOCAL_ENTRIES)
      throw new Error('로컬 백업 파일 수 제한을 초과했습니다.');
    const paths = new Set<string>();
    let totalUncompressedBytes = 0;
    for (const entry of entries) {
      if (!safePath(entry.filename) || paths.has(entry.filename))
        throw new Error('로컬 백업 경로가 중복되거나 안전하지 않습니다.');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0)
        throw new Error('로컬 백업 파일 크기가 올바르지 않습니다.');
      paths.add(entry.filename);
      totalUncompressedBytes += entry.uncompressedSize;
    }
    if (totalUncompressedBytes > MAX_LOCAL_BYTES) throw new Error('로컬 백업 압축 해제 크기 제한을 초과했습니다.');
    const manifestEntry = entries.find((entry) => entry.filename === 'manifest.json');
    if (!manifestEntry?.getData || manifestEntry.uncompressedSize > 16 * 1024 * 1024)
      throw new Error('로컬 백업 목록이 없습니다.');
    const manifest = record(
      JSON.parse(await manifestEntry.getData(new TextWriter(), { checkSignature: true })),
      '백업 목록',
    ) as unknown as BackupManifestV1;
    if (manifest.format !== 'noveldesk-backup' || manifest.version !== 1 || 'backend' in manifest) {
      throw new Error('지원하지 않는 로컬 백업 버전입니다.');
    }
    if (!Array.isArray(manifest.books) || !Array.isArray(manifest.entries) || !Array.isArray(manifest.assetBlobs)) {
      throw new Error('로컬 백업 목록이 올바르지 않습니다.');
    }
    const listed = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const assets = new Map(manifest.assetBlobs.map((asset) => [asset.path, asset]));
    if (
      listed.size !== entries.length - 1 ||
      listed.size !== manifest.entries.length ||
      assets.size !== manifest.assetBlobs.length
    ) {
      throw new Error('로컬 백업 목록과 ZIP 내용이 일치하지 않습니다.');
    }
    const stores = new Map<string, Row[]>();
    const blobs = new Map<string, Blob>();
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.filename === 'manifest.json') continue;
      const expected = listed.get(entry.filename);
      if (
        !expected ||
        expected.byteLength !== entry.uncompressedSize ||
        !/^sha256:[0-9a-f]{64}$/i.test(expected.contentHash) ||
        !entry.getData
      ) {
        throw new Error(`로컬 백업 파일 목록이 올바르지 않습니다: ${entry.filename}`);
      }
      const blob = await entry.getData(new BlobWriter(expected.contentType), { checkSignature: true });
      if (blob.size !== expected.byteLength || (await hash(blob)) !== expected.contentHash.toLowerCase()) {
        throw new Error(`로컬 백업 파일 무결성 검사에 실패했습니다: ${entry.filename}`);
      }
      if (entry.filename.startsWith('stores/') && entry.filename.endsWith('.json')) {
        const name = entry.filename.slice(7, -5);
        if (stores.has(name)) throw new Error(`로컬 백업 저장소가 중복되었습니다: ${name}`);
        const contents = rows(JSON.parse(await blob.text()), name);
        if (!CORE_STORES.has(name) && contents.length > 0) {
          throw new Error(
            `아직 이전할 수 없는 로컬 자료가 있습니다: ${name} (${contents.length}개). 원본 ZIP은 보존됩니다.`,
          );
        }
        stores.set(name, contents);
      } else {
        const asset = assets.get(entry.filename);
        if (
          !asset ||
          asset.contentHash.toLowerCase() !== expected.contentHash.toLowerCase() ||
          asset.byteLength !== expected.byteLength ||
          blobs.has(asset.storageKey)
        ) {
          throw new Error(`로컬 백업 자산 목록이 올바르지 않습니다: ${entry.filename}`);
        }
        blobs.set(asset.storageKey, blob);
      }
    }
    if (!stores.has('novels') || blobs.size !== manifest.assetBlobs.length)
      throw new Error('로컬 백업 작품 또는 원본이 누락되었습니다.');
    return mapLocalStores(stores, blobs, manifest, userId, archiveHash, totalUncompressedBytes);
  } finally {
    await reader.close();
  }
}

function mapLocalStores(
  stores: Map<string, Row[]>,
  blobs: Map<string, Blob>,
  localManifest: BackupManifestV1,
  userId: string,
  archiveHash: string,
  totalUncompressedBytes: number,
): ParsedHostedBackupArchive {
  const tables = new Map<HostedBackupTableName, Row[]>();
  const objects: HostedBookObjectRow[] = [];
  const assetBlobs = new Map<string, Blob>();
  const hostedAssets: HostedBackupAsset[] = [];
  const bookRows = stores.get('novels') ?? [];
  const revisionRows = stores.get('book_content_revisions') ?? [];
  const chapterRows = stores.get('book_content_chapters') ?? [];
  const pageRows = stores.get('book_content_paragraph_pages') ?? [];
  const localAssets = stores.get('book_assets') ?? [];
  const positionRows = stores.get('reading_positions') ?? [];
  const books: HostedBackupBook[] = [];
  if (bookRows.length !== localManifest.books.length) throw new Error('로컬 백업 작품 목록이 일치하지 않습니다.');
  assertUniqueIds(bookRows, '작품');
  assertUniqueIds(revisionRows, '내용 revision');
  assertUniqueIds(chapterRows, '회차');
  assertUniqueIds(pageRows, '문단 페이지');
  assertUniqueIds(localAssets, '자산');
  for (const row of bookRows) assertKnownFields(row, '작품', NOVEL_FIELDS);
  for (const row of revisionRows) assertKnownFields(row, '내용 revision', REVISION_FIELDS);
  for (const row of chapterRows) assertKnownFields(row, '회차', CHAPTER_FIELDS);
  for (const row of pageRows) {
    assertKnownFields(row, '문단 페이지', PAGE_FIELDS);
    for (const paragraph of Array.isArray(row.paragraphs) ? row.paragraphs : []) {
      assertKnownFields(record(paragraph, '문단'), '문단', PARAGRAPH_FIELDS);
    }
  }
  for (const row of localAssets) assertKnownFields(row, '자산', ASSET_FIELDS);
  if (revisionRows.length !== bookRows.length) {
    throw new Error('활성 revision 외의 내용 revision은 아직 이전할 수 없습니다. 원본 ZIP은 보존됩니다.');
  }

  for (const novel of bookRows) {
    const id = requiredString(novel.id, '작품 ID');
    rejectPopulated(novel, ['cloudVaultBookId', 'readingDirection', 'rawText', 'normalizedText', 'readingSeconds'], id);
    if (novel.deletedAt || novel.deletedByDeviceId) {
      throw new Error(`${id}: 삭제된 작품의 이전은 아직 지원하지 않습니다. 원본 ZIP은 보존됩니다.`);
    }
    const position = positionRows.find((row) => row.novelId === id);
    if (
      (novel.lastReadChapterId ||
        novel.lastReadParagraphId ||
        novel.lastReadAt ||
        novel.lastReadOffset ||
        novel.lastReadProgress) &&
      (!position ||
        position.chapterId !== novel.lastReadChapterId ||
        position.paragraphId !== novel.lastReadParagraphId ||
        position.scrollTop !== novel.lastReadOffset)
    ) {
      throw new Error(`${id}: 작품의 마지막 독서 상태와 독서 위치가 일치하지 않습니다.`);
    }
    if (
      position &&
      ((novel.lastReadChapterIndex !== undefined &&
        novel.lastReadChapterIndex !== chapterRows.find((chapter) => chapter.id === position.chapterId)?.index) ||
        (novel.lastReadAt && novel.lastReadAt !== position.updatedAt))
    ) {
      throw new Error(`${id}: 마지막 독서 시각 또는 회차 순서가 일치하지 않습니다.`);
    }
    const revisionId = requiredString(novel.activeContentRevisionId, `${id} 활성 revision`);
    const revision = revisionRows.find((row) => row.id === revisionId && row.novelId === id && row.status === 'active');
    if (!revision) throw new Error(`${id} 활성 revision을 찾을 수 없습니다. 기존 형식 이전은 아직 지원하지 않습니다.`);
    rejectPopulated(revision, ['sourceRevision', 'stagedCounts'], `${id} revision`);
    const sourceAssetId = requiredString(novel.sourceAssetId, `${id} 원본 자산 ID`);
    const source = localAssets.find(
      (row) => row.id === sourceAssetId && row.bookId === id && row.kind === 'source' && row.status === 'active',
    );
    if (localAssets.filter((asset) => asset.bookId === id && asset.kind === 'source').length !== 1) {
      throw new Error(`${id} 원본 자산이 중복되었습니다.`);
    }
    if (
      !source ||
      source.contentRevisionId !== revisionId ||
      source.contentHash !== novel.sourceContentHash ||
      source.contentHash !== revision.sourceHash ||
      source.contentHash !== novel.rawTextHash ||
      source.byteLength !== novel.sourceByteLength ||
      source.contentType !== novel.sourceContentType ||
      source.provenance !== novel.sourceProvenance ||
      revision.normalizedHash !== novel.normalizedTextHash ||
      revision.composition ||
      revision.baseActiveRevisionId ||
      revision.source !== 'local_import'
    )
      throw new Error(`${id} 원본 자산 참조가 일치하지 않습니다.`);
    const manifestBook = localManifest.books.find((book) => book.id === id);
    if (
      !manifestBook ||
      manifestBook.activeContentRevisionId !== revisionId ||
      manifestBook.format !== novel.format ||
      manifestBook.title !== novel.title
    ) {
      throw new Error(`${id} 백업 작품 정보가 일치하지 않습니다.`);
    }
    if (novel.coverAssetId) {
      const cover = localAssets.find(
        (asset) =>
          asset.id === novel.coverAssetId && asset.bookId === id && asset.kind === 'cover' && asset.status === 'active',
      );
      if (
        !cover ||
        cover.contentHash !== novel.coverContentHash ||
        (novel.coverUpdatedAt && novel.coverUpdatedAt !== (cover.activatedAt ?? cover.createdAt))
      ) {
        throw new Error(`${id} 표지 참조가 일치하지 않습니다.`);
      }
    } else if (novel.coverContentHash || novel.coverUpdatedAt) {
      throw new Error(`${id} 표지 이력을 무손실 이전할 수 없습니다. 원본 ZIP은 보존됩니다.`);
    }
    if (localAssets.some((asset) => asset.bookId === id && asset.kind === 'cover' && asset.id !== novel.coverAssetId)) {
      throw new Error(`${id} 활성 표지와 다른 표지 자산은 이전할 수 없습니다.`);
    }
    const original = blobs.get(requiredString(source.storageKey, `${id} 원본 blob 키`));
    if (
      !original ||
      original.size !== source.byteLength ||
      source.contentHash !== hashFromStorageKey(source.storageKey)
    ) {
      throw new Error(`${id} 원본 파일이 누락되거나 해시가 일치하지 않습니다.`);
    }
    const title = requiredString(novel.title, `${id} 제목`);
    books.push({ id, format: requiredString(novel.format, `${id} 형식`), title, activeContentRevisionId: revisionId });
    add(tables, 'library_books', {
      id,
      user_id: userId,
      object_id: sourceAssetId,
      title,
      format: novel.format,
      author: novel.author ?? null,
      series_title: novel.seriesTitle ?? null,
      series_index: novel.seriesIndex ?? null,
      tags: novel.tags ?? [],
      description: novel.description ?? null,
      language: novel.language ?? null,
      cover_fit: novel.coverFit ?? 'crop',
      cover_position_x: novel.coverPositionX ?? 50,
      cover_position_y: novel.coverPositionY ?? 50,
      cover_removed_at: novel.coverRemovedAt ?? null,
      source_file_name: requiredString(novel.sourceFileName, `${id} 파일명`),
      source_encoding: optionalString(novel.sourceEncoding) ?? null,
      normalized_text_hash: requiredString(novel.normalizedTextHash, `${id} 본문 해시`),
      total_chapters: nonNegativeInteger(novel.totalChapters, `${id} 회차 수`),
      total_characters: nonNegativeInteger(novel.totalCharacters, `${id} 글자 수`),
      total_paragraphs: nonNegativeInteger(novel.totalParagraphs, `${id} 문단 수`),
      document_section_count: novel.documentSectionCount ?? null,
      cover_seed: novel.coverSeed ?? 0,
      favorite: novel.favorite ?? false,
      analysis_status: novel.analysisStatus ?? 'not_analyzed',
      metadata_revision: novel.metadataRevision ?? 0,
      active_content_revision_id: revisionId,
      cover_asset_id: novel.coverAssetId ?? null,
      created_at: novel.createdAt,
      updated_at: novel.updatedAt,
    });
    add(tables, 'book_content_revisions', {
      id: revisionId,
      book_id: id,
      revision_number: 1,
      source_object_id: sourceAssetId,
      source_raw_text_hash: source.contentHash,
      normalized_text_hash: revision.normalizedHash,
      source_file_name: novel.sourceFileName,
      source_encoding: novel.sourceEncoding ?? null,
      status: 'active',
      created_at: revision.createdAt,
      activated_at: revision.activatedAt ?? revision.createdAt,
    });
  }

  for (const asset of localAssets) {
    if (asset.status !== 'active') throw new Error(`이전할 수 없는 비활성 자산이 있습니다: ${String(asset.id)}`);
    const id = requiredString(asset.id, '자산 ID');
    const bookId = requiredString(asset.bookId, `${id} 작품 ID`);
    if (!books.some((book) => book.id === bookId)) throw new Error(`${id} 자산 작품을 찾을 수 없습니다.`);
    const kind = requiredString(asset.kind, `${id} 자산 종류`);
    if (!['source', 'cover', 'epub_resource', 'document_page'].includes(kind)) {
      throw new Error(`아직 이전할 수 없는 자산 종류가 있습니다: ${kind}`);
    }
    const blob = blobs.get(requiredString(asset.storageKey, `${id} blob 키`));
    const blobMetadata = localManifest.assetBlobs.find((item) => item.storageKey === asset.storageKey);
    if (!blob || blob.size !== asset.byteLength || asset.contentHash !== hashFromStorageKey(asset.storageKey)) {
      throw new Error(`${id} 자산 파일이 누락되거나 해시가 일치하지 않습니다.`);
    }
    if (
      !blobMetadata ||
      blobMetadata.byteLength !== asset.byteLength ||
      blobMetadata.contentHash !== asset.contentHash ||
      blobMetadata.contentType !== asset.contentType
    ) {
      throw new Error(`${id} 자산의 백업 목록 정보가 일치하지 않습니다.`);
    }
    const book = bookRows.find((row) => row.id === bookId)!;
    if (asset.contentRevisionId !== book.activeContentRevisionId) {
      throw new Error(`${id} 자산의 내용 revision이 일치하지 않습니다.`);
    }
    if (kind === 'source' && asset.encoding !== book.sourceEncoding) {
      throw new Error(`${id} 원본 인코딩이 일치하지 않습니다.`);
    }
    if (kind !== 'source' && asset.encoding) {
      throw new Error(`${id} 자산 인코딩을 이전할 수 없습니다.`);
    }
    const object: HostedBookObjectRow = {
      id,
      raw_text_hash: requiredString(asset.contentHash, `${id} 해시`),
      storage_key: String(asset.storageKey),
      file_name: String(asset.fileName ?? 'source'),
      content_type: requiredString(asset.contentType, `${id} MIME`),
      size_bytes: nonNegativeInteger(asset.byteLength, `${id} 길이`),
      created_at: String(asset.createdAt),
      asset_kind: kind as HostedBookObjectRow['asset_kind'],
    };
    objects.push(object);
    assetBlobs.set(id, blob);
    hostedAssets.push({
      storageKey: id,
      path: `assets/${encodeURIComponent(id)}.bin`,
      contentHash: object.raw_text_hash,
      byteLength: Number(object.size_bytes),
      contentType: object.content_type,
      createdAt: String(object.created_at),
    });
    if (kind === 'source') continue;
    add(tables, 'book_assets', {
      id,
      user_id: userId,
      book_id: bookId,
      kind,
      provenance: asset.provenance,
      status: 'active',
      storage_key: asset.storageKey,
      file_name: asset.fileName,
      content_type: asset.contentType,
      byte_length: asset.byteLength,
      content_hash: asset.contentHash,
      content_revision_id: asset.contentRevisionId,
      page_index: asset.pageIndex ?? null,
      pixel_width: asset.pixelWidth ?? null,
      pixel_height: asset.pixelHeight ?? null,
      created_at: asset.createdAt,
      activated_at: asset.activatedAt ?? asset.createdAt,
    });
  }
  if (new Set(localAssets.map((asset) => asset.storageKey)).size !== blobs.size) {
    throw new Error('사용하지 않는 로컬 자산 blob이 있습니다. 원본 ZIP은 보존됩니다.');
  }
  for (const chapter of chapterRows) {
    rejectPopulated(chapter, ['documentSectionSourceContentHash', 'documentSectionRemoteRevision'], String(chapter.id));
    if (
      !books.some((book) => book.id === chapter.novelId && book.activeContentRevisionId === chapter.contentRevisionId)
    ) {
      throw new Error(`회차 ${String(chapter.id)}의 작품 또는 revision이 일치하지 않습니다.`);
    }
    if (chapter.normalizedText || chapter.storageId !== JSON.stringify([chapter.contentRevisionId, chapter.id])) {
      throw new Error(`회차 ${String(chapter.id)}의 저장 내용이 일치하지 않습니다.`);
    }
    add(tables, 'chapters', {
      id: chapter.id,
      book_id: chapter.novelId,
      chapter_index: chapter.index,
      title: chapter.title,
      text_hash: chapter.textHash,
      raw_start_offset: chapter.rawStartOffset,
      raw_end_offset: chapter.rawEndOffset,
      character_count: chapter.characterCount,
      paragraph_count: chapter.paragraphCount,
      document_section_id: chapter.documentSectionId ?? null,
      document_section_title: chapter.documentSectionTitle ?? null,
      document_section_index: chapter.documentSectionIndex ?? null,
      document_page_index_in_section: chapter.documentPageIndexInSection ?? null,
      created_at: chapter.createdAt,
      updated_at: chapter.updatedAt,
    });
    if (chapter.documentSectionReadAt) {
      const sectionId = chapter.documentSectionId ?? chapter.id;
      const existing = (tables.get('fixed_document_section_read_states') ?? []).find(
        (row) => row.book_id === chapter.novelId && row.document_section_id === sectionId,
      );
      if (existing) {
        if (String(existing.last_read_at) < String(chapter.documentSectionReadAt)) {
          existing.last_read_at = chapter.documentSectionReadAt;
        }
      } else {
        add(tables, 'fixed_document_section_read_states', {
          book_id: chapter.novelId,
          user_id: userId,
          document_section_id: sectionId,
          last_read_at: chapter.documentSectionReadAt,
        });
      }
    }
  }
  for (const page of pageRows) {
    const chapter = chapterRows.find((item) => item.id === page.chapterId && item.novelId === page.novelId);
    if (
      !chapter ||
      page.contentRevisionId !== chapter.contentRevisionId ||
      page.storageId !== JSON.stringify([page.contentRevisionId, page.id]) ||
      !Array.isArray(page.paragraphs) ||
      !Array.isArray(page.paragraphIds) ||
      page.paragraphIds.length !== page.paragraphs.length ||
      page.paragraphIds.some((id, index) => id !== (page.paragraphs as Row[])[index]?.id) ||
      page.paragraphs.some(
        (paragraph) =>
          !paragraph ||
          typeof paragraph !== 'object' ||
          paragraph.chapterId !== chapter.id ||
          paragraph.novelId !== chapter.novelId ||
          (paragraph.assetId &&
            !localAssets.some(
              (asset) =>
                asset.id === paragraph.assetId &&
                asset.bookId === chapter.novelId &&
                (asset.kind === 'document_page' || asset.kind === 'epub_resource'),
            )),
      )
    ) {
      throw new Error(`문단 페이지 ${String(page.id)}의 참조가 일치하지 않습니다.`);
    }
    add(tables, 'paragraph_pages', {
      id: page.id,
      book_id: page.novelId,
      chapter_id: page.chapterId,
      page_index: page.pageIndex,
      start_paragraph_index: page.startParagraphIndex,
      end_paragraph_index: page.endParagraphIndex,
      paragraphs: page.paragraphs,
      text_hash: page.textHash,
      created_at: page.createdAt ?? new Date().toISOString(),
    });
  }
  if ((stores.get('book_content_paragraphs') ?? []).length > 0) {
    throw new Error('별도 문단 저장소가 있는 로컬 백업은 아직 이전할 수 없습니다. 원본 ZIP은 보존됩니다.');
  }
  const heads = stores.get('book_content_domain_heads') ?? [];
  assertUniqueIds(heads, '내용 head');
  const paragraphRows = pageRows.flatMap((page) => page.paragraphs as Row[]);
  assertUniqueIds(paragraphRows, '문단');
  for (const head of heads) {
    assertKnownFields(head, '내용 head', ['id', 'entityType', 'domainId', 'novelId', 'contentRevisionId']);
    const book = books.find((item) => item.id === head.novelId);
    if (!book || head.contentRevisionId !== book.activeContentRevisionId) {
      throw new Error('로컬 백업의 활성 내용 참조가 일치하지 않습니다.');
    }
    if (
      head.id !== JSON.stringify([head.entityType, head.domainId]) ||
      !(head.entityType === 'chapter' ? chapterRows : head.entityType === 'paragraph' ? paragraphRows : []).some(
        (row) => row.id === head.domainId && row.novelId === head.novelId,
      )
    ) {
      throw new Error('로컬 백업의 내용 head 참조가 누락되었습니다.');
    }
  }
  for (const book of books) {
    const chapters = chapterRows.filter(
      (row) => row.novelId === book.id && row.contentRevisionId === book.activeContentRevisionId,
    );
    const pages = pageRows.filter(
      (row) => row.novelId === book.id && row.contentRevisionId === book.activeContentRevisionId,
    );
    const paragraphs = pages.reduce(
      (count, page) => count + (Array.isArray(page.paragraphs) ? page.paragraphs.length : 0),
      0,
    );
    const novel = bookRows.find((row) => row.id === book.id)!;
    const revision = revisionRows.find((row) => row.id === book.activeContentRevisionId)!;
    const actual = record(revision.actual, `${book.id} revision 수량`);
    const expected = record(revision.expected, `${book.id} 예상 수량`);
    if (
      chapters.length !== novel.totalChapters ||
      paragraphs !== novel.totalParagraphs ||
      chapters.some(
        (chapter) =>
          pages
            .filter((page) => page.chapterId === chapter.id)
            .reduce((count, page) => count + (page.paragraphs as Row[]).length, 0) !== chapter.paragraphCount,
      ) ||
      actual.chapterCount !== chapters.length ||
      actual.pageCount !== pages.length ||
      actual.paragraphCount !== paragraphs ||
      actual.paragraphRefCount !== paragraphs ||
      actual.searchRowCount !== paragraphs ||
      expected.chapterCount !== chapters.length ||
      expected.paragraphCount !== paragraphs ||
      (expected.pageCount !== undefined && expected.pageCount !== pages.length) ||
      chapterRows.some((row) => row.novelId === book.id && row.contentRevisionId !== book.activeContentRevisionId) ||
      pageRows.some((row) => row.novelId === book.id && row.contentRevisionId !== book.activeContentRevisionId)
    ) {
      throw new Error(`${book.id} 회차·문단 수 또는 revision 참조가 일치하지 않습니다.`);
    }
  }
  const settings = stores.get('settings') ?? [];
  if (settings.some((row) => row.id !== 'reader-settings') || settings.length > 1) {
    throw new Error('지원하지 않는 로컬 설정 항목이 있습니다. 원본 ZIP은 보존됩니다.');
  }
  if (settings[0]) {
    tables.set('reader_settings', [
      {
        user_id: userId,
        settings: Object.fromEntries(Object.entries(settings[0]).filter(([key]) => key !== 'id')),
        updated_at: new Date().toISOString(),
      },
    ]);
  }
  mapPersonalRows(stores, tables, userId);
  const manifest: HostedBackupManifestV1 = {
    format: HOSTED_BACKUP_FORMAT,
    version: HOSTED_BACKUP_VERSION,
    backend: 'hosted',
    exportedAt: localManifest.exportedAt,
    appVersion: localManifest.appVersion,
    books,
    entries: [],
    assetBlobs: hostedAssets,
  };
  return { manifest, tables, objects, assetBlobs, archiveHash, totalUncompressedBytes };
}

function hashFromStorageKey(value: unknown): string {
  const key = requiredString(value, '자산 저장 키');
  if (!key.startsWith('asset_blob_')) throw new Error('지원하지 않는 로컬 자산 저장 키입니다.');
  return key.slice('asset_blob_'.length);
}

function mapPersonalRows(stores: Map<string, Row[]>, tables: Map<HostedBackupTableName, Row[]>, userId: string) {
  const books = new Map((tables.get('library_books') ?? []).map((row) => [row.id, row]));
  const chapters = new Map((tables.get('chapters') ?? []).map((row) => [row.id, row]));
  const paragraphs = new Map(
    (tables.get('paragraph_pages') ?? []).flatMap((page) =>
      (page.paragraphs as Row[]).map((paragraph) => [paragraph.id, paragraph] as const),
    ),
  );
  const assets = tables.get('book_assets') ?? [];
  const objects = new Map((tables.get('book_content_revisions') ?? []).map((row) => [row.book_id, row]));
  const personal = [
    ['reading_positions', POSITION_FIELDS],
    ['bookmarks', BOOKMARK_FIELDS],
    ['highlights', HIGHLIGHT_FIELDS],
    ['notes', NOTE_FIELDS],
    ['listening_positions', LISTENING_FIELDS],
    ['document_annotations', DOCUMENT_ANNOTATION_FIELDS],
  ] as const;
  for (const [name, fields] of personal) {
    const items = stores.get(name) ?? [];
    assertUniqueIds(items, name);
    for (const row of items) assertKnownFields(row, name, fields);
  }
  const assertRef = (bookId: unknown, chapterId?: unknown, paragraphId?: unknown) => {
    const book = books.get(bookId);
    if (!book) throw new Error(`독서 자료의 작품 참조가 누락되었습니다: ${String(bookId)}`);
    if (chapterId) {
      const chapter = chapters.get(chapterId);
      if (!chapter || chapter.book_id !== bookId) throw new Error('독서 자료의 회차 참조가 일치하지 않습니다.');
    }
    if (paragraphId) {
      const paragraph = paragraphs.get(paragraphId);
      if (!paragraph || paragraph.novelId !== bookId || paragraph.chapterId !== chapterId) {
        throw new Error('독서 자료의 문단 참조가 일치하지 않습니다.');
      }
    }
    return book;
  };
  for (const row of stores.get('reading_positions') ?? []) {
    assertRef(row.novelId, row.chapterId, row.paragraphId);
    if (row.id !== `reading_position_${String(row.novelId)}`) {
      throw new Error('독서 위치 ID가 작품과 일치하지 않습니다.');
    }
    if (row.anchor)
      throw new Error('Reader anchor가 있는 독서 위치는 아직 무손실 이전할 수 없습니다. 원본 ZIP은 보존됩니다.');
    add(tables, 'reading_positions', {
      book_id: row.novelId,
      user_id: userId,
      chapter_id: row.chapterId,
      paragraph_id: row.paragraphId ?? null,
      paragraph_index: row.paragraphIndex ?? 0,
      offset_in_paragraph: row.offsetInParagraph ?? 0,
      chapter_progress: row.chapterProgress ?? 0,
      scroll_top: row.scrollTop ?? 0,
      device_id: row.deviceId ?? null,
      updated_at: row.updatedAt,
    });
  }
  for (const row of stores.get('bookmarks') ?? []) {
    assertRef(row.novelId, row.chapterId, row.paragraphId);
    add(tables, 'bookmarks', {
      id: row.id,
      book_id: row.novelId,
      user_id: userId,
      chapter_id: row.chapterId,
      paragraph_id: row.paragraphId ?? null,
      label: row.label,
      progress: row.progress ?? 0,
      scroll_top: row.scrollTop ?? 0,
      created_at: row.createdAt,
      updated_at: row.updatedAt ?? row.createdAt,
      deleted_at: row.deletedAt ?? null,
    });
  }
  for (const row of stores.get('highlights') ?? []) {
    assertRef(row.novelId, row.chapterId, row.paragraphId);
    add(tables, 'highlights', {
      id: row.id,
      book_id: row.novelId,
      user_id: userId,
      chapter_id: row.chapterId,
      paragraph_id: row.paragraphId,
      quote: row.quote,
      color: row.color,
      progress: row.progress ?? 0,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      deleted_at: row.deletedAt ?? null,
    });
  }
  for (const row of stores.get('notes') ?? []) {
    assertRef(row.novelId, row.chapterId, row.paragraphId);
    add(tables, 'notes', {
      id: row.id,
      book_id: row.novelId,
      user_id: userId,
      chapter_id: row.chapterId,
      paragraph_id: row.paragraphId ?? null,
      quote: row.quote ?? null,
      body: row.body,
      progress: row.progress ?? 0,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      deleted_at: row.deletedAt ?? null,
    });
  }
  for (const row of stores.get('listening_positions') ?? []) {
    const book = assertRef(row.bookId, row.chapterId);
    const anchor = record(row.anchor, '듣기 anchor');
    const anchorBookId =
      anchor.kind === 'reflowable_text' ? record(anchor.reader, '듣기 reader anchor').bookId : anchor.bookId;
    if (row.contentRevisionId !== book.active_content_revision_id || anchorBookId !== row.bookId) {
      throw new Error('듣기 위치의 내용 revision 또는 anchor가 일치하지 않습니다.');
    }
    add(tables, 'listening_positions', {
      book_id: row.bookId,
      user_id: userId,
      chapter_id: row.chapterId,
      anchor: row.anchor,
      queue_item_fingerprint: row.queueItemFingerprint,
      content_revision_id: row.contentRevisionId,
      settings_fingerprint: row.settingsFingerprint,
      device_id: row.deviceId ?? null,
      updated_at: row.updatedAt,
    });
  }
  for (const row of stores.get('document_annotations') ?? []) {
    const book = assertRef(row.bookId);
    const pageIndex = nonNegativeInteger(row.pageIndex, '문서 주석 페이지');
    if (pageIndex >= Number(book.total_chapters) || row.textAnchorRemap) {
      throw new Error('문서 주석 페이지 또는 텍스트 재연결 정보는 이전할 수 없습니다.');
    }
    const anchor = record(row.anchor, '문서 주석 anchor');
    const revision = objects.get(row.bookId);
    const pageAsset = assets.find(
      (asset) => asset.book_id === row.bookId && asset.kind === 'document_page' && asset.page_index === pageIndex,
    );
    const pageHash =
      book.format === 'pdf' && revision?.source_raw_text_hash
        ? `${revision.source_raw_text_hash}:pdf-page:${pageIndex}`
        : book.format === 'image_archive' && pageAsset
          ? persistentId128('archive_thumbnail_asset_v2', [String(pageAsset.id), String(pageIndex)])
          : undefined;
    if (
      !pageHash ||
      (anchor.kind !== 'fixed_page' && anchor.kind !== 'fixed_region') ||
      anchor.bookId !== row.bookId ||
      anchor.pageIndex !== pageIndex ||
      anchor.pageHash !== pageHash
    ) {
      throw new Error('문서 주석의 원본 페이지 참조가 일치하지 않습니다. 원본 ZIP은 보존됩니다.');
    }
    add(tables, 'document_annotations', {
      id: row.id,
      book_id: row.bookId,
      user_id: userId,
      page_index: row.pageIndex,
      annotation_type: row.type,
      anchor: row.anchor,
      quote: row.quote ?? null,
      body: row.body ?? null,
      color: row.color ?? null,
      text_anchor_remap: row.textAnchorRemap ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      deleted_at: row.deletedAt ?? null,
    });
  }
}
