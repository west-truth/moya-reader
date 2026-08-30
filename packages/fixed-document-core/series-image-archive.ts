import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js';

const MANIFEST_NAME = 'moya-series.json';
const MAX_PAGE_COUNT = 5_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_COMPRESSION_RATIO = 250;
const MAX_ARCHIVE_ENTRIES = 6_000;

export interface SeriesImageCollection {
  readonly remoteId: string;
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export interface SeriesImageRelease {
  readonly title: string;
  readonly chapterNumber?: number;
  readonly sourceOrder?: number;
}

export interface SeriesImageChapterInput {
  readonly remoteId: string;
  readonly release: SeriesImageRelease;
  readonly remoteRevision?: string;
  readonly sourceContentHash: string;
  /** Present on a delta that intentionally replaces this exact prior release body. */
  readonly expectedPreviousSourceContentHash?: string;
  readonly file: Blob;
  /** Request-scoped only and never written to the manifest. */
  readonly archivePassword?: string;
}

export interface SeriesImageArchiveInput {
  readonly collection: SeriesImageCollection;
  /** Present only on a delta intended for an already-known local Library book. */
  readonly targetBookId?: string;
  readonly chapters: readonly SeriesImageChapterInput[];
  readonly existingArchive?: Blob;
  readonly existingLegacyChapter?: Omit<SeriesImageChapterInput, 'file'>;
  readonly signal: AbortSignal;
  /** Platform adapter used only while decoding newly supplied release archives. */
  readonly openImageArchiveStream?: SeriesImageArchiveStreamOpener;
}

export type SeriesImageArchiveStreamOpener = (
  file: Blob,
  options: { readonly signal: AbortSignal; readonly password?: string },
) => Promise<{
  consumePages(): AsyncIterable<{ readonly fileName: string; readonly bytes: Uint8Array }>;
}>;

export interface SeriesImageManifestChapter {
  readonly remoteId: string;
  readonly title: string;
  readonly chapterNumber?: number;
  readonly sourceOrder?: number;
  readonly remoteRevision?: string;
  readonly sourceContentHash: string;
  readonly expectedPreviousSourceContentHash?: string;
  readonly pageCount: number;
  readonly entryNames: readonly string[];
}

export interface SeriesImageArchiveManifest {
  readonly schemaVersion: 1;
  readonly collection: SeriesImageCollection;
  readonly targetBookId?: string;
  readonly chapters: readonly SeriesImageManifestChapter[];
}

export interface MergeSeriesImageArchiveDeltaInput {
  readonly existingArchive: Blob;
  readonly deltaArchive: Blob;
  readonly targetBookId?: string;
  readonly signal: AbortSignal;
}

export interface MergeSeriesImageArchiveDeltaResult {
  readonly file: File;
  readonly changedSectionIds: readonly string[];
  readonly addedSectionIds: readonly string[];
  readonly replacedSectionIds: readonly string[];
  readonly unchangedSectionIds: readonly string[];
}

interface PreparedPage {
  readonly blob: Blob;
  readonly extension: string;
}

interface PreparedChapter {
  readonly remoteId: string;
  readonly title: string;
  readonly chapterNumber?: number;
  readonly sourceOrder?: number;
  readonly remoteRevision?: string;
  readonly sourceContentHash: string;
  readonly expectedPreviousSourceContentHash?: string;
  readonly pages: readonly PreparedPage[];
}

function isImageEntry(name: string): boolean {
  return /\.(?:jpe?g|png|webp|gif)$/iu.test(name);
}

function imageExtension(name: string): string {
  const match = /\.([^.]+)$/u.exec(name);
  return match?.[1]?.toLocaleLowerCase().replace('jpeg', 'jpg') ?? 'jpg';
}

function contentType(extension: string): string {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return 'image/jpeg';
}

function assertSafeManifestEntry(entry: FileEntry, label: string): void {
  const size = Number(entry.uncompressedSize ?? 0);
  const compressedSize = Number(entry.compressedSize ?? 0);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} manifest 크기가 안전 한도를 벗어났습니다.`);
  }
  if (!Number.isSafeInteger(compressedSize) || compressedSize <= 0) {
    throw new Error(`${label} manifest 압축 크기가 올바르지 않습니다.`);
  }
  if (size > compressedSize * MAX_MANIFEST_COMPRESSION_RATIO) {
    throw new Error(`${label} manifest 압축률이 안전 한도를 초과했습니다.`);
  }
}

function safeFileName(value: string): string {
  return (
    [...value]
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[<>:"/\\|?*]/gu, '_')
      .replace(/\s+/gu, ' ')
      .trim() || '연재 작품'
  );
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function comicInfo(collection: SeriesImageCollection, pageCount: number): string {
  const tags = collection.tags?.filter(Boolean).join(', ');
  return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>${xml(collection.title)}</Title>
  ${collection.author ? `<Writer>${xml(collection.author)}</Writer>` : ''}
  ${collection.description ? `<Summary>${xml(collection.description)}</Summary>` : ''}
  ${tags ? `<Tags>${xml(tags)}</Tags>` : ''}
  <PageCount>${pageCount}</PageCount>
</ComicInfo>`;
}

