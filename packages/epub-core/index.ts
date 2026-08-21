import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode,
} from '@xmldom/xmldom';
import { BlobReader, Uint8ArrayWriter, ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js';
import type {
  ReaderDocumentBlockKind,
  ReaderDocumentInlineMark,
  ReaderDocumentInlineSemantic,
} from '@noveldesk/contracts';
import type {
  Chapter,
  Paragraph,
  ParsedNovelImport,
  ParsedNovelImportAsset,
  ParsedNovelImportChapter,
} from '@noveldesk/contracts';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { parsedChapterId, parsedNovelId, parsedParagraphId } from '@noveldesk/text-core/identity/parser';

const MAX_ENTRY_COUNT = 4_000;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;

const EPUB_TEXT_TYPES = new Set(['application/xhtml+xml', 'text/html']);
const EPUB_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const POSITIVE_SIGNED_INTEGER_MODULUS = 0x80000000;

/**
 * Produces a deterministic visual seed that also fits persistence layers using
 * a signed 32-bit integer (notably PostgreSQL `integer`).
 */
export function stableEpubCoverSeed(normalizedTextHash: string): number {
  const hashSuffix = Number.parseInt(normalizedTextHash.slice(-8), 16);
  return Number.isFinite(hashSuffix) ? hashSuffix % POSITIVE_SIGNED_INTEGER_MODULUS : 0;
}

export class EpubImportError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_archive' | 'encrypted_or_drm' | 'fixed_layout' | 'invalid_package' | 'unsafe_resource',
  ) {
    super(message);
    this.name = 'EpubImportError';
  }
}

export interface EpubResource {
  readonly href: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

export interface EpubBlock {
  readonly kind: ReaderDocumentBlockKind;
  readonly plainText: string;
  readonly inlineMarks?: readonly ReaderDocumentInlineMark[];
  readonly inlineSemantics?: readonly ReaderDocumentInlineSemantic[];
  readonly resourceHref?: string;
  readonly sourceLocator: string;
  readonly fragmentId?: string;
  readonly semanticRole?: 'footnote' | 'endnote';
}

export interface EpubSection {
  readonly href: string;
  readonly title: string;
  readonly blocks: readonly EpubBlock[];
}

export interface EpubDocument {
  readonly title: string;
  readonly author?: string;
  readonly language?: string;
  readonly description?: string;
  readonly coverHref?: string;
  readonly sections: readonly EpubSection[];
  readonly resources: readonly EpubResource[];
}

interface ManifestItem {
  readonly id: string;
  readonly href: string;
  readonly mediaType: string;
  readonly properties: Set<string>;
}

interface ArchiveEntry {
  readonly entry: FileEntry;
  readonly path: string;
}

function localName(node: XmlNode): string {
  return (node.localName || node.nodeName.split(':').at(-1) || '').toLowerCase();
}

function elementChildren(node: XmlNode): XmlElement[] {
  const children: XmlElement[] = [];
  for (let current = node.firstChild; current; current = current.nextSibling) {
    if (current.nodeType === 1) children.push(current as XmlElement);
  }
  return children;
}

function firstDescendant(node: XmlNode, name: string): XmlElement | undefined {
  const wanted = name.toLowerCase();
  const queue = elementChildren(node);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (localName(current) === wanted) return current;
    queue.push(...elementChildren(current));
  }
  return undefined;
}

function descendants(node: XmlNode, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  const result: XmlElement[] = [];
  const queue = elementChildren(node);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (localName(current) === wanted) result.push(current);
    queue.push(...elementChildren(current));
  }
  return result;
}

function text(node: XmlNode | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function parseXml(source: string, label: string): XmlDocument {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') errors.push(message);
    },
  }).parseFromString(source, 'application/xml');
  if (!document?.documentElement || errors.length > 0 || localName(document.documentElement) === 'parsererror') {
    throw new EpubImportError(`${label} XML이 손상되었습니다.`, 'invalid_package');
  }
  return document;
}

