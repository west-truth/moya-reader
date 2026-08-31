import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js';
import type { ParsedNovelImport, ParsedNovelImportAsset } from '@noveldesk/contracts';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import {
  inspectSeriesArchiveManifest,
  isSeriesImageArchiveManifest,
  readSeriesImageArchiveManifest,
  type SeriesImageArchiveManifest,
} from './series-image-archive';

/** The small active source is a real, hashed ZIP. Original CBZs are immutable assets, not nested rewrites. */
export const COMIC_SOURCE_CONTENT_TYPE = 'application/vnd.moya.comic-manifest+zip';
const PACKAGE_ROOT = 'moya-comic-source.cbz';
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_PAGES = 5_000;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ZIP_OPTIONS = { level: 0, lastModDate: new Date('2000-01-01T00:00:00Z') } as const;

export interface ComicSourcePart {
  readonly contentHash: string;
  readonly byteLength: number;
  readonly fileName: string;
  readonly contentType: string;
}

export interface ComicSourcePage {
  readonly partHash: string;
  readonly entryName: string;
  /** Original archive index: preserves page asset identities when chapters are reordered. */
  readonly sourcePageIndex: number;
  readonly contentType: string;
}

export interface ComicSourceManifest extends SeriesImageArchiveManifest {
  readonly storageVersion: 1;
  readonly sourceParts: readonly ComicSourcePart[];
  readonly sourcePages: readonly ComicSourcePage[];
}

export interface ComicSourceAppendPlan {
  readonly manifest: ComicSourceManifest;
  readonly source: Blob;
  readonly sourceContentHash: string;
  readonly changedSectionIds: readonly string[];
  readonly replacedSectionIds: readonly string[];
  /** Only first legacy adoption and the uploaded delta. Never load old parts for an ordinary append. */
  readonly newParts: ReadonlyMap<string, Blob>;
  readonly retainedPageIds: readonly string[];
  readonly retainedPartIds: readonly string[];
  readonly pageAssetIds: readonly string[];
}

export function comicPartAssetId(bookId: string, hash: string): string {
  return persistentId128('comic_source_part', [bookId, hash]);
}

export function comicPageAssetId(bookId: string, page: ComicSourcePage): string {
  return persistentId128('document_page', [bookId, page.partHash, String(page.sourcePageIndex + 1), page.entryName]);
}

function pageName(page: ComicSourcePage): string {
  return `${page.partHash.slice(7)}/${page.entryName}`;
}

function safeEntryName(value: string): boolean {
  return (
    value.length <= 1024 &&
    // eslint-disable-next-line no-control-regex -- Reject control bytes in untrusted archive paths.
    !/[\\\x00-\x1f]/u.test(value) &&
    !value.startsWith('/') &&
    !value.includes(':') &&
    !value.split('/').some((part) => part === '..' || part === '.')
  );
}

