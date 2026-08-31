import {
  BlobReader,
  ERR_ENCRYPTED,
  ERR_INVALID_PASSWORD,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js';
import SevenZip, { type SevenZipModule } from '7z-wasm';
import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';
import { createExtractorFromData, UnrarError, type FileHeader } from 'node-unrar-js';
import type { PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  BookFormat,
  Chapter,
  Paragraph,
  ParsedNovelImport,
  ParsedNovelImportAsset,
  ParsedNovelImportChapter,
} from '@noveldesk/contracts';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { parsedChapterId, parsedNovelId, parsedParagraphId } from '@noveldesk/text-core/identity/parser';

const MAX_ARCHIVE_ENTRIES = 6_000;
const MAX_PAGE_COUNT = 5_000;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const MAX_COMIC_INFO_BYTES = 512 * 1024;
const MAX_MOYA_SERIES_MANIFEST_BYTES = 1024 * 1024;

const IMAGE_TYPES = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
] as const);

export class FixedDocumentImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_pdf'
      | 'invalid_archive'
      | 'unsafe_archive'
      | 'no_pages'
      | 'too_many_pages'
      | 'password_required'
      | 'wrong_password'
      | 'unsupported_archive',
  ) {
    super(message);
    this.name = 'FixedDocumentImportError';
  }
}

export interface ImageArchivePage {
  readonly fileName: string;
  readonly contentType: string;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

export interface ImageArchivePageDescriptor {
  readonly fileName: string;
  readonly contentType: string;
}

export interface StreamingImageArchiveDocument {
  readonly pages: readonly ImageArchivePageDescriptor[];
  readonly comicInfo?: ComicInfoMetadata;
  readonly moyaSeries?: MoyaSeriesManifest;
  consumePages(): AsyncIterable<ImageArchivePage>;
}

export interface ImageArchiveDocument {
  readonly pages: readonly ImageArchivePage[];
  readonly comicInfo?: ComicInfoMetadata;
  readonly moyaSeries?: MoyaSeriesManifest;
}

export interface MoyaSeriesManifestChapter {
  readonly remoteId: string;
  readonly title: string;
  readonly chapterNumber?: number;
  readonly sourceOrder?: number;
  readonly remoteRevision?: string;
  readonly sourceContentHash?: string;
  readonly pageCount: number;
  readonly entryNames: readonly string[];
}

export interface MoyaSeriesManifest {
  readonly schemaVersion: 1;
  readonly collection: { readonly remoteId: string; readonly title: string };
  readonly chapters: readonly MoyaSeriesManifestChapter[];
}

export type ImageArchiveFormat = 'zip' | 'rar4' | 'rar5' | '7z';

export interface ImageArchiveParseOptions {
  readonly fileName?: string;
  readonly password?: string;
  readonly signal?: AbortSignal;
}

export interface ComicInfoPageMetadata {
  readonly image: number;
  readonly type?: string;
  readonly bookmark?: string;
  readonly doublePage: boolean;
}

export interface ComicInfoMetadata {
  readonly title?: string;
  readonly series?: string;
  readonly number?: number;
  readonly summary?: string;
  readonly writer?: string;
  readonly language?: string;
  readonly tags: readonly string[];
  readonly readingDirection?: 'ltr' | 'rtl';
  readonly pages: readonly ComicInfoPageMetadata[];
}

function parseMoyaSeriesManifest(text: string): MoyaSeriesManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FixedDocumentImportError('Moya 연재 작품 정보가 올바른 JSON이 아닙니다.', 'invalid_archive');
  }
  if (!value || typeof value !== 'object') {
    throw new FixedDocumentImportError('Moya 연재 작품 정보가 올바르지 않습니다.', 'invalid_archive');
  }
  const manifest = value as Partial<MoyaSeriesManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.collection?.remoteId ||
    !manifest.collection.title ||
    !Array.isArray(manifest.chapters) ||
    !manifest.chapters.every(
      (chapter) =>
        typeof chapter?.remoteId === 'string' &&
        Boolean(chapter.remoteId) &&
        typeof chapter.title === 'string' &&
        Boolean(chapter.title) &&
        (chapter.remoteRevision === undefined || typeof chapter.remoteRevision === 'string') &&
        (chapter.sourceContentHash === undefined || typeof chapter.sourceContentHash === 'string') &&
        Number.isInteger(chapter.pageCount) &&
        chapter.pageCount > 0 &&
        Array.isArray(chapter.entryNames) &&
        chapter.entryNames.length === chapter.pageCount,
    )
  ) {
    throw new FixedDocumentImportError('Moya 연재 작품 정보가 올바르지 않습니다.', 'invalid_archive');
  }
  return manifest as MoyaSeriesManifest;
}

function normalizedArchivePath(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new FixedDocumentImportError('이미지 ZIP의 파일명 인코딩이 올바르지 않습니다.', 'unsafe_archive');
  }
  const clean = decoded.replace(/\\/g, '/').trim();
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) {
    throw new FixedDocumentImportError('이미지 ZIP에 허용되지 않는 절대 경로가 있습니다.', 'unsafe_archive');
  }
  const parts: string[] = [];
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new FixedDocumentImportError('이미지 ZIP 경로가 압축 파일 밖을 가리킵니다.', 'unsafe_archive');
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new FixedDocumentImportError('이미지 ZIP 경로가 비어 있습니다.', 'unsafe_archive');
  return parts.join('/');
}

function imageContentType(fileName: string): string | undefined {
  const extension = fileName.split('.').at(-1)?.toLowerCase();
  return extension ? IMAGE_TYPES.get(extension as 'jpg' | 'jpeg' | 'png' | 'webp' | 'gif') : undefined;
}