function normalizedArchivePath(value: string, base = ''): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.split('#', 1)[0]);
  } catch {
    throw new EpubImportError('EPUB 경로 인코딩이 올바르지 않습니다.', 'unsafe_resource');
  }
  const clean = decoded.replace(/\\/g, '/').trim();
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) {
    throw new EpubImportError('EPUB에 허용되지 않는 절대 또는 외부 경로가 있습니다.', 'unsafe_resource');
  }
  const baseParts = base ? base.split('/').slice(0, -1) : [];
  const parts = [...baseParts, ...clean.split('/')];
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (output.length === 0) throw new EpubImportError('EPUB 경로가 archive 밖을 가리킵니다.', 'unsafe_resource');
      output.pop();
      continue;
    }
    output.push(part);
  }
  if (output.length === 0) throw new EpubImportError('EPUB 경로가 비어 있습니다.', 'unsafe_resource');
  return output.join('/');
}

function resolvedHref(base: string, href: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('#')) return `${base.split('#', 1)[0]}${trimmed}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return undefined;
  const [path, fragment] = trimmed.split('#', 2);
  const resolved = normalizedArchivePath(path, base);
  return fragment ? `${resolved}#${fragment}` : resolved;
}

function resolvedLinkHref(base: string, href: string): string | undefined {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return resolvedHref(base, trimmed);
}

function archiveEntries(entries: readonly Entry[]): Map<string, ArchiveEntry> {
  if (entries.length > MAX_ENTRY_COUNT) {
    throw new EpubImportError('EPUB archive 항목 수가 안전 한도를 초과했습니다.', 'invalid_archive');
  }
  const result = new Map<string, ArchiveEntry>();
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    const path = normalizedArchivePath(entry.filename);
    const size = Number(entry.uncompressedSize ?? 0);
    const compressed = Math.max(1, Number(entry.compressedSize ?? size));
    if (entry.encrypted)
      throw new EpubImportError('암호화되거나 DRM이 적용된 EPUB은 읽을 수 없습니다.', 'encrypted_or_drm');
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
      throw new EpubImportError('EPUB archive 항목 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
    }
    if (size > compressed * MAX_COMPRESSION_RATIO) {
      throw new EpubImportError('EPUB 압축 비율이 안전 한도를 초과했습니다.', 'invalid_archive');
    }
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new EpubImportError('EPUB 해제 크기가 안전 한도를 초과했습니다.', 'invalid_archive');
    }
    const key = path.toLowerCase();
    if (result.has(key)) throw new EpubImportError('EPUB에 중복 archive 경로가 있습니다.', 'invalid_archive');
    result.set(key, { entry: entry as FileEntry, path });
  }
  return result;
}

async function entryBytes(record: ArchiveEntry): Promise<Uint8Array> {
  if (!record.entry.getData) throw new EpubImportError('EPUB archive 항목을 읽을 수 없습니다.', 'invalid_archive');
  return record.entry.getData(new Uint8ArrayWriter());
}

async function entryText(record: ArchiveEntry): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await entryBytes(record));
}

function findEntry(entries: Map<string, ArchiveEntry>, path: string): ArchiveEntry {
  const found = entries.get(path.toLowerCase());
  if (!found) throw new EpubImportError(`EPUB 필수 항목을 찾을 수 없습니다: ${path}`, 'invalid_package');
  return found;
}

function packageMetadata(opf: XmlDocument): {
  title: string;
  author?: string;
  language?: string;
  description?: string;
} {
  const metadata = firstDescendant(opf, 'metadata');
  const value = (name: string) => text(metadata ? firstDescendant(metadata, name) : undefined) || undefined;
  return {
    title: value('title') ?? '제목 없는 EPUB',
    author: value('creator'),
    language: value('language'),
    description: value('description'),
  };
}

function packageManifest(opf: XmlDocument, opfPath: string): Map<string, ManifestItem> {
  const manifest = firstDescendant(opf, 'manifest');
  if (!manifest) throw new EpubImportError('EPUB manifest가 없습니다.', 'invalid_package');
  const result = new Map<string, ManifestItem>();
  for (const item of elementChildren(manifest)) {
    if (localName(item) !== 'item') continue;
    const id = item.getAttribute('id')?.trim();
    const href = item.getAttribute('href')?.trim();
    const mediaType = item.getAttribute('media-type')?.trim().toLowerCase();
    if (!id || !href || !mediaType) continue;
    result.set(id, {
      id,
      href: normalizedArchivePath(href, opfPath),
      mediaType,
      properties: new Set((item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean)),
    });
  }
  return result;
}

