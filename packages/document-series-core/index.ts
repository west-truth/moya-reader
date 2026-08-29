import type {
  BookFormat,
  Chapter,
  ChapterSplitMode,
  EncodingMode,
  Paragraph,
  ParsedNovelImport,
  ParsedNovelImportAsset,
  ParsedNovelImportChapter,
} from '@noveldesk/contracts';
import { materializeEpubImport, parseEpub } from '@noveldesk/epub-core';
import { integrityHash, isIntegrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { parsedNovelId } from '@noveldesk/text-core/identity/parser';
import { parseNovelFileForImport } from '@noveldesk/text-core/parser';
import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js';

export const DOCUMENT_SERIES_MANIFEST_NAME = 'moya-document-series.json';
export const DOCUMENT_SERIES_CONTENT_TYPE = 'application/vnd.moya.document-series+zip';

const MAX_SOURCE_COUNT = 512;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 1024 * 1024 * 1024;

export type DocumentSeriesFormat = Extract<BookFormat, 'txt' | 'markdown' | 'epub'>;

export interface DocumentSeriesCollection {
  readonly id: string;
  readonly title: string;
  readonly format: DocumentSeriesFormat;
  readonly author?: string;
  readonly seriesTitle?: string;
  readonly seriesIndex?: number;
  readonly description?: string;
  readonly language?: string;
  readonly readingDirection?: 'ltr' | 'rtl';
  readonly tags?: readonly string[];
  readonly metadataRevision?: number;
}

export interface DocumentSeriesSource {
  readonly id: string;
  readonly title: string;
  readonly fileName: string;
  readonly entryName: string;
  readonly contentType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly sourceOrder: number;
  readonly format: DocumentSeriesFormat;
  readonly encoding?: EncodingMode;
  readonly chapterSplitMode?: ChapterSplitMode;
  readonly includedChapterIndices: readonly number[];
  readonly chapterTitles?: Readonly<Record<string, string>>;
}

export interface DocumentSeriesManifest {
  readonly schemaVersion: 1;
  readonly collection: DocumentSeriesCollection;
  readonly sources: readonly DocumentSeriesSource[];
}

export interface DocumentSeriesSourceInput extends Omit<DocumentSeriesSource, 'entryName' | 'byteLength'> {
  readonly blob: Blob;
}

export interface DocumentSeriesArchiveInput {
  readonly collection: DocumentSeriesCollection;
  readonly sources: readonly DocumentSeriesSourceInput[];
  readonly signal?: AbortSignal;
}

export interface DocumentSeriesArchiveContents {
  readonly manifest: DocumentSeriesManifest;
  readonly sources: ReadonlyMap<string, Blob>;
}

export interface DocumentSeriesSourcePreview {
  readonly format: DocumentSeriesFormat;
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly language?: string;
  readonly encoding?: EncodingMode;
  readonly chapters: readonly Pick<Chapter, 'index' | 'title' | 'textHash' | 'characterCount' | 'paragraphCount'>[];
}

export interface InspectDocumentSeriesSourceInput {
  readonly fileName: string;
  readonly blob: Blob;
  readonly format?: DocumentSeriesFormat;
  readonly encoding?: EncodingMode;
  readonly chapterSplitMode?: ChapterSplitMode;
}

export interface MaterializeDocumentSeriesOptions {
  readonly fileName: string;
  readonly clientBookId?: string;
  readonly sourceContentHash?: string;
}

function normalizedPath(value: string): string {
  const clean = value.replace(/\\/gu, '/').normalize('NFKC').trim();
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) {
    throw new Error('연재 문서 패키지에 허용되지 않는 절대 경로가 있습니다.');
  }
  const parts: string[] = [];
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('연재 문서 패키지 항목이 패키지 밖을 가리킵니다.');
    parts.push(part);
  }
  if (!parts.length) throw new Error('연재 문서 패키지에 빈 항목 경로가 있습니다.');
  return parts.join('/');
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

function sourceExtension(format: DocumentSeriesFormat): string {
  if (format === 'epub') return 'epub';
  if (format === 'markdown') return 'md';
  return 'txt';
}

