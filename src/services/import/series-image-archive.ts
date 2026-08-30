import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js';

const MANIFEST_NAME = 'moya-series.json';
const MAX_PAGE_COUNT = 5_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

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
  readonly file: Blob;
  /** Request-scoped only and never written to the manifest. */
  readonly archivePassword?: string;
}

export interface SeriesImageArchiveInput {
  readonly collection: SeriesImageCollection;
  readonly chapters: readonly SeriesImageChapterInput[];
  readonly existingArchive?: Blob;
  readonly existingLegacyChapter?: Omit<SeriesImageChapterInput, 'file'>;
  readonly signal: AbortSignal;
}

export interface SeriesImageManifestChapter {
  readonly remoteId: string;
  readonly title: string;
  readonly chapterNumber?: number;
  readonly sourceOrder?: number;
  readonly remoteRevision?: string;
  readonly sourceContentHash: string;
  readonly pageCount: number;
  readonly entryNames: readonly string[];
}

export interface SeriesImageArchiveManifest {
  readonly schemaVersion: 1;
  readonly collection: SeriesImageCollection;
  readonly chapters: readonly SeriesImageManifestChapter[];
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

async function readPages(file: Blob, signal: AbortSignal, password?: string): Promise<PreparedPage[]> {
  const { openImageArchiveStream } = await import('@noveldesk/fixed-document-core');
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
    Array.isArray(candidate.chapters) &&
    candidate.chapters.every(
      (chapter) =>
        Boolean(chapter?.remoteId && chapter.title && chapter.sourceContentHash) &&
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
    const entry = (await reader.getEntries()).find(
      (candidate): candidate is FileEntry =>
        !candidate.directory &&
        Boolean((candidate as FileEntry).getData) &&
        candidate.filename.toLocaleLowerCase() === MANIFEST_NAME,
    );
    if (!entry) return undefined;
    const parsed = JSON.parse(await entry.getData!(new TextWriter())) as unknown;
    if (!isSeriesImageArchiveManifest(parsed)) throw new Error('기존 연재 작품 manifest가 올바르지 않습니다.');
    return parsed;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function readExistingSeries(file: Blob, signal: AbortSignal): Promise<PreparedChapter[] | undefined> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const manifestEntry = entries.find(
      (entry): entry is FileEntry =>
        !entry.directory && Boolean(entry.getData) && entry.filename.toLocaleLowerCase() === MANIFEST_NAME,
    );
    if (!manifestEntry) return undefined;
    const parsed = JSON.parse(await manifestEntry.getData!(new TextWriter())) as unknown;
    if (!isSeriesImageArchiveManifest(parsed)) throw new Error('기존 연재 작품 manifest가 올바르지 않습니다.');
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
        pages,
      });
    }
    return chapters;
  } finally {
    await reader.close().catch(() => undefined);
  }
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
        pages: await readPages(input.existingArchive, input.signal, input.existingLegacyChapter.archivePassword),
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
      pages: await readPages(chapter.file, input.signal, chapter.archivePassword),
    });
  }

  const chapters = [...chaptersById.values()].sort(chapterOrder);
  const pageCount = chapters.reduce((sum, chapter) => sum + chapter.pages.length, 0);
  const totalBytes = chapters.reduce(
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
    for (const [chapterIndex, chapter] of chapters.entries()) {
      input.signal.throwIfAborted();
      const folder = `chapters/${String(chapterIndex + 1).padStart(6, '0')}`;
      const entryNames: string[] = [];
      for (const [pageIndex, page] of chapter.pages.entries()) {
        input.signal.throwIfAborted();
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
        pageCount: chapter.pages.length,
        entryNames,
      });
    }
    const manifest: SeriesImageArchiveManifest = {
      schemaVersion: 1,
      collection: input.collection,
      chapters: manifestChapters,
    };
    await writer.add(MANIFEST_NAME, new TextReader(JSON.stringify(manifest)));
    await writer.add('ComicInfo.xml', new TextReader(comicInfo(input.collection, pageCount)));
    const blob = await writer.close();
    return new File([blob], `${safeFileName(input.collection.title)}.cbz`, {
      type: 'application/vnd.comicbook+zip',
    });
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}