function packageSpine(opf: XmlDocument, manifest: Map<string, ManifestItem>): ManifestItem[] {
  const spine = firstDescendant(opf, 'spine');
  if (!spine) throw new EpubImportError('EPUB spine이 없습니다.', 'invalid_package');
  const result: ManifestItem[] = [];
  for (const itemref of elementChildren(spine)) {
    if (localName(itemref) !== 'itemref' || itemref.getAttribute('linear') === 'no') continue;
    const item = manifest.get(itemref.getAttribute('idref') ?? '');
    if (item && EPUB_TEXT_TYPES.has(item.mediaType)) result.push(item);
  }
  if (result.length === 0) throw new EpubImportError('EPUB에 읽을 수 있는 spine 본문이 없습니다.', 'invalid_package');
  return result;
}

async function navigationTitles(
  entries: Map<string, ArchiveEntry>,
  opf: XmlDocument,
  manifest: Map<string, ManifestItem>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const navItem = [...manifest.values()].find((item) => item.properties.has('nav'));
  if (navItem) {
    const navigation = parseXml(await entryText(findEntry(entries, navItem.href)), navItem.href);
    for (const anchor of descendants(navigation, 'a')) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      const resolved = resolvedHref(navItem.href, href)?.split('#', 1)[0];
      const label = text(anchor);
      if (resolved && label && !titles.has(resolved)) titles.set(resolved, label);
    }
  }
  const spine = firstDescendant(opf, 'spine');
  const ncxId = spine?.getAttribute('toc') ?? '';
  const ncxItem =
    manifest.get(ncxId) ?? [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncx = parseXml(await entryText(findEntry(entries, ncxItem.href)), ncxItem.href);
    for (const point of descendants(ncx, 'navpoint')) {
      const content = firstDescendant(point, 'content');
      const source = content?.getAttribute('src');
      const label = text(firstDescendant(firstDescendant(point, 'navlabel') ?? point, 'text'));
      if (!source || !label) continue;
      const resolved = resolvedHref(ncxItem.href, source)?.split('#', 1)[0];
      if (resolved && !titles.has(resolved)) titles.set(resolved, label);
    }
  }
  return titles;
}

function assertReflowable(opf: XmlDocument): void {
  for (const meta of descendants(opf, 'meta')) {
    const property = meta.getAttribute('property')?.trim().toLowerCase();
    const name = meta.getAttribute('name')?.trim().toLowerCase();
    const value = (meta.getAttribute('content') ?? text(meta)).trim().toLowerCase();
    if (
      (property === 'rendition:layout' || name === 'fixed-layout') &&
      (value === 'pre-paginated' || value === 'true')
    ) {
      throw new EpubImportError('고정 레이아웃 EPUB은 현재 읽을 수 없습니다.', 'fixed_layout');
    }
  }
}

function appendInline(
  node: XmlNode,
  hrefBase: string,
  output: { text: string; marks: ReaderDocumentInlineMark[]; semantics: ReaderDocumentInlineSemantic[] },
): void {
  if (node.nodeType === 3 || node.nodeType === 4) {
    output.text += node.nodeValue ?? '';
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as XmlElement;
  const name = localName(element);
  if (
    name === 'script' ||
    name === 'style' ||
    name === 'form' ||
    name === 'iframe' ||
    name === 'audio' ||
    name === 'video'
  )
    return;
  if (name === 'br') {
    output.text += '\n';
    return;
  }
  const start = output.text.length;
  if (name === 'ruby') {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const childName = localName(child);
      if (childName === 'rt' || childName === 'rp') continue;
      appendInline(child, hrefBase, output);
    }
  } else {
    for (let child = node.firstChild; child; child = child.nextSibling) appendInline(child, hrefBase, output);
  }
  const end = output.text.length;
  if (end <= start) return;
  if (name === 'ruby') {
    const reading = descendants(element, 'rt')
      .map((item) => text(item))
      .filter(Boolean)
      .join(' ');
    if (reading) output.semantics.push({ start, end, kind: 'ruby', value: reading });
  }
  const language = element.getAttribute('xml:lang')?.trim() || element.getAttribute('lang')?.trim();
  if (language) output.semantics.push({ start, end, kind: 'language', value: language });
  if (name === 'em' || name === 'i') output.marks.push({ start, end, kind: 'emphasis' });
  if (name === 'strong' || name === 'b') output.marks.push({ start, end, kind: 'strong' });
  if (name === 'a') {
    const href = resolvedLinkHref(hrefBase, element.getAttribute('href') ?? '');
    if (href) output.marks.push({ start, end, kind: 'link', href });
    const epubType = (element.getAttribute('epub:type') ?? element.getAttribute('type') ?? '').toLowerCase();
    const role = (element.getAttribute('role') ?? '').toLowerCase();
    if (href && (epubType.split(/\s+/).includes('noteref') || role === 'doc-noteref')) {
      output.semantics.push({ start, end, kind: 'footnote_reference', relatedBlockId: href });
    }
  }
}