function formatFromFileName(fileName: string): DocumentSeriesFormat | undefined {
  if (/\.epub$/iu.test(fileName)) return 'epub';
  if (/\.(?:md|markdown)$/iu.test(fileName)) return 'markdown';
  if (/\.txt$/iu.test(fileName)) return 'txt';
  return undefined;
}

function sameFormatFamily(collection: DocumentSeriesFormat, source: DocumentSeriesFormat): boolean {
  return collection === 'epub' ? source === 'epub' : source === 'txt' || source === 'markdown';
}

function validIncludedChapterIndices(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((index) => Number.isSafeInteger(index) && index > 0) &&
    new Set(value).size === value.length
  );
}

function validChapterTitles(value: unknown, included: readonly number[]): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > included.length) return false;
  const allowed = new Set(included.map(String));
  return entries.every(
    ([index, title]) =>
      allowed.has(index) && typeof title === 'string' && title.trim().length > 0 && title.length <= 500,
  );
}

export function isDocumentSeriesManifest(value: unknown): value is DocumentSeriesManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DocumentSeriesManifest>;
  const collection = candidate.collection;
  if (
    candidate.schemaVersion !== 1 ||
    !collection ||
    typeof collection.id !== 'string' ||
    !collection.id ||
    typeof collection.title !== 'string' ||
    !collection.title ||
    (collection.format !== 'txt' && collection.format !== 'markdown' && collection.format !== 'epub') ||
    !Array.isArray(candidate.sources) ||
    candidate.sources.length === 0 ||
    candidate.sources.length > MAX_SOURCE_COUNT
  ) {
    return false;
  }
  return candidate.sources.every(
    (source) =>
      source &&
      typeof source.id === 'string' &&
      Boolean(source.id) &&
      typeof source.title === 'string' &&
      Boolean(source.title) &&
      typeof source.fileName === 'string' &&
      Boolean(source.fileName) &&
      typeof source.entryName === 'string' &&
      Boolean(source.entryName) &&
      typeof source.contentType === 'string' &&
      isIntegrityHash(source.contentHash) &&
      Number.isSafeInteger(source.byteLength) &&
      source.byteLength > 0 &&
      source.byteLength <= MAX_SOURCE_BYTES &&
      Number.isFinite(source.sourceOrder) &&
      (source.format === 'txt' || source.format === 'markdown' || source.format === 'epub') &&
      sameFormatFamily(collection.format, source.format) &&
      validIncludedChapterIndices(source.includedChapterIndices) &&
      validChapterTitles(source.chapterTitles, source.includedChapterIndices),
  );
}

async function parsedSource(input: InspectDocumentSeriesSourceInput): Promise<ParsedNovelImport> {
  const format = input.format ?? formatFromFileName(input.fileName);
  if (!format) throw new Error('연재 작품에는 TXT, Markdown 또는 EPUB 파일만 추가할 수 있습니다.');
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  if (format === 'epub') {
    return materializeEpubImport(await parseEpub(new Blob([bytes], { type: 'application/epub+zip' })), {
      fileName: input.fileName,
      sourceBytes: bytes,
    });
  }
  return parseNovelFileForImport(input.fileName, bytes.buffer as ArrayBuffer, input.encoding ?? 'auto', {
    chapterSplitMode: input.chapterSplitMode ?? 'auto',
  });
}

export async function inspectDocumentSeriesSource(
  input: InspectDocumentSeriesSourceInput,
): Promise<DocumentSeriesSourcePreview> {
  const parsed = await parsedSource(input);
  const format = parsed.novel.format;
  if (format !== 'txt' && format !== 'markdown' && format !== 'epub') {
    throw new Error('연재 문서로 사용할 수 없는 형식입니다.');
  }
  return {
    format,
    title: parsed.novel.title,
    author: parsed.novel.author,
    description: parsed.novel.description,
    language: parsed.novel.language,
    encoding: parsed.novel.sourceEncoding,
    chapters: parsed.chapters.map(({ index, title, textHash, characterCount, paragraphCount }) => ({
      index,
      title,
      textHash,
      characterCount,
      paragraphCount,
    })),
  };
}