function imageSignatureMatches(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png')
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === 'image/webp')
    return (
      bytes.length >= 12 &&
      new TextDecoder('ascii').decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder('ascii').decode(bytes.slice(8, 12)) === 'WEBP'
    );
  if (contentType === 'image/gif') {
    const signature = new TextDecoder('ascii').decode(bytes.slice(0, 6));
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return false;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function comicInfoValue(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  const value = match ? decodeXmlText(match[1]) : '';
  return value || undefined;
}

export function parseComicInfoXml(bytes: Uint8Array): ComicInfoMetadata {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMIC_INFO_BYTES) {
    throw new FixedDocumentImportError('ComicInfo.xml 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
  }
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\s*(?:xi:)?include\b/i.test(xml)) {
    throw new FixedDocumentImportError(
      'ComicInfo.xml의 외부 엔터티와 포함 문법은 허용되지 않습니다.',
      'unsafe_archive',
    );
  }
  const nodeCount = (xml.match(/<[^!?/][^>]*>/g) ?? []).length;
  if (nodeCount > 20_000) {
    throw new FixedDocumentImportError('ComicInfo.xml 노드 수가 안전 한도를 초과했습니다.', 'unsafe_archive');
  }
  const attributes = (source: string) => {
    const values = new Map<string, string>();
    for (const match of source.matchAll(/([A-Za-z][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      values.set(match[1].toLocaleLowerCase(), decodeXmlText(match[2] ?? match[3] ?? ''));
    }
    return values;
  };
  const pages: ComicInfoPageMetadata[] = [];
  for (const match of xml.matchAll(/<Page\b([^>]*)\/?\s*>/gi)) {
    const values = attributes(match[1]);
    const image = Number.parseInt(values.get('image') ?? '', 10);
    if (!Number.isSafeInteger(image) || image < 0 || image >= MAX_PAGE_COUNT) continue;
    pages.push({
      image,
      type: values.get('type') || undefined,
      bookmark: values.get('bookmark') || undefined,
      doublePage: /^(?:1|true|yes)$/i.test(values.get('doublepagesize') ?? ''),
    });
  }
  const tagValues = [comicInfoValue(xml, 'Genre'), comicInfoValue(xml, 'Tags')]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.trim())
    .filter(Boolean);
  const manga = comicInfoValue(xml, 'Manga')?.toLocaleLowerCase();
  const number = Number.parseFloat(comicInfoValue(xml, 'Number') ?? '');
  return {
    title: comicInfoValue(xml, 'Title'),
    series: comicInfoValue(xml, 'Series'),
    number: Number.isFinite(number) ? number : undefined,
    summary: comicInfoValue(xml, 'Summary'),
    writer: comicInfoValue(xml, 'Writer'),
    language: comicInfoValue(xml, 'LanguageISO'),
    tags: [...new Set(tagValues)],
    readingDirection: manga?.includes('righttoleft') ? 'rtl' : undefined,
    pages,
  };
}

function validatedImageEntries(
  entries: readonly Entry[],
): Array<{ entry: FileEntry; path: string; contentType: string }> {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new FixedDocumentImportError('이미지 ZIP 항목 수가 안전 한도를 초과했습니다.', 'too_many_pages');
  }
  const result: Array<{ entry: FileEntry; path: string; contentType: string }> = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    const path = normalizedArchivePath(entry.filename);
    const key = path.toLocaleLowerCase();
    if (paths.has(key)) throw new FixedDocumentImportError('이미지 ZIP에 중복 경로가 있습니다.', 'unsafe_archive');
    paths.add(key);
    const contentType = imageContentType(path);
    if (!contentType) continue;
    const size = Number(entry.uncompressedSize ?? 0);
    const compressed = Math.max(1, Number(entry.compressedSize ?? size));
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PAGE_BYTES) {
      throw new FixedDocumentImportError('이미지 한 장의 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
    }
    if (size > compressed * MAX_COMPRESSION_RATIO) {
      throw new FixedDocumentImportError('이미지 ZIP 압축 비율이 안전 한도를 초과했습니다.', 'unsafe_archive');
    }
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new FixedDocumentImportError('이미지 ZIP 해제 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
    }
    result.push({ entry: entry as FileEntry, path, contentType });
  }
  if (result.length === 0)
    throw new FixedDocumentImportError('압축 파일 안에서 지원하는 이미지 페이지를 찾지 못했습니다.', 'no_pages');
  if (result.length > MAX_PAGE_COUNT)
    throw new FixedDocumentImportError('이미지 페이지 수가 지원 한도를 초과했습니다.', 'too_many_pages');
  return result.sort((left, right) => naturalCompare(left.path, right.path));
}

export function detectImageArchiveFormat(bytes: Uint8Array): ImageArchiveFormat | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]))
    return 'zip';
  if (
    bytes.length >= 7 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x72 &&
    bytes[3] === 0x21 &&
    bytes[4] === 0x1a &&
    bytes[5] === 0x07
  ) {
    return bytes[6] === 0x01 ? 'rar5' : bytes[6] === 0x00 ? 'rar4' : undefined;
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x37 &&
    bytes[1] === 0x7a &&
    bytes[2] === 0xbc &&
    bytes[3] === 0xaf &&
    bytes[4] === 0x27 &&
    bytes[5] === 0x1c
  )
    return '7z';
  return undefined;
}

function validateSevenZipHeaderBounds(source: Uint8Array): void {
  // 7z keeps the next-header offset/size in its fixed 32-byte signature header.
  // Checking the declared end prevents a truncated archive from being mistaken
  // for a valid archive that simply contains no image pages.
  if (source.byteLength < 32)
    throw new FixedDocumentImportError('7z signature header가 잘렸습니다.', 'invalid_archive');
  const header = new DataView(source.buffer, source.byteOffset, 32);
  const nextHeaderOffset = header.getBigUint64(12, true);
  const nextHeaderSize = header.getBigUint64(20, true);
  const declaredEnd = 32n + nextHeaderOffset + nextHeaderSize;
  if (declaredEnd > BigInt(source.byteLength))
    throw new FixedDocumentImportError('7z next header가 파일 끝에서 잘렸습니다.', 'invalid_archive');
}

function mappedArchiveError(error: unknown, password?: string): FixedDocumentImportError {
  if (error instanceof FixedDocumentImportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === ERR_ENCRYPTED ||
    message === ERR_INVALID_PASSWORD ||
    /passphrase|password|encrypted|decryption failed/i.test(message)
  ) {
    return new FixedDocumentImportError(
      password ? '압축 파일 암호가 올바르지 않습니다.' : '암호가 필요한 압축 파일입니다.',
      password ? 'wrong_password' : 'password_required',
    );
  }
  if (/unsupported|unrecognized archive|not supported/i.test(message)) {
    return new FixedDocumentImportError('이 압축 방식은 현재 backend에서 지원하지 않습니다.', 'unsupported_archive');
  }
  return new FixedDocumentImportError(
    message ? `이미지 압축 파일을 읽을 수 없습니다: ${message}` : '이미지 압축 파일을 읽을 수 없습니다.',
    'invalid_archive',
  );
}