function normalizedInline(
  element: XmlElement,
  hrefBase: string,
): {
  plainText: string;
  marks?: ReaderDocumentInlineMark[];
  semantics?: ReaderDocumentInlineSemantic[];
} {
  const output = {
    text: '',
    marks: [] as ReaderDocumentInlineMark[],
    semantics: [] as ReaderDocumentInlineSemantic[],
  };
  appendInline(element, hrefBase, output);
  const leading = output.text.length - output.text.trimStart().length;
  const plainText = output.text
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
  const marks = output.marks
    .map((mark) => ({
      ...mark,
      start: Math.max(0, mark.start - leading),
      end: Math.min(plainText.length, mark.end - leading),
    }))
    .filter((mark) => mark.end > mark.start);
  const semantics = output.semantics
    .map((semantic) => ({
      ...semantic,
      start: Math.max(0, semantic.start - leading),
      end: Math.min(plainText.length, semantic.end - leading),
    }))
    .filter((semantic) => semantic.end > semantic.start);
  return {
    plainText,
    marks: marks.length ? marks : undefined,
    semantics: semantics.length ? semantics : undefined,
  };
}

function sectionBlocks(document: XmlDocument, href: string, spineIndex: number): EpubBlock[] {
  const body = firstDescendant(document, 'body') ?? document.documentElement;
  if (!body) return [];
  const result: EpubBlock[] = [];
  const fragmentId = (element: XmlElement): string | undefined => {
    let current: XmlNode | null = element;
    while (current?.nodeType === 1) {
      const value = (current as XmlElement).getAttribute('id')?.trim();
      if (value) return value;
      current = current.parentNode;
    }
    return undefined;
  };
  const addTextBlock = (element: XmlElement, kind: ReaderDocumentBlockKind) => {
    const normalized = normalizedInline(element, href);
    if (!normalized.plainText && kind !== 'separator') return;
    result.push({
      kind,
      plainText: normalized.plainText,
      inlineMarks: normalized.marks,
      inlineSemantics: normalized.semantics,
      sourceLocator: `epubcfi(/6/${(spineIndex + 1) * 2}!/4/${(result.length + 1) * 2})`,
      fragmentId: fragmentId(element),
      semanticRole: semanticRole(element),
    });
  };
  const semanticRole = (element: XmlElement): EpubBlock['semanticRole'] => {
    let current: XmlNode | null = element;
    while (current?.nodeType === 1) {
      const row = current as XmlElement;
      const epubTypes = (row.getAttribute('epub:type') ?? row.getAttribute('type') ?? '')
        .toLowerCase()
        .split(/\s+/);
      const role = (row.getAttribute('role') ?? '').toLowerCase();
      if (epubTypes.includes('footnote') || role === 'doc-footnote') return 'footnote';
      if (epubTypes.includes('endnote') || role === 'doc-endnote') return 'endnote';
      current = current.parentNode;
    }
    return undefined;
  };
  const visit = (element: XmlElement, inherited?: ReaderDocumentBlockKind) => {
    const name = localName(element);
    if (
      name === 'script' ||
      name === 'style' ||
      name === 'form' ||
      name === 'iframe' ||
      name === 'audio' ||
      name === 'video'
    )
      return;
    if (/^h[1-6]$/.test(name)) return addTextBlock(element, 'heading');
    if (name === 'p') return addTextBlock(element, inherited ?? 'paragraph');
    if (name === 'blockquote') {
      const paragraphs = elementChildren(element).filter((child) => localName(child) === 'p');
      if (paragraphs.length) paragraphs.forEach((child) => addTextBlock(child, 'blockquote'));
      else addTextBlock(element, 'blockquote');
      return;
    }
    if (name === 'li') return addTextBlock(element, 'list_item');
    if (name === 'hr') return addTextBlock(element, 'separator');
    if (name === 'img' || name === 'image') {
      const source =
        element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '';
      const resourceHref = resolvedHref(href, source);
      if (resourceHref) {
        result.push({
          kind: 'image',
          plainText: (element.getAttribute('alt') ?? '').trim(),
          resourceHref: resourceHref.split('#', 1)[0],
          sourceLocator: `epubcfi(/6/${(spineIndex + 1) * 2}!/4/${(result.length + 1) * 2})`,
        });
      }
      return;
    }
    const children = elementChildren(element);
    if (children.length === 0) {
      if (text(element)) addTextBlock(element, inherited ?? 'paragraph');
      return;
    }
    children.forEach((child) => visit(child, inherited));
  };
  elementChildren(body).forEach((child) => visit(child));
  return result;
}