export async function buildDocumentSeriesArchive(input: DocumentSeriesArchiveInput): Promise<File> {
  if (!input.sources.length || input.sources.length > MAX_SOURCE_COUNT) {
    throw new Error('연재 문서 원본 수가 안전 한도를 벗어났습니다.');
  }
  const seenIds = new Set<string>();
  const seenEntries = new Set<string>();
  let totalBytes = 0;
  const manifestSources: DocumentSeriesSource[] = [];
  for (const [index, source] of input.sources.entries()) {
    input.signal?.throwIfAborted();
    if (seenIds.has(source.id)) throw new Error('연재 문서 패키지에 중복된 원본 ID가 있습니다.');
    if (!sameFormatFamily(input.collection.format, source.format)) {
      throw new Error('서로 다른 문서 형식은 한 작품으로 병합할 수 없습니다.');
    }
    if (!validIncludedChapterIndices(source.includedChapterIndices)) {
      throw new Error(`${source.fileName}에서 추가할 회차를 찾지 못했습니다.`);
    }
    if (source.blob.size <= 0 || source.blob.size > MAX_SOURCE_BYTES) {
      throw new Error(`${source.fileName} 원본 크기가 안전 한도를 벗어났습니다.`);
    }
    totalBytes += source.blob.size;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) throw new Error('연재 문서 원본의 전체 크기가 안전 한도를 초과했습니다.');
    const actualHash = integrityHash(new Uint8Array(await source.blob.arrayBuffer()));
    if (actualHash !== source.contentHash) throw new Error(`${source.fileName} 원본 해시가 가져오기 계획과 다릅니다.`);
    const entryName = `sources/${String(index + 1).padStart(6, '0')}-${source.id}.${sourceExtension(source.format)}`;
    if (seenEntries.has(entryName)) throw new Error('연재 문서 패키지에 중복된 원본 경로가 있습니다.');
    seenIds.add(source.id);
    seenEntries.add(entryName);
    const { blob: _blob, ...descriptor } = source;
    manifestSources.push({ ...descriptor, entryName, byteLength: source.blob.size });
  }

  const manifest: DocumentSeriesManifest = {
    schemaVersion: 1,
    collection: input.collection,
    sources: manifestSources,
  };
  const output = new BlobWriter(DOCUMENT_SERIES_CONTENT_TYPE);
  const writer = new ZipWriter(output, { bufferedWrite: true });
  try {
    for (const [index, source] of input.sources.entries()) {
      input.signal?.throwIfAborted();
      await writer.add(manifestSources[index]!.entryName, new BlobReader(source.blob), { level: 0 });
    }
    await writer.add(DOCUMENT_SERIES_MANIFEST_NAME, new TextReader(JSON.stringify(manifest)));
    const blob = await writer.close();
    return new File([blob], `${safeFileName(input.collection.title)}.moya.zip`, {
      type: DOCUMENT_SERIES_CONTENT_TYPE,
    });
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}