export function assertComicSourceManifest(value: unknown): asserts value is ComicSourceManifest {
  if (!isSeriesImageArchiveManifest(value)) throw new Error('만화 회차 원본 목록이 올바르지 않습니다.');
  const candidate = value as Partial<ComicSourceManifest>;
  if (
    candidate.storageVersion !== 1 ||
    !Array.isArray(candidate.sourceParts) ||
    !Array.isArray(candidate.sourcePages) ||
    !candidate.sourceParts.length ||
    candidate.sourceParts.length > MAX_PAGES ||
    !candidate.sourcePages.length ||
    candidate.sourcePages.length > MAX_PAGES
  ) {
    throw new Error('지원하지 않는 만화 회차 원본 목록입니다.');
  }
  const parts = new Map<string, ComicSourcePart>();
  let totalBytes = 0;
  for (const part of candidate.sourceParts) {
    if (
      !part ||
      typeof part.contentHash !== 'string' ||
      !HASH.test(part.contentHash) ||
      parts.has(part.contentHash) ||
      !Number.isSafeInteger(part.byteLength) ||
      part.byteLength <= 0 ||
      part.byteLength > MAX_BYTES ||
      typeof part.fileName !== 'string' ||
      !safeEntryName(part.fileName) ||
      !/\.cbz$/iu.test(part.fileName) ||
      part.contentType !== 'application/vnd.comicbook+zip'
    )
      throw new Error('만화 회차 원본 참조가 올바르지 않습니다.');
    totalBytes += part.byteLength;
    parts.set(part.contentHash, part);
  }
  if (totalBytes > MAX_BYTES) throw new Error('만화 회차 원본의 전체 크기가 안전 한도를 초과했습니다.');
  const pageNames = new Set<string>();
  const referencedParts = new Set<string>();
  for (const page of candidate.sourcePages) {
    if (
      !page ||
      !parts.has(page.partHash) ||
      typeof page.entryName !== 'string' ||
      !safeEntryName(page.entryName) ||
      !Number.isSafeInteger(page.sourcePageIndex) ||
      page.sourcePageIndex < 0 ||
      page.sourcePageIndex >= MAX_PAGES ||
      !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(page.contentType) ||
      pageNames.has(pageName(page))
    ) {
      throw new Error('만화 회차 페이지 참조가 올바르지 않습니다.');
    }
    pageNames.add(pageName(page));
    referencedParts.add(page.partHash);
  }
  const sections = new Set<string>();
  const referencedPages = new Set<string>();
  const orderedPages: string[] = [];
  for (const chapter of value.chapters) {
    if (sections.has(chapter.remoteId)) throw new Error('만화 원본에 중복 회차가 있습니다.');
    sections.add(chapter.remoteId);
    for (const name of chapter.entryNames) {
      if (!pageNames.has(name) || referencedPages.has(name)) throw new Error('만화 회차와 페이지 목록이 다릅니다.');
      referencedPages.add(name);
      orderedPages.push(name);
    }
  }
  if (
    referencedPages.size !== pageNames.size ||
    referencedParts.size !== parts.size ||
    candidate.sourcePages.some((page, index) => pageName(page) !== orderedPages[index])
  ) {
    throw new Error('만화 회차에 연결되지 않은 원본이나 페이지가 있습니다.');
  }
}

export async function readComicSourceManifest(source: Blob): Promise<ComicSourceManifest | undefined> {
  const manifest = await readSeriesImageArchiveManifest(source);
  if (!manifest || !('storageVersion' in manifest)) return undefined;
  assertComicSourceManifest(manifest);
  return manifest;
}

async function writeManifest(manifest: ComicSourceManifest): Promise<Blob> {
  assertComicSourceManifest(manifest);
  const json = JSON.stringify(manifest);
  if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024)
    throw new Error('만화 회차 원본 목록이 안전 한도를 초과했습니다.');
  const writer = new ZipWriter(new BlobWriter(COMIC_SOURCE_CONTENT_TYPE));
  await writer.add('moya-series.json', new TextReader(json), ZIP_OPTIONS);
  return writer.close();
}

function orderChapters(
  left: SeriesImageArchiveManifest['chapters'][number],
  right: SeriesImageArchiveManifest['chapters'][number],
) {
  if (left.sourceOrder !== undefined && right.sourceOrder !== undefined && left.sourceOrder !== right.sourceOrder)
    return left.sourceOrder - right.sourceOrder;
  if (
    left.chapterNumber !== undefined &&
    right.chapterNumber !== undefined &&
    left.chapterNumber !== right.chapterNumber
  )
    return left.chapterNumber - right.chapterNumber;
  return left.title.localeCompare(right.title, 'ko', { numeric: true });
}

async function archiveManifest(source: Blob, hash: string, signal: AbortSignal): Promise<ComicSourceManifest> {
  const { openImageArchiveStream } = await import('./index');
  const series = await inspectSeriesArchiveManifest(source, signal, 'delta archive');
  const document = await openImageArchiveStream(source, { signal, fileName: 'chapter.cbz' });
  const pagesByName = new Map(
    document.pages.map((page, index) => [
      page.fileName,
      {
        partHash: hash,
        entryName: page.fileName,
        sourcePageIndex: index,
        contentType: page.contentType,
      } satisfies ComicSourcePage,
    ]),
  );
  const chapters = series.chapters.map((chapter) => ({
    ...chapter,
    entryNames: chapter.entryNames.map((name) => pageName(pagesByName.get(name)!)),
  }));
  const sourcePages = series.chapters.flatMap((chapter) => chapter.entryNames.map((name) => pagesByName.get(name)!));
  const manifest: ComicSourceManifest = {
    ...series,
    storageVersion: 1,
    chapters,
    sourcePages,
    sourceParts: [
      {
        contentHash: hash,
        byteLength: source.size,
        fileName: 'chapter.cbz',
        contentType: 'application/vnd.comicbook+zip',
      },
    ],
  };
  assertComicSourceManifest(manifest);
  return manifest;
}