function sectionTitle(document: XmlDocument, fallback: string): string {
  const heading =
    descendants(document, 'h1')[0] ?? descendants(document, 'h2')[0] ?? firstDescendant(document, 'title');
  return text(heading) || fallback;
}

export async function parseEpub(blob: Blob): Promise<EpubDocument> {
  let reader: ZipReader<Blob> | undefined;
  try {
    reader = new ZipReader(new BlobReader(blob));
    const entries = archiveEntries(await reader.getEntries());
    const container = parseXml(await entryText(findEntry(entries, 'META-INF/container.xml')), 'container.xml');
    const rootfile = descendants(container, 'rootfile')[0];
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new EpubImportError('EPUB package 경로가 없습니다.', 'invalid_package');
    const normalizedOpfPath = normalizedArchivePath(opfPath);
    const opf = parseXml(await entryText(findEntry(entries, normalizedOpfPath)), 'OPF');
    assertReflowable(opf);
    const metadata = packageMetadata(opf);
    const manifest = packageManifest(opf, normalizedOpfPath);
    const spine = packageSpine(opf, manifest);
    const tocTitles = await navigationTitles(entries, opf, manifest);
    const sections: EpubSection[] = [];
    for (let index = 0; index < spine.length; index += 1) {
      const item = spine[index];
      const document = parseXml(await entryText(findEntry(entries, item.href)), item.href);
      const blocks = sectionBlocks(document, item.href, index);
      if (blocks.length > 0) {
        sections.push({
          href: item.href,
          title: tocTitles.get(item.href) ?? sectionTitle(document, `섹션 ${index + 1}`),
          blocks,
        });
      }
    }
    if (sections.length === 0)
      throw new EpubImportError('EPUB 본문에 읽을 수 있는 내용이 없습니다.', 'invalid_package');

    const referenced = new Set(
      sections.flatMap((section) => section.blocks.map((block) => block.resourceHref).filter(Boolean) as string[]),
    );
    const coverItem = [...manifest.values()].find((item) => item.properties.has('cover-image'));
    if (coverItem) referenced.add(coverItem.href);
    const resources: EpubResource[] = [];
    for (const href of referenced) {
      const item = [...manifest.values()].find((candidate) => candidate.href === href);
      if (!item || !EPUB_IMAGE_TYPES.has(item.mediaType)) continue;
      const bytes = await entryBytes(findEntry(entries, href));
      resources.push({ href, mediaType: item.mediaType, contentHash: `sha256:${bytesToHex(sha256(bytes))}`, bytes });
    }
    return { ...metadata, coverHref: coverItem?.href, sections, resources };
  } catch (error) {
    if (error instanceof EpubImportError) throw error;
    throw new EpubImportError(
      error instanceof Error && error.message
        ? `EPUB archive를 읽을 수 없습니다: ${error.message}`
        : 'EPUB archive를 읽을 수 없습니다.',
      'invalid_archive',
    );
  } finally {
    await reader?.close().catch(() => undefined);
  }
}

function fileNameFromHref(href: string): string {
  return href.split('/').at(-1) || 'resource';
}

export interface MaterializeEpubImportOptions {
  readonly fileName: string;
  readonly sourceBytes: Uint8Array;
  readonly clientBookId?: string;
  readonly now?: string;
}