export async function readDocumentSeriesArchive(blob: Blob): Promise<DocumentSeriesArchiveContents | undefined> {
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) return undefined;
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    const manifestEntry = entries.find(
      (entry): entry is FileEntry =>
        !entry.directory &&
        Boolean((entry as FileEntry).getData) &&
        normalizedPath(entry.filename).toLocaleLowerCase() === DOCUMENT_SERIES_MANIFEST_NAME,
    );
    if (!manifestEntry) return undefined;
    const parsed = JSON.parse(await manifestEntry.getData!(new TextWriter())) as unknown;
    if (!isDocumentSeriesManifest(parsed)) throw new Error('연재 문서 manifest가 올바르지 않습니다.');
    const byName = new Map(
      entries
        .filter((entry): entry is FileEntry => !entry.directory && Boolean((entry as FileEntry).getData))
        .map((entry) => [normalizedPath(entry.filename), entry]),
    );
    const sources = new Map<string, Blob>();
    let totalBytes = 0;
    for (const source of parsed.sources) {
      const entry = byName.get(normalizedPath(source.entryName));
      if (!entry) throw new Error(`${source.fileName} 원본이 연재 문서 패키지에서 누락되었습니다.`);
      const blobValue = await entry.getData!(new BlobWriter(source.contentType));
      if (blobValue.size !== source.byteLength) throw new Error(`${source.fileName} 원본 크기가 manifest와 다릅니다.`);
      totalBytes += blobValue.size;
      if (totalBytes > MAX_TOTAL_SOURCE_BYTES)
        throw new Error('연재 문서 원본의 전체 크기가 안전 한도를 초과했습니다.');
      const actualHash = integrityHash(new Uint8Array(await blobValue.arrayBuffer()));
      if (actualHash !== source.contentHash) throw new Error(`${source.fileName} 원본 해시가 manifest와 다릅니다.`);
      sources.set(source.id, blobValue);
    }
    return { manifest: parsed, sources };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export async function hasDocumentSeriesManifest(blob: Blob): Promise<boolean> {
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) return false;
  const reader = new ZipReader(new BlobReader(blob));
  try {
    return (await reader.getEntries()).some(
      (entry) =>
        !entry.directory && normalizedPath(entry.filename).toLocaleLowerCase() === DOCUMENT_SERIES_MANIFEST_NAME,
    );
  } finally {
    await reader.close().catch(() => undefined);
  }
}

interface ParsedSeriesSource {
  readonly descriptor: DocumentSeriesSource;
  readonly parsed: ParsedNovelImport;
  readonly selected: ReadonlySet<number>;
  readonly assetIds: ReadonlyMap<string, string>;
  readonly chapterIds: ReadonlyMap<string, string>;
}

function remappedAsset(asset: ParsedNovelImportAsset, bookId: string, mappedId: string): ParsedNovelImportAsset {
  return { ...asset, id: mappedId, bookId };
}