function chapterOrder(left: PreparedChapter, right: PreparedChapter): number {
  if (left.sourceOrder !== undefined && right.sourceOrder !== undefined && left.sourceOrder !== right.sourceOrder) {
    return left.sourceOrder - right.sourceOrder;
  }
  const leftNumber = left.chapterNumber;
  const rightNumber = right.chapterNumber;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber! - rightNumber!;
  }
  return left.title.localeCompare(right.title, 'ko', { numeric: true });
}

async function readPages(
  file: Blob,
  signal: AbortSignal,
  openImageArchiveStream: SeriesImageArchiveStreamOpener | undefined,
  password?: string,
): Promise<PreparedPage[]> {
  if (!openImageArchiveStream) throw new Error('이미지 회차 압축 해제기를 사용할 수 없습니다.');
  const document = await openImageArchiveStream(file, { signal, password });
  const pages: PreparedPage[] = [];
  for await (const page of document.consumePages()) {
    signal.throwIfAborted();
    const extension = imageExtension(page.fileName);
    pages.push({ blob: new Blob([Uint8Array.from(page.bytes)], { type: contentType(extension) }), extension });
  }
  if (!pages.length) throw new Error('회차 압축 파일에 이미지가 없습니다.');
  return pages;
}

export function isSeriesImageArchiveManifest(value: unknown): value is SeriesImageArchiveManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SeriesImageArchiveManifest>;
  return (
    candidate.schemaVersion === 1 &&
    Boolean(candidate.collection?.remoteId && candidate.collection.title) &&
    (candidate.targetBookId === undefined ||
      (typeof candidate.targetBookId === 'string' && Boolean(candidate.targetBookId.trim()))) &&
    Array.isArray(candidate.chapters) &&
    candidate.chapters.every(
      (chapter) =>
        typeof chapter?.remoteId === 'string' &&
        Boolean(chapter.remoteId) &&
        typeof chapter.title === 'string' &&
        Boolean(chapter.title) &&
        typeof chapter.sourceContentHash === 'string' &&
        Boolean(chapter.sourceContentHash) &&
        (chapter.expectedPreviousSourceContentHash === undefined ||
          (typeof chapter.expectedPreviousSourceContentHash === 'string' &&
            Boolean(chapter.expectedPreviousSourceContentHash.trim()))) &&
        (chapter.remoteRevision === undefined || typeof chapter.remoteRevision === 'string') &&
        Number.isInteger(chapter.pageCount) &&
        chapter.pageCount > 0 &&
        Array.isArray(chapter.entryNames) &&
        chapter.entryNames.length === chapter.pageCount,
    )
  );
}