export async function planComicSourceAppend(input: {
  readonly bookId: string;
  readonly existingSource: Blob;
  readonly existingSourceHash: string;
  readonly delta: Blob;
  readonly deltaHash: string;
  readonly signal: AbortSignal;
  readonly existingAssets?: readonly { id: string; kind: string; contentHash: string; pageIndex?: number }[];
}): Promise<ComicSourceAppendPlan> {
  input.signal.throwIfAborted();
  const stored = await readComicSourceManifest(input.existingSource);
  const base = stored ?? (await archiveManifest(input.existingSource, input.existingSourceHash, input.signal));
  const delta = await archiveManifest(input.delta, input.deltaHash, input.signal);
  const targetsBook = delta.targetBookId === input.bookId;
  if (
    (delta.targetBookId && !targetsBook) ||
    (base.collection.remoteId !== delta.collection.remoteId && !targetsBook)
  ) {
    throw new Error('추가할 만화 회차의 대상 작품이 일치하지 않습니다.');
  }
  const chapters = new Map(base.chapters.map((chapter) => [chapter.remoteId, chapter]));
  const changedSectionIds: string[] = [];
  const replacedSectionIds: string[] = [];
  const normalize = (hash: string) => hash.replace(/^sha256:/iu, '').toLowerCase();
  for (const chapter of delta.chapters) {
    const old = chapters.get(chapter.remoteId);
    if (old && normalize(old.sourceContentHash) === normalize(chapter.sourceContentHash)) continue;
    if (
      old &&
      chapter.expectedPreviousSourceContentHash &&
      normalize(old.sourceContentHash) !== normalize(chapter.expectedPreviousSourceContentHash)
    ) {
      throw new Error('다른 작업이 먼저 변경한 만화 회차를 덮어쓰지 않았습니다.');
    }
    changedSectionIds.push(chapter.remoteId);
    if (old || chapter.expectedPreviousSourceContentHash) replacedSectionIds.push(chapter.remoteId);
    const { expectedPreviousSourceContentHash: _expected, ...next } = chapter;
    chapters.set(chapter.remoteId, next);
  }
  const newParts = new Map<string, Blob>();
  if (!changedSectionIds.length)
    return {
      manifest: base,
      source: input.existingSource,
      sourceContentHash: input.existingSourceHash,
      changedSectionIds,
      replacedSectionIds,
      newParts,
      retainedPageIds: [],
      retainedPartIds: [],
      pageAssetIds: [],
    };
  const additions = await splitAddedChapters(input.delta, delta, new Set(changedSectionIds), input.signal);
  for (const addition of additions) {
    const { expectedPreviousSourceContentHash: _expected, ...chapter } = addition.manifest.chapters[0]!;
    chapters.set(chapter.remoteId, chapter);
    newParts.set(addition.manifest.sourceParts[0]!.contentHash, addition.blob);
  }
  const ordered = [...chapters.values()].sort(orderChapters);
  const pages = new Map(
    [...base.sourcePages, ...additions.flatMap((part) => part.manifest.sourcePages)].map((page) => [
      pageName(page),
      page,
    ]),
  );
  const sourcePages = ordered.flatMap((chapter) => chapter.entryNames.map((name) => pages.get(name)!));
  const partHashes = new Set(sourcePages.map((page) => page.partHash));
  const parts = new Map(
    [...base.sourceParts, ...additions.flatMap((part) => part.manifest.sourceParts)].map((part) => [
      part.contentHash,
      part,
    ]),
  );
  const manifest: ComicSourceManifest = {
    schemaVersion: 1,
    storageVersion: 1,
    collection: base.collection.remoteId === delta.collection.remoteId ? delta.collection : base.collection,
    chapters: ordered,
    sourcePages,
    sourceParts: [...parts.values()].filter((part) => partHashes.has(part.contentHash)),
  };
  if (!stored && partHashes.has(input.existingSourceHash)) newParts.set(input.existingSourceHash, input.existingSource);
  const source = await writeManifest(manifest);
  const basePageNames = new Set(base.sourcePages.map(pageName));
  const existingPages = new Map(
    input.existingAssets?.filter((asset) => asset.kind === 'document_page').map((asset) => [asset.pageIndex, asset.id]),
  );
  const oldPageIds = new Map(
    base.sourcePages.map((page, index) => {
      const id = existingPages.get(stored ? index : page.sourcePageIndex);
      if (input.existingAssets && !id) throw new Error('기존 만화 페이지 연결이 없어 변경하지 않았습니다.');
      return [pageName(page), id ?? comicPageAssetId(input.bookId, page)];
    }),
  );
  const pageAssetIds = sourcePages.map(
    (page) => oldPageIds.get(pageName(page)) ?? comicPageAssetId(input.bookId, page),
  );
  return {
    manifest,
    source,
    sourceContentHash: integrityHash(new Uint8Array(await source.arrayBuffer())),
    changedSectionIds,
    replacedSectionIds,
    newParts,
    pageAssetIds,
    retainedPageIds: sourcePages
      .filter((page) => basePageNames.has(pageName(page)))
      .map((page) => oldPageIds.get(pageName(page))!),
    retainedPartIds: manifest.sourceParts
      .filter((part) => stored?.sourceParts.some((old) => old.contentHash === part.contentHash))
      .map(
        (part) =>
          input.existingAssets?.find((asset) => asset.kind === 'source_part' && asset.contentHash === part.contentHash)
            ?.id ?? comicPartAssetId(input.bookId, part.contentHash),
      ),
  };
}