export async function openZipImageArchiveStream(
  blob: Blob,
  options: ImageArchiveParseOptions = {},
): Promise<StreamingImageArchiveDocument> {
  let reader: ZipReader<Blob> | undefined;
  try {
    reader = new ZipReader(new BlobReader(blob), { password: options.password, signal: options.signal });
    const entries = await reader.getEntries();
    const records = validatedImageEntries(entries);
    const comicInfoEntry = entries.find(
      (entry) => !entry.directory && normalizedArchivePath(entry.filename).toLocaleLowerCase() === 'comicinfo.xml',
    ) as FileEntry | undefined;
    const seriesManifestEntry = entries.find(
      (entry) => !entry.directory && normalizedArchivePath(entry.filename).toLocaleLowerCase() === 'moya-series.json',
    ) as FileEntry | undefined;
    let comicInfo: ComicInfoMetadata | undefined;
    let moyaSeries: MoyaSeriesManifest | undefined;
    if (comicInfoEntry) {
      if (comicInfoEntry.encrypted && !options.password)
        throw new FixedDocumentImportError('암호가 필요한 압축 파일입니다.', 'password_required');
      if (!comicInfoEntry.getData)
        throw new FixedDocumentImportError('ComicInfo.xml을 읽을 수 없습니다.', 'invalid_archive');
      if (Number(comicInfoEntry.uncompressedSize ?? 0) > MAX_COMIC_INFO_BYTES) {
        throw new FixedDocumentImportError('ComicInfo.xml 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
      }
      comicInfo = parseComicInfoXml(await comicInfoEntry.getData(new Uint8ArrayWriter()));
    }
    if (seriesManifestEntry) {
      if (seriesManifestEntry.encrypted && !options.password)
        throw new FixedDocumentImportError('암호가 필요한 압축 파일입니다.', 'password_required');
      if (!seriesManifestEntry.getData)
        throw new FixedDocumentImportError('Moya 연재 작품 정보를 읽을 수 없습니다.', 'invalid_archive');
      if (Number(seriesManifestEntry.uncompressedSize ?? 0) > MAX_MOYA_SERIES_MANIFEST_BYTES) {
        throw new FixedDocumentImportError('Moya 연재 작품 정보 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
      }
      moyaSeries = parseMoyaSeriesManifest(await seriesManifestEntry.getData(new TextWriter()));
    }
    const pages = records.map<ImageArchivePageDescriptor>((record) => ({
      fileName: record.path,
      contentType: record.contentType,
    }));
    return {
      pages,
      comicInfo,
      moyaSeries,
      async *consumePages() {
        let streamReader: ZipReader<Blob> | undefined;
        try {
          streamReader = new ZipReader(new BlobReader(blob), { password: options.password, signal: options.signal });
          const streamEntries = await streamReader.getEntries();
          const streamRecords = validatedImageEntries(streamEntries);
          if (
            streamRecords.length !== pages.length ||
            streamRecords.some(
              (record, index) =>
                record.path !== pages[index]?.fileName || record.contentType !== pages[index]?.contentType,
            )
          ) {
            throw new FixedDocumentImportError('이미지 ZIP의 페이지 목록이 검사 결과와 다릅니다.', 'invalid_archive');
          }
          for (const record of streamRecords) {
            options.signal?.throwIfAborted();
            if (record.entry.encrypted && !options.password)
              throw new FixedDocumentImportError('암호가 필요한 압축 파일입니다.', 'password_required');
            if (!record.entry.getData)
              throw new FixedDocumentImportError('이미지 페이지를 읽을 수 없습니다.', 'invalid_archive');
            const bytes = await record.entry.getData(new Uint8ArrayWriter());
            if (!imageSignatureMatches(bytes, record.contentType)) {
              throw new FixedDocumentImportError(
                `${record.path}의 실제 이미지 형식이 확장자와 다릅니다.`,
                'invalid_archive',
              );
            }
            yield {
              fileName: record.path,
              contentType: record.contentType,
              contentHash: integrityHash(bytes),
              bytes,
            };
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          throw mappedArchiveError(error, options.password);
        } finally {
          await streamReader?.close().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw mappedArchiveError(error, options.password);
  } finally {
    await reader?.close().catch(() => undefined);
  }
}

let libarchiveModulePromise: ReturnType<typeof libarchiveWasm> | undefined;

async function loadLibarchiveModule(): ReturnType<typeof libarchiveWasm> {
  if (typeof globalThis.location !== 'undefined') {
    const { default: wasmUrl } = await import('libarchive-wasm/dist/libarchive.wasm?url');
    return libarchiveWasm({ locateFile: () => wasmUrl });
  }
  return libarchiveWasm();
}

interface LibarchiveImageRecord extends ImageArchivePageDescriptor {
  readonly key: string;
}

interface SevenZipImageRecord extends LibarchiveImageRecord {
  readonly size: number;
}

interface SevenZipCommandResult {
  readonly failure?: unknown;
  readonly output: string;
}

async function createSevenZipModule(output: string[]): Promise<SevenZipModule> {
  const options = {
    noExitRuntime: true,
    print: (value: string) => output.push(value),
    printErr: (value: string) => output.push(value),
    // Archive passwords are always supplied as command arguments. Never let the
    // WASM CLI fall back to an interactive password prompt.
    stdin: () => null as unknown as number,
  };
  if (typeof globalThis.location !== 'undefined') {
    const { default: wasmUrl } = await import('7z-wasm/7zz.wasm?url');
    return SevenZip({ ...options, locateFile: () => wasmUrl });
  }
  return SevenZip(options);
}

function runSevenZipCommand(module: SevenZipModule, output: string[], args: readonly string[]): SevenZipCommandResult {
  output.length = 0;
  let failure: unknown;
  try {
    module.callMain([...args]);
  } catch (error) {
    failure = error;
  }
  return { failure, output: output.join('\n') };
}

function sevenZipListingRecords(output: string): Map<string, string>[] {
  const listingMarker = /(?:^|\n)-{10,}\r?\n/.exec(output);
  if (!listingMarker) return [];
  return output
    .slice((listingMarker.index ?? 0) + listingMarker[0].length)
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split(/\r?\n/)) {
        const separator = line.indexOf(' = ');
        if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 3));
      }
      return fields;
    })
    .filter((fields) => fields.has('Path'));
}

function clearSevenZipDirectory(module: SevenZipModule, path: string): void {
  for (const name of module.FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (module.FS.isDir(module.FS.stat(child).mode)) {
      clearSevenZipDirectory(module, child);
      module.FS.rmdir(child);
    } else {
      module.FS.unlink(child);
    }
  }
}

function extractSevenZipEntry(input: {
  module: SevenZipModule;
  output: string[];
  password: string;
  path: string;
}): Uint8Array {
  const outputRoot = '/noveldesk-output';
  clearSevenZipDirectory(input.module, outputRoot);
  const result = runSevenZipCommand(input.module, input.output, [
    'x',
    '/noveldesk-input.7z',
    `-o${outputRoot}`,
    '-aoa',
    '-y',
    `-p${input.password}`,
    '--',
    input.path,
  ]);
  if (/wrong password|data error in encrypted file/i.test(result.output)) {
    throw new FixedDocumentImportError('7z 암호가 올바르지 않습니다.', 'wrong_password');
  }
  const extractedPath = `${outputRoot}/${input.path}`;
  try {
    const bytes = Uint8Array.from(input.module.FS.readFile(extractedPath));
    clearSevenZipDirectory(input.module, outputRoot);
    return bytes;
  } catch (error) {
    clearSevenZipDirectory(input.module, outputRoot);
    throw new FixedDocumentImportError(
      error instanceof Error
        ? `7z 항목을 해제하지 못했습니다. ${error.message}`
        : result.failure
          ? '7z 항목을 해제하지 못했습니다.'
          : '7z 항목 해제 결과를 확인하지 못했습니다.',
      'invalid_archive',
    );
  }
}

async function openEncryptedSevenZipImageArchiveStream(
  source: Uint8Array,
  options: ImageArchiveParseOptions,
): Promise<StreamingImageArchiveDocument> {
  if (!options.password) throw new FixedDocumentImportError('암호가 필요한 압축 파일입니다.', 'password_required');
  options.signal?.throwIfAborted();
  const output: string[] = [];
  const module = await createSevenZipModule(output);
  module.FS.writeFile('/noveldesk-input.7z', source);
  module.FS.mkdir('/noveldesk-output');
  const listing = runSevenZipCommand(module, output, ['l', '-slt', `-p${options.password}`, '/noveldesk-input.7z']);
  if (listing.failure) {
    throw new FixedDocumentImportError('7z 암호가 올바르지 않습니다.', 'wrong_password');
  }

  const paths = new Set<string>();
  const records: SevenZipImageRecord[] = [];
  let comicInfoRecord: SevenZipImageRecord | undefined;
  let entryCount = 0;
  let expandedBytes = 0;
  for (const fields of sevenZipListingRecords(listing.output)) {
    options.signal?.throwIfAborted();
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES)
      throw new FixedDocumentImportError('압축 파일 항목 수가 안전 한도를 초과했습니다.', 'too_many_pages');
    const path = normalizedArchivePath(fields.get('Path') ?? '');
    const key = path.toLocaleLowerCase();
    if (paths.has(key)) throw new FixedDocumentImportError('압축 파일에 중복 경로가 있습니다.', 'unsafe_archive');
    paths.add(key);
    if (fields.get('Folder') === '+' || fields.get('Attributes')?.startsWith('D')) continue;
    if (fields.has('Symbolic Link') || fields.has('Hard Link')) continue;
    const contentType = imageContentType(path);
    const isComicInfo = key === 'comicinfo.xml';
    if (!contentType && !isComicInfo) continue;
    const size = Number(fields.get('Size'));
    const entryLimit = isComicInfo ? MAX_COMIC_INFO_BYTES : MAX_PAGE_BYTES;
    if (!Number.isSafeInteger(size) || size < 0 || size > entryLimit)
      throw new FixedDocumentImportError('압축 파일 항목 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES)
      throw new FixedDocumentImportError('압축 해제 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
    const record: SevenZipImageRecord = {
      key,
      fileName: path,
      contentType: contentType ?? 'application/xml',
      size,
    };
    if (isComicInfo) comicInfoRecord = record;
    else if (contentType) records.push(record);
    if (records.length > MAX_PAGE_COUNT)
      throw new FixedDocumentImportError('이미지 페이지 수가 지원 한도를 초과했습니다.', 'too_many_pages');
  }
  if (records.length === 0)
    throw new FixedDocumentImportError('압축 파일 안에서 지원하는 이미지 페이지를 찾지 못했습니다.', 'no_pages');
  records.sort((left, right) => naturalCompare(left.fileName, right.fileName));
  const comicInfo = comicInfoRecord
    ? parseComicInfoXml(
        extractSevenZipEntry({ module, output, password: options.password, path: comicInfoRecord.fileName }),
      )
    : undefined;
  return {
    pages: records.map(({ fileName, contentType }) => ({ fileName, contentType })),
    comicInfo,
    async *consumePages() {
      try {
        for (const record of records) {
          options.signal?.throwIfAborted();
          const bytes = extractSevenZipEntry({
            module,
            output,
            password: options.password!,
            path: record.fileName,
          });
          if (bytes.byteLength !== record.size || !imageSignatureMatches(bytes, record.contentType))
            throw new FixedDocumentImportError(
              `${record.fileName}의 실제 이미지 형식이 확장자와 다릅니다.`,
              'invalid_archive',
            );
          yield {
            fileName: record.fileName,
            contentType: record.contentType,
            contentHash: integrityHash(bytes),
            bytes,
          };
        }
      } finally {
        clearSevenZipDirectory(module, '/noveldesk-output');
        try {
          module.FS.unlink('/noveldesk-input.7z');
        } catch {
          // A completed or cancelled stream may already have released the request-scoped source.
        }
      }
    },
  };
}

async function openLibarchiveImageArchiveStream(
  blob: Blob,
  options: ImageArchiveParseOptions,
): Promise<StreamingImageArchiveDocument> {
  options.signal?.throwIfAborted();
  const source = new Uint8Array(await blob.arrayBuffer());
  validateSevenZipHeaderBounds(source);
  options.signal?.throwIfAborted();
  const module = await (libarchiveModulePromise ??= loadLibarchiveModule());
  let reader: ArchiveReader | undefined;
  try {
    reader = new ArchiveReader(
      module,
      new Int8Array(source.buffer, source.byteOffset, source.byteLength),
      options.password,
    );
    const records: LibarchiveImageRecord[] = [];
    let comicInfo: ComicInfoMetadata | undefined;
    let entryCount = 0;
    let expandedBytes = 0;
    let encryptedArchive = false;
    const paths = new Set<string>();
    for (const entry of reader.entries()) {
      options.signal?.throwIfAborted();
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES)
        throw new FixedDocumentImportError('압축 파일 항목 수가 안전 한도를 초과했습니다.', 'too_many_pages');
      const rawPath = entry.getPathname();
      const path = normalizedArchivePath(rawPath);
      const key = path.toLocaleLowerCase();
      if (paths.has(key)) throw new FixedDocumentImportError('압축 파일에 중복 경로가 있습니다.', 'unsafe_archive');
      paths.add(key);
      const fileType = entry.getFiletype();
      if (fileType === 'Directory' || rawPath.endsWith('/')) continue;
      if (fileType !== 'File' && fileType !== 'Invalid') {
        continue;
      }
      if (entry.getSymlinkTarget() || entry.getHardlinkTarget()) {
        continue;
      }
      const contentType = imageContentType(path);
      const isComicInfo = key === 'comicinfo.xml';
      if (!contentType && !isComicInfo) {
        continue;
      }
      const size = entry.getSize();
      const entryLimit = isComicInfo ? MAX_COMIC_INFO_BYTES : MAX_PAGE_BYTES;
      if (!Number.isSafeInteger(size) || size < 0 || size > entryLimit) {
        throw new FixedDocumentImportError('압축 파일 항목 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
      }
      expandedBytes += size;
      if (expandedBytes > MAX_EXPANDED_BYTES)
        throw new FixedDocumentImportError('압축 해제 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
      const entryEncrypted = entry.isEncrypted();
      if (entryEncrypted && !options.password)
        throw new FixedDocumentImportError('암호가 필요한 압축 파일입니다.', 'password_required');
      encryptedArchive ||= entryEncrypted;
      if (isComicInfo) {
        if (entryEncrypted) continue;
        const data = entry.readData();
        const bytes = data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array();
        comicInfo = parseComicInfoXml(bytes);
        continue;
      }
      if (contentType) records.push({ key, fileName: path, contentType });
      if (records.length > MAX_PAGE_COUNT)
        throw new FixedDocumentImportError('이미지 페이지 수가 지원 한도를 초과했습니다.', 'too_many_pages');
    }
    const hasEncryptedData = reader.hasEncryptedData();
    if ((encryptedArchive || (records.length === 0 && hasEncryptedData)) && options.password) {
      return openEncryptedSevenZipImageArchiveStream(source, options);
    }
    if (records.length === 0 && hasEncryptedData) {
      throw new FixedDocumentImportError(
        options.password ? '압축 파일 암호가 올바르지 않습니다.' : '암호가 필요한 압축 파일입니다.',
        options.password ? 'wrong_password' : 'password_required',
      );
    }
    if (records.length === 0)
      throw new FixedDocumentImportError('압축 파일 안에서 지원하는 이미지 페이지를 찾지 못했습니다.', 'no_pages');
    records.sort((left, right) => naturalCompare(left.fileName, right.fileName));
    const pages = records.map<ImageArchivePageDescriptor>(({ fileName, contentType }) => ({ fileName, contentType }));
    return {
      pages,
      comicInfo,
      async *consumePages() {
        let streamReader: ArchiveReader | undefined;
        const expected = new Map(records.map((record) => [record.key, record]));
        const seen = new Set<string>();
        try {
          options.signal?.throwIfAborted();
          streamReader = new ArchiveReader(
            module,
            new Int8Array(source.buffer, source.byteOffset, source.byteLength),
            options.password,
          );
          for (const entry of streamReader.entries()) {
            options.signal?.throwIfAborted();
            const rawPath = entry.getPathname();
            const path = normalizedArchivePath(rawPath);
            const key = path.toLocaleLowerCase();
            const record = expected.get(key);
            if (!record) continue;
            if (seen.has(key))
              throw new FixedDocumentImportError('압축 파일에 중복 이미지 경로가 있습니다.', 'unsafe_archive');
            if (entry.isEncrypted() && !options.password)
              throw new FixedDocumentImportError('암호가 필요한 압축 파일입니다.', 'password_required');
            const size = entry.getSize();
            if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PAGE_BYTES)
              throw new FixedDocumentImportError('압축 파일 항목 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
            const data = entry.readData();
            const bytes = data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array();
            if (!imageSignatureMatches(bytes, record.contentType))
              throw new FixedDocumentImportError(
                `${record.fileName}의 실제 이미지 형식이 확장자와 다릅니다.`,
                'invalid_archive',
              );
            seen.add(key);
            yield {
              fileName: record.fileName,
              contentType: record.contentType,
              contentHash: integrityHash(bytes),
              bytes,
            };
          }
          if (seen.size !== records.length)
            throw new FixedDocumentImportError('압축 파일 페이지 저장이 중간에 끝났습니다.', 'invalid_archive');
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          throw mappedArchiveError(error, options.password);
        } finally {
          try {
            streamReader?.free();
          } catch {
            // The archive may already be in a terminal error state; release is best effort.
          }
        }
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw mappedArchiveError(error, options.password);
  } finally {
    try {
      reader?.free();
    } catch {
      // The archive may already be in a terminal error state; the WASM allocation is best-effort released.
    }
  }
}

let unrarWasmBinaryPromise: Promise<ArrayBuffer | undefined> | undefined;

async function loadUnrarWasmBinary(): Promise<ArrayBuffer | undefined> {
  if (typeof globalThis.location === 'undefined') return undefined;
  return (unrarWasmBinaryPromise ??= import('node-unrar-js/esm/js/unrar.wasm?url').then(async ({ default: url }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`UnRAR WASM을 불러오지 못했습니다 (${response.status}).`);
    return response.arrayBuffer();
  }));
}

function mappedUnrarError(error: unknown, password?: string): FixedDocumentImportError {
  if (error instanceof FixedDocumentImportError) return error;
  if (error instanceof UnrarError) {
    if (error.reason === 'ERAR_MISSING_PASSWORD')
      return new FixedDocumentImportError('암호가 필요한 RAR 파일입니다.', 'password_required');
    if (error.reason === 'ERAR_BAD_PASSWORD')
      return new FixedDocumentImportError('RAR 암호가 올바르지 않습니다.', 'wrong_password');
    if (error.reason === 'ERAR_BAD_DATA' && password)
      return new FixedDocumentImportError('RAR 암호가 올바르지 않거나 파일이 손상되었습니다.', 'wrong_password');
    if (error.reason === 'ERAR_UNKNOWN_FORMAT')
      return new FixedDocumentImportError('지원하지 않는 RAR 형식입니다.', 'unsupported_archive');
  }
  return mappedArchiveError(error, password);
}

interface RarImageRecord extends ImageArchivePageDescriptor {
  readonly archiveName: string;
  readonly key: string;
}

interface ReleasableUnrarExtractor {
  _archive?: unknown;
  closeArc?: () => void;
  dataFiles?: Record<string, unknown>;
  dataFileMap?: Record<string, string>;
}

function releaseUnrarExtractedFile(extractor: unknown, archiveName: string): void {
  const internals = extractor as ReleasableUnrarExtractor;
  const extractedName = `*Extracted*/${archiveName}`;
  delete internals.dataFiles?.[extractedName];
  if (!internals.dataFileMap) return;
  for (const [descriptor, fileName] of Object.entries(internals.dataFileMap)) {
    if (fileName === extractedName) delete internals.dataFileMap[descriptor];
  }
}

function closeUnrarExtractor(extractor: unknown): void {
  const internals = extractor as ReleasableUnrarExtractor;
  if (internals._archive && typeof internals.closeArc === 'function') internals.closeArc();
}

async function openRarImageArchiveStream(
  blob: Blob,
  options: ImageArchiveParseOptions,
): Promise<StreamingImageArchiveDocument> {
  options.signal?.throwIfAborted();
  const source = await blob.arrayBuffer();
  let manifestExtractor: Awaited<ReturnType<typeof createExtractorFromData>> | undefined;
  try {
    const extractor = (manifestExtractor = await createExtractorFromData({
      data: source,
      password: options.password,
      wasmBinary: await loadUnrarWasmBinary(),
    }));
    const listed = extractor.getFileList();
    if (listed.arcHeader.flags.volume)
      throw new FixedDocumentImportError('분할 RAR은 현재 지원하지 않습니다.', 'unsupported_archive');
    const records: RarImageRecord[] = [];
    let comicInfoArchiveName: string | undefined;
    const paths = new Set<string>();
    let entryCount = 0;
    let expandedBytes = 0;
    for (const header of listed.fileHeaders) {
      options.signal?.throwIfAborted();
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES)
        throw new FixedDocumentImportError('RAR 항목 수가 안전 한도를 초과했습니다.', 'too_many_pages');
      if (header.flags.directory) continue;
      const path = normalizedArchivePath(header.name);
      const key = path.toLocaleLowerCase();
      if (paths.has(key)) throw new FixedDocumentImportError('RAR에 중복 경로가 있습니다.', 'unsafe_archive');
      paths.add(key);
      const contentType = imageContentType(path);
      const comicInfo = key === 'comicinfo.xml';
      if (!contentType && !comicInfo) continue;
      if (header.flags.encrypted && !options.password)
        throw new FixedDocumentImportError('암호가 필요한 RAR 파일입니다.', 'password_required');
      const entryLimit = comicInfo ? MAX_COMIC_INFO_BYTES : MAX_PAGE_BYTES;
      if (!Number.isSafeInteger(header.unpSize) || header.unpSize < 0 || header.unpSize > entryLimit)
        throw new FixedDocumentImportError('RAR 항목 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
      if (header.unpSize > Math.max(1, header.packSize) * MAX_COMPRESSION_RATIO)
        throw new FixedDocumentImportError('RAR 압축 비율이 안전 한도를 초과했습니다.', 'unsafe_archive');
      expandedBytes += header.unpSize;
      if (expandedBytes > MAX_EXPANDED_BYTES)
        throw new FixedDocumentImportError('RAR 해제 크기가 안전 한도를 초과했습니다.', 'unsafe_archive');
      if (comicInfo) comicInfoArchiveName = header.name;
      if (contentType) {
        records.push({ archiveName: header.name, key, fileName: path, contentType });
        if (records.length > MAX_PAGE_COUNT)
          throw new FixedDocumentImportError('RAR 이미지 페이지 수가 지원 한도를 초과했습니다.', 'too_many_pages');
      }
    }
    let comicInfo: ComicInfoMetadata | undefined;
    if (comicInfoArchiveName) {
      const extracted = extractor.extract({ files: [comicInfoArchiveName] });
      for (const file of extracted.files) {
        options.signal?.throwIfAborted();
        const bytes = file.extraction;
        if (!bytes) throw new FixedDocumentImportError('RAR의 ComicInfo.xml을 해제하지 못했습니다.', 'invalid_archive');
        comicInfo = parseComicInfoXml(bytes);
        releaseUnrarExtractedFile(extractor, file.fileHeader.name);
      }
    }
    if (records.length === 0)
      throw new FixedDocumentImportError('RAR 안에서 지원하는 이미지 페이지를 찾지 못했습니다.', 'no_pages');
    records.sort((left, right) => naturalCompare(left.fileName, right.fileName));
    const pages = records.map<ImageArchivePageDescriptor>(({ fileName, contentType }) => ({ fileName, contentType }));
    return {
      pages,
      comicInfo,
      async *consumePages() {
        let streamExtractor: Awaited<ReturnType<typeof createExtractorFromData>> | undefined;
        try {
          streamExtractor = await createExtractorFromData({
            data: source,
            password: options.password,
            wasmBinary: await loadUnrarWasmBinary(),
          });
          const expected = new Map(records.map((record) => [record.archiveName, record]));
          const seen = new Set<string>();
          const extracted = streamExtractor.extract({ files: (header: FileHeader) => expected.has(header.name) });
          for (const file of extracted.files) {
            options.signal?.throwIfAborted();
            const record = expected.get(file.fileHeader.name);
            if (!record) continue;
            if (seen.has(record.key))
              throw new FixedDocumentImportError('RAR에 중복 이미지 경로가 있습니다.', 'unsafe_archive');
            const bytes = file.extraction;
            if (!bytes)
              throw new FixedDocumentImportError(`${record.fileName}을(를) 해제하지 못했습니다.`, 'invalid_archive');
            if (!imageSignatureMatches(bytes, record.contentType))
              throw new FixedDocumentImportError(
                `${record.fileName}의 실제 이미지 형식이 확장자와 다릅니다.`,
                'invalid_archive',
              );
            seen.add(record.key);
            try {
              yield {
                fileName: record.fileName,
                contentType: record.contentType,
                contentHash: integrityHash(bytes),
                bytes,
              };
            } finally {
              releaseUnrarExtractedFile(streamExtractor, file.fileHeader.name);
            }
          }
          if (seen.size !== records.length)
            throw new FixedDocumentImportError('RAR 페이지 저장이 중간에 끝났습니다.', 'invalid_archive');
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          throw mappedUnrarError(error, options.password);
        } finally {
          closeUnrarExtractor(streamExtractor);
        }
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw mappedUnrarError(error, options.password);
  } finally {
    closeUnrarExtractor(manifestExtractor);
  }
}

export async function parseImageArchive(
  blob: Blob,
  options: ImageArchiveParseOptions = {},
): Promise<ImageArchiveDocument> {
  const stream = await openImageArchiveStream(blob, options);
  const streamedPages = new Map<string, ImageArchivePage>();
  for await (const page of stream.consumePages()) streamedPages.set(page.fileName, page);
  const pages = stream.pages.map((descriptor) => {
    const page = streamedPages.get(descriptor.fileName);
    if (!page) throw new FixedDocumentImportError('압축 파일 페이지 저장이 중간에 끝났습니다.', 'invalid_archive');
    return page;
  });
  return { pages, comicInfo: stream.comicInfo, moyaSeries: stream.moyaSeries };
}

export async function openImageArchiveStream(
  blob: Blob,
  options: ImageArchiveParseOptions = {},
): Promise<StreamingImageArchiveDocument> {
  const format = detectImageArchiveFormat(new Uint8Array(await blob.slice(0, 8).arrayBuffer()));
  if (!format) throw new FixedDocumentImportError('ZIP, RAR4/5 또는 7z 압축 파일이 아닙니다.', 'unsupported_archive');
  if (format === 'zip') return openZipImageArchiveStream(blob, options);
  if (format === 'rar4' || format === 'rar5') return openRarImageArchiveStream(blob, options);
  return openLibarchiveImageArchiveStream(blob, options);
}

export async function inspectPdf(
  bytes: Uint8Array,
  options: { readonly workerSrc?: string } = {},
): Promise<{ pageCount: number; title?: string; author?: string }> {
  let dedicatedWorker: PDFWorker | undefined;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    dedicatedWorker = options.workerSrc
      ? new pdfjs.PDFWorker({ port: new Worker(options.workerSrc, { type: 'module' }) as never })
      : undefined;
    const loadingTask = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, worker: dedicatedWorker });
    const document = await loadingTask.promise;
    const metadata = await document.getMetadata().catch(() => undefined);
    const info = metadata?.info as { Title?: unknown; Author?: unknown } | undefined;
    const pageCount = document.numPages;
    await document.destroy();
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new FixedDocumentImportError('PDF에 표시할 페이지가 없습니다.', 'no_pages');
    }
    if (pageCount > MAX_PAGE_COUNT) {
      throw new FixedDocumentImportError('PDF 페이지 수가 지원 한도를 초과했습니다.', 'too_many_pages');
    }
    return {
      pageCount,
      title: typeof info?.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined,
      author: typeof info?.Author === 'string' && info.Author.trim() ? info.Author.trim() : undefined,
    };
  } catch (error) {
    if (error instanceof FixedDocumentImportError) throw error;
    throw new FixedDocumentImportError(
      error instanceof Error ? `PDF를 읽을 수 없습니다: ${error.message}` : 'PDF를 읽을 수 없습니다.',
      'invalid_pdf',
    );
  } finally {
    dedicatedWorker?.destroy();
  }
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.(pdf|zip|cbz|rar|cbr|7z|cb7)$/i, '').trim() || '제목 없음';
}

interface MoyaSeriesPageLocation {
  readonly section: MoyaSeriesManifestChapter;
  readonly sectionIndex: number;
  readonly pageIndexInSection: number;
}

function moyaSeriesPageLocations(
  manifest: MoyaSeriesManifest | undefined,
  pages: readonly { readonly fileName: string }[] | undefined,
): ReadonlyMap<number, MoyaSeriesPageLocation> {
  if (!manifest || !pages) return new Map();
  const indexByName = new Map(pages.map((page, index) => [page.fileName, index] as const));
  const locations = new Map<number, MoyaSeriesPageLocation>();
  manifest.chapters.forEach((section, sectionIndex) => {
    section.entryNames.forEach((entryName, pageIndexInSection) => {
      const pageIndex = indexByName.get(entryName);
      if (pageIndex === undefined || locations.has(pageIndex)) {
        throw new FixedDocumentImportError(
          'Moya 연재 작품의 회차 페이지 목록이 압축 파일과 다릅니다.',
          'invalid_archive',
        );
      }
      locations.set(pageIndex, { section, sectionIndex, pageIndexInSection });
    });
  });
  if (locations.size !== pages.length) {
    throw new FixedDocumentImportError('Moya 연재 작품에 회차가 지정되지 않은 페이지가 있습니다.', 'invalid_archive');
  }
  return locations;
}

export function imageArchiveContentType(fileName: string): string {
  if (/\.(?:rar|cbr)$/i.test(fileName)) return 'application/vnd.comicbook-rar';
  if (/\.(?:7z|cb7)$/i.test(fileName)) return 'application/x-7z-compressed';
  return 'application/vnd.comicbook+zip';
}

export function materializeFixedImport(input: {
  format: Extract<BookFormat, 'pdf' | 'image_archive'>;
  fileName: string;
  sourceBytes?: Uint8Array;
  sourceContentHash?: string;
  pageCount: number;
  title?: string;
  author?: string;
  pages?: readonly ImageArchivePage[];
  pageDescriptors?: readonly ImageArchivePageDescriptor[];
  pageAssetIds?: readonly string[];
  consumeEmbeddedAssets?: () => AsyncIterable<ParsedNovelImportAsset>;
  comicInfo?: ComicInfoMetadata;
  moyaSeries?: MoyaSeriesManifest;
  clientBookId?: string;
  now?: string;
}): ParsedNovelImport {
  const sourceHash = input.sourceContentHash ?? integrityHash(input.sourceBytes ?? new Uint8Array());
  const normalizedTextHash = integrityHash(`${input.format}:${input.pageCount}:${sourceHash}`);
  const bookId = input.clientBookId?.trim() || parsedNovelId(input.fileName, normalizedTextHash);
  const now = input.now ?? new Date().toISOString();
  const pageAssetIds =
    input.pageAssetIds ??
    input.pages?.map((page, index) =>
      persistentId128('document_page', [bookId, String(index + 1), page.fileName, page.contentHash]),
    );
  const chapters: Chapter[] = [];
  const rows: ParsedNovelImportChapter[] = [];
  const seriesLocations = moyaSeriesPageLocations(input.moyaSeries, input.pages ?? input.pageDescriptors);
  for (let index = 0; index < input.pageCount; index += 1) {
    const location = seriesLocations.get(index);
    const title = location
      ? `${location.section.title} · ${location.pageIndexInSection + 1}페이지`
      : `${index + 1}페이지`;
    const chapterId = location
      ? persistentId128('fixed_document_series_page', [
          bookId,
          location.section.remoteId,
          String(location.pageIndexInSection + 1),
        ])
      : parsedChapterId(bookId, index + 1, title);
    const paragraphId = location
      ? persistentId128('fixed_document_series_paragraph', [chapterId])
      : parsedParagraphId(bookId, chapterId, 1, title);
    const paragraph: Paragraph = {
      id: paragraphId,
      novelId: bookId,
      chapterId,
      index: 1,
      text: title,
      startOffsetInChapter: 0,
      endOffsetInChapter: title.length,
      textHash: integrityHash(title),
      documentKind: input.format === 'image_archive' ? 'image' : 'paragraph',
      assetId: pageAssetIds?.[index],
      sourceHref: input.pages?.[index]?.fileName ?? input.pageDescriptors?.[index]?.fileName ?? `page:${index + 1}`,
      documentPageType: input.comicInfo?.pages.find((page) => page.image === index)?.type,
      documentPageDouble: input.comicInfo?.pages.find((page) => page.image === index)?.doublePage,
    };
    const chapter: Chapter = {
      id: chapterId,
      novelId: bookId,
      index: index + 1,
      title,
      normalizedText: title,
      textHash: integrityHash(title),
      rawStartOffset: index,
      rawEndOffset: index + 1,
      characterCount: title.length,
      paragraphCount: 1,
      documentSectionId: location?.section.remoteId,
      documentSectionTitle: location?.section.title,
      documentSectionIndex: location ? location.sectionIndex + 1 : undefined,
      documentPageIndexInSection: location ? location.pageIndexInSection + 1 : undefined,
      documentSectionSourceContentHash: location?.section.sourceContentHash,
      documentSectionRemoteRevision: location?.section.remoteRevision,
      createdAt: now,
      updatedAt: now,
    };
    chapters.push(chapter);
    rows.push({ chapter, paragraphs: [paragraph] });
  }
  const pageAssets: ParsedNovelImportAsset[] = (input.pages ?? []).map((page, index) => ({
    id: pageAssetIds![index],
    bookId,
    kind: 'document_page',
    provenance: 'archive_embedded',
    fileName: page.fileName,
    contentType: page.contentType,
    contentHash: page.contentHash,
    pageIndex: index,
    bytes: page.bytes,
  }));
  const coverIndex = input.comicInfo?.pages.find((page) => page.type?.toLocaleLowerCase() === 'frontcover')?.image;
  const firstCover =
    (coverIndex !== undefined ? input.pages?.[coverIndex] : undefined) ??
    input.pages?.find((page) => page.contentType !== 'image/gif');
  if (firstCover) {
    pageAssets.push({
      id: persistentId128('document_cover', [bookId, firstCover.contentHash]),
      bookId,
      kind: 'cover',
      provenance: 'archive_embedded',
      fileName: firstCover.fileName,
      contentType: firstCover.contentType,
      contentHash: firstCover.contentHash,
      bytes: firstCover.bytes,
    });
  }
  let consumed = false;
  const title = input.comicInfo?.title?.trim() || input.title?.trim() || titleFromFileName(input.fileName);
  return {
    novel: {
      id: bookId,
      format: input.format,
      title,
      author: input.comicInfo?.writer || input.author,
      seriesTitle: input.comicInfo?.series,
      seriesIndex: input.comicInfo?.number,
      tags: input.comicInfo?.tags.length ? [...input.comicInfo.tags] : undefined,
      description: input.comicInfo?.summary,
      language: input.comicInfo?.language,
      readingDirection: input.comicInfo?.readingDirection,
      sourceFileName: input.fileName,
      sourceContentType: input.format === 'pdf' ? 'application/pdf' : imageArchiveContentType(input.fileName),
      sourceContentHash: sourceHash,
      rawText: '',
      normalizedText: '',
      rawTextHash: sourceHash,
      normalizedTextHash,
      createdAt: now,
      updatedAt: now,
      totalChapters: input.pageCount,
      documentSectionCount: input.moyaSeries?.chapters.length,
      totalCharacters: chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0),
      totalParagraphs: input.pageCount,
      coverSeed: Number.parseInt(normalizedTextHash.slice(-8), 16) || 0,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
      metadataRevision: 0,
    },
    chapters,
    embeddedAssets: pageAssets,
    consumeChapterParagraphs() {
      if (consumed) return [];
      consumed = true;
      return rows;
    },
    consumeEmbeddedAssets: input.consumeEmbeddedAssets,
  };
}