export async function materializeDocumentSeriesArchive(
  blob: Blob,
  options: MaterializeDocumentSeriesOptions,
): Promise<ParsedNovelImport> {
  const archive = await readDocumentSeriesArchive(blob);
  if (!archive) throw new Error('연재 문서 manifest를 찾지 못했습니다.');
  const sourceHash = options.sourceContentHash ?? integrityHash(new Uint8Array(await blob.arrayBuffer()));
  const normalizedTextHash = integrityHash(
    archive.manifest.sources
      .flatMap((source) => [source.contentHash, ...source.includedChapterIndices.map(String)])
      .join('\n'),
  );
  const bookId = options.clientBookId?.trim() || parsedNovelId(options.fileName, normalizedTextHash);
  const parsedSources: ParsedSeriesSource[] = [];
  const chapters: Chapter[] = [];
  const embeddedAssets: ParsedNovelImportAsset[] = [];
  let totalCharacters = 0;
  let totalParagraphs = 0;
  let rawOffset = 0;
  let coverAssetId: string | undefined;
  let coverContentHash: string | undefined;
  let coverFit: 'contain' | undefined;

  for (const descriptor of [...archive.manifest.sources].sort((a, b) => a.sourceOrder - b.sourceOrder)) {
    const sourceBlob = archive.sources.get(descriptor.id);
    if (!sourceBlob) throw new Error(`${descriptor.fileName} 원본을 찾지 못했습니다.`);
    const parsed = await parsedSource({
      fileName: descriptor.fileName,
      blob: sourceBlob,
      format: descriptor.format,
      encoding: descriptor.encoding,
      chapterSplitMode: descriptor.chapterSplitMode,
    });
    const selected = new Set(descriptor.includedChapterIndices);
    if ([...selected].some((index) => !parsed.chapters.some((chapter) => chapter.index === index))) {
      throw new Error(`${descriptor.fileName}의 선택 회차가 원본 구조와 맞지 않습니다.`);
    }
    const assetIds = new Map<string, string>();
    for (const asset of parsed.embeddedAssets ?? []) {
      const mappedId = persistentId128(asset.kind, [bookId, descriptor.id, asset.id]);
      assetIds.set(asset.id, mappedId);
      embeddedAssets.push(remappedAsset(asset, bookId, mappedId));
      if (!coverAssetId && asset.kind === 'cover') {
        coverAssetId = mappedId;
        coverContentHash = asset.contentHash;
        coverFit = 'contain';
      }
    }
    const chapterIds = new Map<string, string>();
    for (const chapter of parsed.chapters) {
      if (!selected.has(chapter.index)) continue;
      const id = persistentId128('chapter', [bookId, descriptor.id, chapter.id]);
      chapterIds.set(chapter.id, id);
      const title =
        descriptor.chapterTitles?.[String(chapter.index)] ??
        (parsed.chapters.length === 1 ? descriptor.title : chapter.title);
      chapters.push({
        ...chapter,
        id,
        novelId: bookId,
        index: chapters.length + 1,
        title,
        rawStartOffset: rawOffset,
        rawEndOffset: rawOffset + chapter.characterCount,
      });
      rawOffset += chapter.characterCount + 3;
      totalCharacters += chapter.characterCount;
      totalParagraphs += chapter.paragraphCount;
    }
    parsedSources.push({ descriptor, parsed, selected, assetIds, chapterIds });
  }
  if (!chapters.length) throw new Error('연재 문서에 표시할 회차가 없습니다.');
  let consumed = false;
  const now = new Date().toISOString();
  return {
    novel: {
      id: bookId,
      format: archive.manifest.collection.format,
      title: archive.manifest.collection.title,
      author: archive.manifest.collection.author,
      seriesTitle: archive.manifest.collection.seriesTitle,
      seriesIndex: archive.manifest.collection.seriesIndex,
      description: archive.manifest.collection.description,
      language: archive.manifest.collection.language,
      readingDirection: archive.manifest.collection.readingDirection,
      tags: archive.manifest.collection.tags ? [...archive.manifest.collection.tags] : undefined,
      coverAssetId,
      coverContentHash,
      coverFit,
      sourceFileName: options.fileName,
      sourceContentType: DOCUMENT_SERIES_CONTENT_TYPE,
      sourceContentHash: sourceHash,
      sourceEncoding: archive.manifest.sources[0]?.encoding,
      rawText: '',
      normalizedText: '',
      rawTextHash: sourceHash,
      normalizedTextHash,
      createdAt: now,
      updatedAt: now,
      totalChapters: chapters.length,
      totalCharacters,
      totalParagraphs,
      coverSeed: parsedSources[0]?.parsed.novel.coverSeed ?? 0,
      lastReadChapterId: chapters[0]?.id,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
      metadataRevision: archive.manifest.collection.metadataRevision ?? 0,
    },
    chapters,
    embeddedAssets,
    consumeChapterParagraphs() {
      if (consumed) return [];
      consumed = true;
      return (async function* (): AsyncGenerator<ParsedNovelImportChapter> {
        for (const source of parsedSources) {
          const rows = source.parsed.consumeChapterParagraphs();
          for await (const row of rows) {
            if (!source.selected.has(row.chapter.index)) continue;
            const chapterId = source.chapterIds.get(row.chapter.id);
            const chapter = chapters.find((candidate) => candidate.id === chapterId);
            if (!chapter) throw new Error('연재 문서 회차 identity를 복원하지 못했습니다.');
            const paragraphs = (function* (): Generator<Paragraph> {
              for (const paragraph of row.paragraphs) {
                yield {
                  ...paragraph,
                  id: persistentId128('paragraph', [bookId, chapter.id, String(paragraph.index), paragraph.textHash]),
                  novelId: bookId,
                  chapterId: chapter.id,
                  assetId: paragraph.assetId ? source.assetIds.get(paragraph.assetId) : undefined,
                  sourceHref: paragraph.sourceHref
                    ? `moya-series:${source.descriptor.id}/${paragraph.sourceHref}`
                    : undefined,
                };
              }
            })();
            yield { chapter, paragraphs };
          }
        }
      })();
    },
  };
}