/** A multi-selection upload is transport only. Each newly stored chapter gets its own immutable original. */
async function splitAddedChapters(
  blob: Blob,
  delta: ComicSourceManifest,
  changed: ReadonlySet<string>,
  signal: AbortSignal,
) {
  if (delta.chapters.length === 1) return [{ manifest: delta, blob }];
  const reader = new ZipReader(new BlobReader(blob), { signal });
  const result: Array<{ manifest: ComicSourceManifest; blob: Blob }> = [];
  try {
    const entries = new Map((await reader.getEntries()).map((entry) => [entry.filename, entry]));
    const pages = new Map(delta.sourcePages.map((page) => [pageName(page), page]));
    for (const chapter of delta.chapters.filter((chapter) => changed.has(chapter.remoteId))) {
      signal.throwIfAborted();
      const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
      try {
        const entryNames = chapter.entryNames.map((name) => pages.get(name)!.entryName);
        for (const name of entryNames) {
          signal.throwIfAborted();
          const entry = entries.get(name);
          if (!entry || entry.directory || !entry.getData) throw new Error('추가할 회차 원본에 페이지가 없습니다.');
          await writer.add(name, new BlobReader(await entry.getData(new BlobWriter())), ZIP_OPTIONS);
        }
        const { expectedPreviousSourceContentHash: _expected, ...metadata } = chapter;
        await writer.add(
          'moya-series.json',
          new TextReader(
            JSON.stringify({ schemaVersion: 1, collection: delta.collection, chapters: [{ ...metadata, entryNames }] }),
          ),
          ZIP_OPTIONS,
        );
        const part = await writer.close();
        result.push({
          blob: part,
          manifest: await archiveManifest(part, integrityHash(new Uint8Array(await part.arrayBuffer())), signal),
        });
      } catch (error) {
        await writer.close().catch(() => undefined);
        throw error;
      }
    }
    return result;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

/** Reuses the existing chapter/paragraph identity and reader layout contracts; no new reader runtime. */
export async function materializeComicSource(input: {
  readonly manifest: ComicSourceManifest;
  readonly sourceContentHash: string;
  readonly fileName: string;
  readonly bookId: string;
  readonly partsToStore: ReadonlyMap<string, Blob>;
  readonly pagePartsToRead: ReadonlyMap<string, Blob>;
  readonly pageAssetIdsToRead?: ReadonlySet<string>;
  readonly pageAssetIds?: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<ParsedNovelImport> {
  const { materializeFixedImport, openImageArchiveStream } = await import('./index');
  assertComicSourceManifest(input.manifest);
  const { manifest, bookId } = input;
  const parsed = materializeFixedImport({
    format: 'image_archive',
    fileName: input.fileName,
    sourceContentHash: input.sourceContentHash,
    pageCount: manifest.sourcePages.length,
    pageDescriptors: manifest.sourcePages.map((page) => ({ fileName: pageName(page), contentType: page.contentType })),
    pageAssetIds: input.pageAssetIds ?? manifest.sourcePages.map((page) => comicPageAssetId(bookId, page)),
    moyaSeries: manifest,
    title: manifest.collection.title,
    author: manifest.collection.author,
    clientBookId: bookId,
    async *consumeEmbeddedAssets() {
      for (const part of manifest.sourceParts) {
        const blob = input.partsToStore.get(part.contentHash);
        if (!blob) continue;
        input.signal?.throwIfAborted();
        yield {
          id: comicPartAssetId(bookId, part.contentHash),
          bookId,
          kind: 'source_part',
          provenance: 'archive_embedded',
          fileName: part.fileName,
          contentType: part.contentType,
          contentHash: part.contentHash,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        } satisfies ParsedNovelImportAsset;
      }
      for (const [hash, blob] of input.pagePartsToRead) {
        const wanted = new Map(
          manifest.sourcePages.flatMap((page, index) =>
            page.partHash === hash &&
            (!input.pageAssetIdsToRead ||
              input.pageAssetIdsToRead.has(input.pageAssetIds?.[index] ?? comicPageAssetId(bookId, page)))
              ? [[page.entryName, { page, index }] as const]
              : [],
          ),
        );
        if (!wanted.size) continue;
        const document = await openImageArchiveStream(blob, { fileName: 'chapter.cbz', signal: input.signal });
        for await (const image of document.consumePages()) {
          const location = wanted.get(image.fileName);
          if (!location) continue;
          input.signal?.throwIfAborted();
          yield {
            id: input.pageAssetIds?.[location.index] ?? comicPageAssetId(bookId, location.page),
            bookId,
            kind: 'document_page',
            provenance: 'archive_embedded',
            fileName: image.fileName,
            contentType: image.contentType,
            contentHash: image.contentHash,
            pageIndex: location.index,
            bytes: image.bytes,
          } satisfies ParsedNovelImportAsset;
          wanted.delete(image.fileName);
        }
        if (wanted.size) throw new Error('만화 회차 원본에 필요한 페이지가 없습니다.');
      }
    },
  });
  parsed.novel.sourceContentType = COMIC_SOURCE_CONTENT_TYPE;
  return parsed;
}

export async function validateComicPart(part: ComicSourcePart, blob: Blob): Promise<void> {
  if (blob.size !== part.byteLength || integrityHash(new Uint8Array(await blob.arrayBuffer())) !== part.contentHash) {
    throw new Error('만화 회차 원본이 목록의 식별자와 일치하지 않습니다.');
  }
}

/** Portable backup/import transport only. Runtime append never creates this package. */
export async function packageComicSource(
  source: Blob,
  readPart: (part: ComicSourcePart) => Promise<Blob>,
): Promise<Blob> {
  const manifest = await readComicSourceManifest(source);
  if (!manifest) return source;
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  try {
    await writer.add(PACKAGE_ROOT, new BlobReader(source), ZIP_OPTIONS);
    for (const part of manifest.sourceParts) {
      const blob = await readPart(part);
      await validateComicPart(part, blob);
      await writer.add(`parts/${part.contentHash.slice(7)}.cbz`, new BlobReader(blob), ZIP_OPTIONS);
    }
    return await writer.close();
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}

export async function unpackComicSource(
  source: Blob,
): Promise<{ source: Blob; manifest: ComicSourceManifest; parts: Map<string, Blob> } | undefined> {
  const reader = new ZipReader(new BlobReader(source));
  try {
    const entries = await reader.getEntries();
    const root = entries.find((entry) => !entry.directory && entry.filename === PACKAGE_ROOT);
    if (!root || root.directory || !root.getData) return undefined;
    if (
      entries.length > MAX_PAGES + 1 ||
      root.uncompressedSize > 4 * 1024 * 1024 ||
      entries.some(
        (entry) =>
          entry.encrypted ||
          entry.uncompressedSize > MAX_BYTES ||
          entry.uncompressedSize > Math.max(1, entry.compressedSize) * 250,
      )
    ) {
      throw new Error('만화 회차 패키지가 안전 한도를 초과했습니다.');
    }
    const unpackedSource = await root.getData(new BlobWriter(COMIC_SOURCE_CONTENT_TYPE));
    const manifest = await readComicSourceManifest(unpackedSource);
    if (!manifest || entries.length !== manifest.sourceParts.length + 1)
      throw new Error('만화 회차 패키지 목록이 올바르지 않습니다.');
    const parts = new Map<string, Blob>();
    for (const part of manifest.sourceParts) {
      const name = `parts/${part.contentHash.slice(7)}.cbz`;
      const matching = entries.filter((entry) => entry.filename === name);
      const entry = matching[0];
      if (
        matching.length !== 1 ||
        !entry ||
        entry.directory ||
        !entry.getData ||
        entry.uncompressedSize !== part.byteLength
      )
        throw new Error('만화 회차 원본 파일이 누락되었습니다.');
      const blob = await entry.getData(new BlobWriter(part.contentType));
      await validateComicPart(part, blob);
      const { openImageArchiveStream } = await import('./index');
      const document = await openImageArchiveStream(blob, { fileName: part.fileName });
      if (
        manifest.sourcePages
          .filter((page) => page.partHash === part.contentHash)
          .some(
            (page) =>
              document.pages[page.sourcePageIndex]?.fileName !== page.entryName ||
              document.pages[page.sourcePageIndex]?.contentType !== page.contentType,
          )
      ) {
        throw new Error('만화 회차 원본의 페이지 순서가 목록과 다릅니다.');
      }
      parts.set(part.contentHash, blob);
    }
    return { source: unpackedSource, manifest, parts };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

/** Explicit CBZ export and legacy controller fallback. Expensive reconstruction happens only on request. */
export async function flattenComicSource(
  source: Blob,
  readPart: (part: ComicSourcePart) => Promise<Blob>,
): Promise<Blob> {
  const manifest = await readComicSourceManifest(source);
  if (!manifest) return source;
  const { openImageArchiveStream } = await import('./index');
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  const portableNames = new Map(
    manifest.sourcePages.map((page, index) => [
      pageName(page),
      `pages/${String(index + 1).padStart(6, '0')}.${page.entryName.split('.').at(-1)}`,
    ]),
  );
  try {
    for (const part of manifest.sourceParts) {
      const blob = await readPart(part);
      await validateComicPart(part, blob);
      const wanted = new Set(
        manifest.sourcePages.filter((page) => page.partHash === part.contentHash).map((page) => page.entryName),
      );
      const document = await openImageArchiveStream(blob, { fileName: 'chapter.cbz' });
      for await (const page of document.consumePages()) {
        if (!wanted.delete(page.fileName)) continue;
        await writer.add(
          portableNames.get(`${part.contentHash.slice(7)}/${page.fileName}`)!,
          new BlobReader(new Blob([page.bytes as BlobPart])),
          ZIP_OPTIONS,
        );
      }
      if (wanted.size) throw new Error('내보낼 만화 회차 페이지가 없습니다.');
    }
    const { storageVersion: _version, sourceParts: _parts, sourcePages: _pages, ...series } = manifest;
    await writer.add(
      'moya-series.json',
      new TextReader(
        JSON.stringify({
          ...series,
          chapters: series.chapters.map((chapter) => ({
            ...chapter,
            entryNames: chapter.entryNames.map((name) => portableNames.get(name)!),
          })),
        }),
      ),
      ZIP_OPTIONS,
    );
    return await writer.close();
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}