export async function materializePdfImport(input: {
  readonly fileName: string;
  readonly sourceBytes: Uint8Array;
  readonly clientBookId?: string;
  readonly now?: string;
  readonly workerSrc?: string;
}): Promise<ParsedNovelImport> {
  const inspected = await inspectPdf(input.sourceBytes.slice(), { workerSrc: input.workerSrc });
  return materializeFixedImport({ format: 'pdf', ...input, ...inspected });
}

export function materializeImageArchiveImport(input: {
  readonly fileName: string;
  readonly sourceBytes: Uint8Array;
  readonly document: ImageArchiveDocument;
  readonly clientBookId?: string;
  readonly now?: string;
}): ParsedNovelImport {
  return materializeFixedImport({
    format: 'image_archive',
    ...input,
    pageCount: input.document.pages.length,
    pages: input.document.pages,
    comicInfo: input.document.comicInfo,
    moyaSeries: input.document.moyaSeries,
  });
}

export function materializeStreamingImageArchiveImport(input: {
  readonly fileName: string;
  readonly sourceContentHash: string;
  readonly document: StreamingImageArchiveDocument;
  readonly clientBookId?: string;
  readonly now?: string;
}): ParsedNovelImport {
  const normalizedTextHash = integrityHash(`image_archive:${input.document.pages.length}:${input.sourceContentHash}`);
  const bookId = input.clientBookId?.trim() || parsedNovelId(input.fileName, normalizedTextHash);
  const pageAssetIds = input.document.pages.map((page, index) =>
    persistentId128('document_page', [bookId, input.sourceContentHash, String(index + 1), page.fileName]),
  );
  const comicCoverIndex = input.document.comicInfo?.pages.find(
    (page) => page.type?.toLocaleLowerCase() === 'frontcover',
  )?.image;
  const coverIndex =
    comicCoverIndex !== undefined && comicCoverIndex >= 0 && comicCoverIndex < input.document.pages.length
      ? comicCoverIndex
      : input.document.pages.findIndex((page) => page.contentType !== 'image/gif');
  const pageIndexByKey = new Map(
    input.document.pages.map((page, index) => [page.fileName.toLocaleLowerCase(), index] as const),
  );
  let assetsConsumed = false;

  return materializeFixedImport({
    format: 'image_archive',
    fileName: input.fileName,
    sourceContentHash: input.sourceContentHash,
    pageCount: input.document.pages.length,
    pageDescriptors: input.document.pages,
    pageAssetIds,
    comicInfo: input.document.comicInfo,
    moyaSeries: input.document.moyaSeries,
    clientBookId: bookId,
    now: input.now,
    async *consumeEmbeddedAssets() {
      if (assetsConsumed) return;
      assetsConsumed = true;
      const seenPageIndexes = new Set<number>();
      for await (const page of input.document.consumePages()) {
        const index = pageIndexByKey.get(page.fileName.toLocaleLowerCase());
        if (index === undefined || seenPageIndexes.has(index))
          throw new FixedDocumentImportError(
            '이미지 압축 파일의 페이지 목록이 검사 결과와 다릅니다.',
            'invalid_archive',
          );
        const descriptor = input.document.pages[index]!;
        if (descriptor.contentType !== page.contentType)
          throw new FixedDocumentImportError(
            '이미지 압축 파일의 페이지 형식이 검사 결과와 다릅니다.',
            'invalid_archive',
          );
        seenPageIndexes.add(index);
        const pageAsset: ParsedNovelImportAsset = {
          id: pageAssetIds[index]!,
          bookId,
          kind: 'document_page',
          provenance: 'archive_embedded',
          fileName: page.fileName,
          contentType: page.contentType,
          contentHash: page.contentHash,
          pageIndex: index,
          bytes: page.bytes,
        };
        yield pageAsset;
        if (index === coverIndex) {
          yield {
            ...pageAsset,
            id: persistentId128('document_cover', [bookId, page.contentHash]),
            kind: 'cover',
            pageIndex: undefined,
          };
        }
      }
      if (seenPageIndexes.size !== pageAssetIds.length) {
        throw new FixedDocumentImportError('이미지 압축 파일 페이지 저장이 중간에 끝났습니다.', 'invalid_archive');
      }
    },
  });
}

export const materializeStreamingZipImageArchiveImport = materializeStreamingImageArchiveImport;