export function materializeEpubImport(
  document: EpubDocument,
  options: MaterializeEpubImportOptions,
): ParsedNovelImport {
  const normalizedText = document.sections
    .map((section) => [section.title, ...section.blocks.map((block) => block.plainText)].filter(Boolean).join('\n\n'))
    .join('\n\n\n');
  const normalizedTextHash = integrityHash(normalizedText);
  const sourceHash = integrityHash(options.sourceBytes);
  const bookId = options.clientBookId?.trim() || parsedNovelId(options.fileName, normalizedTextHash);
  const now = options.now ?? new Date().toISOString();
  const resourceIds = new Map(
    document.resources.map((resource) => [
      resource.href,
      persistentId128('epub_resource', [bookId, resource.href, resource.contentHash]),
    ]),
  );
  const chapters: Chapter[] = [];
  const chapterRows: ParsedNovelImportChapter[] = [];
  let totalCharacters = 0;
  let totalParagraphs = 0;
  let rawOffset = 0;
  for (let chapterIndex = 0; chapterIndex < document.sections.length; chapterIndex += 1) {
    const section = document.sections[chapterIndex];
    const chapterId = parsedChapterId(bookId, chapterIndex + 1, section.title);
    const paragraphs: Paragraph[] = [];
    let chapterOffset = 0;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex += 1) {
      const block = section.blocks[blockIndex];
      const paragraphId = parsedParagraphId(
        bookId,
        chapterId,
        blockIndex + 1,
        `${block.sourceLocator}:${block.plainText}`,
      );
      const start = chapterOffset;
      const end = start + block.plainText.length;
      paragraphs.push({
        id: paragraphId,
        novelId: bookId,
        chapterId,
        index: blockIndex + 1,
        text: block.plainText,
        startOffsetInChapter: start,
        endOffsetInChapter: end,
        textHash: integrityHash(block.plainText),
        documentKind: block.kind,
        inlineMarks: block.inlineMarks ? [...block.inlineMarks] : undefined,
        inlineSemantics: block.inlineSemantics ? [...block.inlineSemantics] : undefined,
        assetId: block.resourceHref ? resourceIds.get(block.resourceHref) : undefined,
        sourceHref: block.fragmentId ? `${section.href}#${block.fragmentId}` : section.href,
        documentPageType: block.semanticRole,
        sourceLocator: { kind: 'epub_cfi', value: block.sourceLocator },
      });
      chapterOffset = end + 2;
    }
    const chapterText = paragraphs.map((paragraph) => paragraph.text).join('\n\n');
    const chapter: Chapter = {
      id: chapterId,
      novelId: bookId,
      index: chapterIndex + 1,
      title: section.title,
      normalizedText: chapterText,
      textHash: integrityHash(chapterText),
      rawStartOffset: rawOffset,
      rawEndOffset: rawOffset + chapterText.length,
      characterCount: chapterText.length,
      paragraphCount: paragraphs.length,
      createdAt: now,
      updatedAt: now,
    };
    chapters.push(chapter);
    chapterRows.push({ chapter, paragraphs });
    totalCharacters += chapterText.length;
    totalParagraphs += paragraphs.length;
    rawOffset = chapter.rawEndOffset + 3;
  }
  const assets: ParsedNovelImportAsset[] = document.resources.map((resource) => ({
    id: resourceIds.get(resource.href)!,
    bookId,
    kind: 'epub_resource',
    provenance: 'epub_embedded',
    fileName: fileNameFromHref(resource.href),
    contentType: resource.mediaType,
    contentHash: resource.contentHash,
    bytes: resource.bytes,
  }));
  const coverResource = document.resources.find((resource) => resource.href === document.coverHref);
  const cover: ParsedNovelImportAsset | undefined = coverResource
    ? {
        id: persistentId128('epub_cover', [bookId, coverResource.contentHash]),
        bookId,
        kind: 'cover',
        provenance: 'epub_embedded',
        fileName: fileNameFromHref(coverResource.href),
        contentType: coverResource.mediaType,
        contentHash: coverResource.contentHash,
        bytes: coverResource.bytes,
      }
    : undefined;
  if (cover) assets.push(cover);
  let consumed = false;
  return {
    novel: {
      id: bookId,
      format: 'epub',
      title: document.title,
      author: document.author,
      description: document.description,
      language: document.language,
      coverAssetId: cover?.id,
      coverContentHash: cover?.contentHash,
      coverFit: cover ? 'contain' : undefined,
      sourceFileName: options.fileName,
      sourceContentType: 'application/epub+zip',
      sourceContentHash: sourceHash,
      rawText: '',
      normalizedText: '',
      rawTextHash: sourceHash,
      normalizedTextHash,
      createdAt: now,
      updatedAt: now,
      totalChapters: chapters.length,
      totalCharacters,
      totalParagraphs,
      coverSeed: stableEpubCoverSeed(normalizedTextHash),
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
      metadataRevision: 0,
    },
    chapters,
    embeddedAssets: assets,
    consumeChapterParagraphs() {
      if (consumed) return [];
      consumed = true;
      return chapterRows;
    },
  };
}