export async function readSeriesImageArchiveManifest(blob: Blob): Promise<SeriesImageArchiveManifest | undefined> {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('연재 작품 압축 항목 수가 안전 한도를 초과했습니다.');
    const entry = entries.find(
      (candidate): candidate is FileEntry =>
        !candidate.directory &&
        Boolean((candidate as FileEntry).getData) &&
        candidate.filename.toLocaleLowerCase() === MANIFEST_NAME,
    );
    if (!entry) return undefined;
    assertSafeManifestEntry(entry, '기존 연재 작품');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await entry.getData!(new TextWriter())) as unknown;
    } catch {
      throw new Error('기존 연재 작품 manifest가 올바르지 않습니다.');
    }
    if (!isSeriesImageArchiveManifest(parsed)) throw new Error('기존 연재 작품 manifest가 올바르지 않습니다.');
    return parsed;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function inspectSeriesArchiveManifest(
  blob: Blob,
  signal: AbortSignal,
  label: '기존 aggregate' | 'delta archive',
): Promise<SeriesImageArchiveManifest> {
  signal.throwIfAborted();
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`${label}의 압축 항목 수가 안전 한도를 초과했습니다.`);
    signal.throwIfAborted();
    const manifestEntry = entries.find(
      (entry): entry is FileEntry =>
        !entry.directory && Boolean(entry.getData) && entry.filename.toLocaleLowerCase() === MANIFEST_NAME,
    );
    if (!manifestEntry) throw new Error(`${label}에 Moya 연재 작품 manifest가 없습니다.`);
    assertSafeManifestEntry(manifestEntry, label);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await manifestEntry.getData!(new TextWriter())) as unknown;
    } catch {
      throw new Error(`${label}의 Moya 연재 작품 manifest가 올바르지 않습니다.`);
    }
    if (!isSeriesImageArchiveManifest(parsed)) {
      throw new Error(`${label}의 Moya 연재 작품 manifest가 올바르지 않습니다.`);
    }

    const sectionIds = new Set<string>();
    const referencedEntries = new Set<string>();
    const availableEntries = new Map(
      entries
        .filter((entry): entry is FileEntry => !entry.directory && Boolean(entry.getData))
        .map((entry) => [entry.filename, entry]),
    );
    let pageCount = 0;
    let totalBytes = 0;
    for (const chapter of parsed.chapters) {
      if (sectionIds.has(chapter.remoteId)) {
        throw new Error(`${label}의 Moya 연재 작품 manifest에 중복 회차가 있습니다.`);
      }
      sectionIds.add(chapter.remoteId);
      pageCount += chapter.pageCount;
      if (pageCount > MAX_PAGE_COUNT) throw new Error(`${label}의 전체 페이지 수가 안전 한도를 초과했습니다.`);
      for (const entryName of chapter.entryNames) {
        const entry = availableEntries.get(entryName);
        if (!isImageEntry(entryName) || !entry || referencedEntries.has(entryName)) {
          throw new Error(`${label}의 Moya 연재 작품 manifest와 페이지 목록이 일치하지 않습니다.`);
        }
        const size = Number(entry.uncompressedSize ?? 0);
        const compressedSize = Math.max(1, Number(entry.compressedSize ?? size));
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PAGE_BYTES) {
          throw new Error(`${label}의 페이지 크기가 안전 한도를 벗어났습니다.`);
        }
        if (size > compressedSize * MAX_COMPRESSION_RATIO) {
          throw new Error(`${label}의 페이지 압축률이 안전 한도를 초과했습니다.`);
        }
        totalBytes += size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`${label}의 전체 이미지 크기가 안전 한도를 초과했습니다.`);
        referencedEntries.add(entryName);
      }
    }
    const archiveImageEntries = entries.filter((entry) => !entry.directory && isImageEntry(entry.filename));
    if (
      archiveImageEntries.length !== referencedEntries.size ||
      archiveImageEntries.some((entry) => !referencedEntries.has(entry.filename))
    ) {
      throw new Error(`${label}의 Moya 연재 작품 manifest와 페이지 목록이 일치하지 않습니다.`);
    }
    return parsed;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function readExistingSeries(file: Blob, signal: AbortSignal): Promise<PreparedChapter[] | undefined> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error('기존 연재 작품 압축 항목 수가 안전 한도를 초과했습니다.');
    }
    const manifestEntry = entries.find(
      (entry): entry is FileEntry =>
        !entry.directory && Boolean(entry.getData) && entry.filename.toLocaleLowerCase() === MANIFEST_NAME,
    );
    if (!manifestEntry) return undefined;
    const parsed = await inspectSeriesArchiveManifest(file, signal, '기존 aggregate');
    const entriesByName = new Map(
      entries
        .filter((entry): entry is FileEntry => !entry.directory && Boolean(entry.getData))
        .map((entry) => [entry.filename, entry]),
    );
    const chapters: PreparedChapter[] = [];
    for (const chapter of parsed.chapters) {
      const pages: PreparedPage[] = [];
      for (const name of chapter.entryNames) {
        signal.throwIfAborted();
        const entry = entriesByName.get(name);
        if (!entry || !isImageEntry(name)) throw new Error('기존 연재 작품 페이지가 누락되었습니다.');
        const extension = imageExtension(name);
        pages.push({ blob: await entry.getData!(new BlobWriter(contentType(extension))), extension });
      }
      chapters.push({
        remoteId: chapter.remoteId,
        title: chapter.title,
        chapterNumber: chapter.chapterNumber,
        sourceOrder: chapter.sourceOrder,
        remoteRevision: chapter.remoteRevision,
        sourceContentHash: chapter.sourceContentHash,
        expectedPreviousSourceContentHash: chapter.expectedPreviousSourceContentHash,
        pages,
      });
    }
    return chapters;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function normalizedSourceContentHash(value: string): string {
  return value
    .replace(/^sha256:/iu, '')
    .trim()
    .toLocaleLowerCase();
}

function archiveFile(blob: Blob, collection: SeriesImageCollection): File {
  if (blob instanceof File) return blob;
  return new File([blob], `${safeFileName(collection.title)}.cbz`, {
    type: 'application/vnd.comicbook+zip',
  });
}

async function writePreparedSeriesArchive(
  collection: SeriesImageCollection,
  chapters: readonly PreparedChapter[],
  signal: AbortSignal,
  targetBookId?: string,
): Promise<File> {
  const orderedChapters = [...chapters].sort(chapterOrder);
  const pageCount = orderedChapters.reduce((sum, chapter) => sum + chapter.pages.length, 0);
  const totalBytes = orderedChapters.reduce(
    (sum, chapter) => sum + chapter.pages.reduce((pageSum, page) => pageSum + page.blob.size, 0),
    0,
  );
  if (!pageCount || pageCount > MAX_PAGE_COUNT)
    throw new Error('연재 작품의 전체 페이지 수가 안전 한도를 벗어났습니다.');
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('연재 작품의 전체 이미지 크기가 안전 한도를 초과했습니다.');

  const output = new BlobWriter('application/vnd.comicbook+zip');
  const writer = new ZipWriter(output, { bufferedWrite: true });
  const manifestChapters: SeriesImageManifestChapter[] = [];
  try {
    for (const [chapterIndex, chapter] of orderedChapters.entries()) {
      signal.throwIfAborted();
      const folder = `chapters/${String(chapterIndex + 1).padStart(6, '0')}`;
      const entryNames: string[] = [];
      for (const [pageIndex, page] of chapter.pages.entries()) {
        signal.throwIfAborted();
        const entryName = `${folder}/${String(pageIndex + 1).padStart(5, '0')}.${page.extension}`;
        await writer.add(entryName, new BlobReader(page.blob), { level: 0 });
        entryNames.push(entryName);
      }
      manifestChapters.push({
        remoteId: chapter.remoteId,
        title: chapter.title,
        chapterNumber: chapter.chapterNumber,
        sourceOrder: chapter.sourceOrder,
        remoteRevision: chapter.remoteRevision,
        sourceContentHash: chapter.sourceContentHash,
        ...(targetBookId && chapter.expectedPreviousSourceContentHash
          ? { expectedPreviousSourceContentHash: chapter.expectedPreviousSourceContentHash }
          : {}),
        pageCount: chapter.pages.length,
        entryNames,
      });
    }
    const manifest: SeriesImageArchiveManifest = {
      schemaVersion: 1,
      collection,
      ...(targetBookId ? { targetBookId } : {}),
      chapters: manifestChapters,
    };
    await writer.add(MANIFEST_NAME, new TextReader(JSON.stringify(manifest)));
    await writer.add('ComicInfo.xml', new TextReader(comicInfo(collection, pageCount)));
    const blob = await writer.close();
    return new File([blob], `${safeFileName(collection.title)}.cbz`, {
      type: 'application/vnd.comicbook+zip',
    });
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Applies a manifest-bearing delta archive to an existing aggregate. A section
 * whose exact source hash is already present is a true no-op: its existing
 * metadata and bytes stay untouched and the aggregate is not rewritten when
 * every delta section is unchanged.
 */
export async function mergeSeriesImageArchiveDelta(
  input: MergeSeriesImageArchiveDeltaInput,
): Promise<MergeSeriesImageArchiveDeltaResult> {
  input.signal.throwIfAborted();
  const [existingManifest, deltaManifest] = await Promise.all([
    inspectSeriesArchiveManifest(input.existingArchive, input.signal, '기존 aggregate'),
    inspectSeriesArchiveManifest(input.deltaArchive, input.signal, 'delta archive'),
  ]);
  const targetsRequestedBook = Boolean(input.targetBookId && deltaManifest.targetBookId === input.targetBookId);
  if (deltaManifest.targetBookId && !targetsRequestedBook) {
    throw new Error('delta archive의 대상 작품 identity가 일치하지 않습니다.');
  }
  if (existingManifest.collection.remoteId !== deltaManifest.collection.remoteId && !targetsRequestedBook) {
    throw new Error('기존 aggregate와 delta archive의 collection identity가 일치하지 않습니다.');
  }

  const existingById = new Map(existingManifest.chapters.map((chapter) => [chapter.remoteId, chapter]));
  const changedSectionIds: string[] = [];
  const addedSectionIds: string[] = [];
  const replacedSectionIds: string[] = [];
  const unchangedSectionIds: string[] = [];
  for (const chapter of deltaManifest.chapters) {
    const existing = existingById.get(chapter.remoteId);
    if (
      existing &&
      normalizedSourceContentHash(existing.sourceContentHash) === normalizedSourceContentHash(chapter.sourceContentHash)
    ) {
      unchangedSectionIds.push(chapter.remoteId);
    } else {
      if (
        existing &&
        chapter.expectedPreviousSourceContentHash &&
        normalizedSourceContentHash(existing.sourceContentHash) !==
          normalizedSourceContentHash(chapter.expectedPreviousSourceContentHash)
      ) {
        throw new Error('delta archive가 예상한 기존 회차 본문과 현재 aggregate가 일치하지 않습니다.');
      }
      changedSectionIds.push(chapter.remoteId);
      (existing || chapter.expectedPreviousSourceContentHash ? replacedSectionIds : addedSectionIds).push(
        chapter.remoteId,
      );
    }
  }
  if (changedSectionIds.length === 0) {
    return {
      file: archiveFile(input.existingArchive, existingManifest.collection),
      changedSectionIds,
      addedSectionIds,
      replacedSectionIds,
      unchangedSectionIds,
    };
  }

  const [existingChapters, deltaChapters] = await Promise.all([
    readExistingSeries(input.existingArchive, input.signal),
    readExistingSeries(input.deltaArchive, input.signal),
  ]);
  if (!existingChapters || !deltaChapters) throw new Error('연재 작품 aggregate를 병합하지 못했습니다.');
  const changed = new Set(changedSectionIds);
  const chaptersById = new Map(existingChapters.map((chapter) => [chapter.remoteId, chapter]));
  deltaChapters
    .filter((chapter) => changed.has(chapter.remoteId))
    .forEach((chapter) => chaptersById.set(chapter.remoteId, chapter));
  const collection =
    existingManifest.collection.remoteId === deltaManifest.collection.remoteId
      ? deltaManifest.collection
      : existingManifest.collection;
  return {
    file: await writePreparedSeriesArchive(collection, [...chaptersById.values()], input.signal),
    changedSectionIds,
    addedSectionIds,
    replacedSectionIds,
    unchangedSectionIds,
  };
}

export async function buildSeriesImageArchive(input: SeriesImageArchiveInput): Promise<File> {
  input.signal.throwIfAborted();
  const chaptersById = new Map<string, PreparedChapter>();
  if (input.existingArchive) {
    const existing = await readExistingSeries(input.existingArchive, input.signal);
    if (existing) {
      existing.forEach((chapter) => chaptersById.set(chapter.remoteId, chapter));
    } else if (input.existingLegacyChapter) {
      chaptersById.set(input.existingLegacyChapter.remoteId, {
        ...input.existingLegacyChapter,
        title: input.existingLegacyChapter.release.title,
        chapterNumber: input.existingLegacyChapter.release.chapterNumber,
        sourceOrder: input.existingLegacyChapter.release.sourceOrder,
        pages: await readPages(
          input.existingArchive,
          input.signal,
          input.openImageArchiveStream,
          input.existingLegacyChapter.archivePassword,
        ),
      });
    } else {
      throw new Error('기존 단일 회차의 연결 정보를 확인하지 못했습니다.');
    }
  }

  for (const chapter of input.chapters) {
    chaptersById.set(chapter.remoteId, {
      remoteId: chapter.remoteId,
      title: chapter.release.title,
      chapterNumber: chapter.release.chapterNumber,
      sourceOrder: chapter.release.sourceOrder,
      remoteRevision: chapter.remoteRevision,
      sourceContentHash: chapter.sourceContentHash,
      expectedPreviousSourceContentHash: chapter.expectedPreviousSourceContentHash,
      pages: await readPages(chapter.file, input.signal, input.openImageArchiveStream, chapter.archivePassword),
    });
  }

  return writePreparedSeriesArchive(input.collection, [...chaptersById.values()], input.signal, input.targetBookId);
}
