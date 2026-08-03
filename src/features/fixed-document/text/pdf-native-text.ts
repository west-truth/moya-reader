import { persistentId128 } from '@noveldesk/text-core/hash';
import type { DocumentTextBlock, DocumentTextRevision, TextQuad } from '../../../domain/types';

export const PDF_NATIVE_TEXT_READING_ORDER_VERSION = 'reading-order-v2-tagged';

export function pdfNativeTextRevisionId(bookId: string, pageHash: string, engineVersion = 'pdfjs-5'): string {
  return persistentId128('document_text_revision', [
    bookId,
    pageHash,
    'pdf_native',
    engineVersion,
    PDF_NATIVE_TEXT_READING_ORDER_VERSION,
  ]);
}

interface PdfTextItemLike {
  readonly str: string;
  readonly dir?: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL?: boolean;
}

interface PdfMarkedContentLike {
  readonly type: 'beginMarkedContent' | 'beginMarkedContentProps' | 'endMarkedContent';
  readonly id?: string;
}

interface PdfStructContentLike {
  readonly type: string;
  readonly id: string;
}

interface PdfStructNodeLike {
  readonly role: string;
  readonly children: readonly (PdfStructNodeLike | PdfStructContentLike)[];
}

export interface PdfTextPageLike {
  getViewport(input: { scale: number; rotation?: number }): { width: number; height: number };
  getTextContent(input?: { includeMarkedContent?: boolean }): Promise<{ items: readonly unknown[] }>;
  getStructTree?(): Promise<unknown>;
}

interface PositionedText {
  text: string;
  quad: TextQuad;
  direction: DocumentTextBlock['direction'];
  hasEol: boolean;
  markedContentId?: string;
}

interface StructureEntry {
  readonly order: number;
  readonly role: DocumentTextBlock['role'];
}

export interface PdfNativeTextResult {
  readonly revision: DocumentTextRevision;
  readonly blocks: DocumentTextBlock[];
  readonly needsOcr: boolean;
  readonly diagnostics: {
    readonly characters: number;
    readonly invalidGeometryRatio: number;
    readonly replacementCharacterRatio: number;
    readonly taggedBlockRatio: number;
    readonly usedStructureTree: boolean;
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function textItem(value: unknown): value is PdfTextItemLike {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfTextItemLike>;
  return typeof item.str === 'string' && Array.isArray(item.transform) && item.transform.length >= 6;
}

function markedContent(value: unknown): value is PdfMarkedContentLike {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfMarkedContentLike>;
  return (
    item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps' || item.type === 'endMarkedContent'
  );
}

function structureNode(value: unknown): value is PdfStructNodeLike {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfStructNodeLike>;
  return typeof item.role === 'string' && Array.isArray(item.children);
}

function structureContent(value: unknown): value is PdfStructContentLike {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfStructContentLike>;
  return typeof item.type === 'string' && typeof item.id === 'string';
}

function structureRole(value: string): DocumentTextBlock['role'] {
  const role = value.trim().toLocaleLowerCase();
  if (/^h[1-6]?$/.test(role) || role === 'title') return 'heading';
  if (role === 'li' || role === 'l' || role === 'lbl') return 'list_item';
  if (role === 'caption' || role === 'figcaption') return 'caption';
  if (role === 'note' || role === 'footnote' || role === 'endnote') return 'footnote';
  if (role === 'p' || role === 'para' || role === 'blockquote') return 'paragraph';
  return 'unknown';
}

function structureEntries(root: unknown): Map<string, StructureEntry> {
  const entries = new Map<string, StructureEntry>();
  if (!structureNode(root)) return entries;
  let order = 0;
  const visit = (node: PdfStructNodeLike, inheritedRole: DocumentTextBlock['role']) => {
    const ownRole = structureRole(node.role);
    const role = ownRole === 'unknown' ? inheritedRole : ownRole;
    for (const child of node.children) {
      if (structureNode(child)) visit(child, role);
      else if (structureContent(child) && child.type === 'content' && !entries.has(child.id)) {
        entries.set(child.id, { order, role });
        order += 1;
      }
    }
  };
  visit(root, 'unknown');
  return entries;
}

function textItemsWithMarkedContent(items: readonly unknown[]): Array<{
  readonly item: PdfTextItemLike;
  readonly markedContentId?: string;
}> {
  const stack: Array<string | undefined> = [];
  const output: Array<{ item: PdfTextItemLike; markedContentId?: string }> = [];
  for (const value of items) {
    if (markedContent(value)) {
      if (value.type === 'endMarkedContent') stack.pop();
      else stack.push(value.type === 'beginMarkedContentProps' ? value.id : undefined);
      continue;
    }
    if (!textItem(value)) continue;
    output.push({ item: value, markedContentId: [...stack].reverse().find(Boolean) });
  }
  return output;
}

function positioned(
  item: PdfTextItemLike,
  pageWidth: number,
  pageHeight: number,
  markedContentId?: string,
): PositionedText | undefined {
  const text = item.str.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const fontHeight = Math.max(Math.abs(item.height || 0), Math.abs(item.transform[3] || 0), 1);
  const x = item.transform[4] / pageWidth;
  const y = (pageHeight - item.transform[5] - fontHeight) / pageHeight;
  const width = Math.max(item.width / pageWidth, 0.001);
  const height = Math.max(fontHeight / pageHeight, 0.001);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return {
    text,
    quad: {
      x: clamp01(x),
      y: clamp01(y),
      width: clamp01(Math.min(width, 1 - clamp01(x))),
      height: clamp01(Math.min(height, 1 - clamp01(y))),
    },
    direction: item.dir === 'rtl' ? 'rtl' : item.dir === 'ttb' ? 'ttb' : 'ltr',
    hasEol: Boolean(item.hasEOL),
    markedContentId,
  };
}

function groupLines(items: readonly PositionedText[]): PositionedText[][] {
  const lines: PositionedText[][] = [];
  for (const item of [...items].sort((left, right) => left.quad.y - right.quad.y || left.quad.x - right.quad.x)) {
    const line = lines.find((candidate) => {
      const reference = candidate[0];
      return Math.abs(reference.quad.y - item.quad.y) <= Math.max(reference.quad.height, item.quad.height) * 0.65;
    });
    if (line) line.push(item);
    else lines.push([item]);
  }
  return lines.flatMap((line) => {
    const sorted = line.sort((left, right) => left.quad.x - right.quad.x);
    const segments: PositionedText[][] = [];
    for (const item of sorted) {
      const current = segments.at(-1);
      const previous = current?.at(-1);
      const gap = previous ? item.quad.x - (previous.quad.x + previous.quad.width) : 0;
      if (!current || previous?.hasEol || gap > Math.max(0.055, (previous?.quad.height ?? 0) * 3.5))
        segments.push([item]);
      else current.push(item);
    }
    return segments;
  });
}

function readingOrder(lines: readonly PositionedText[][]): PositionedText[][] {
  if (lines.length < 4) return [...lines].sort((a, b) => a[0].quad.y - b[0].quad.y || a[0].quad.x - b[0].quad.x);
  const narrow = lines.filter((line) => {
    const left = Math.min(...line.map((item) => item.quad.x));
    const right = Math.max(...line.map((item) => item.quad.x + item.quad.width));
    return right - left < 0.58;
  });
  const centers = narrow
    .map((line) => {
      const left = Math.min(...line.map((item) => item.quad.x));
      const right = Math.max(...line.map((item) => item.quad.x + item.quad.width));
      return { line, center: (left + right) / 2 };
    })
    .sort((a, b) => a.center - b.center);
  let splitAt = -1;
  let splitGap = 0;
  for (let index = 1; index < centers.length; index += 1) {
    const gap = centers[index].center - centers[index - 1].center;
    if (gap > splitGap && index >= 2 && centers.length - index >= 2) {
      splitAt = index;
      splitGap = gap;
    }
  }
  if (splitAt < 0 || splitGap < 0.18) {
    return [...lines].sort((a, b) => a[0].quad.y - b[0].quad.y || a[0].quad.x - b[0].quad.x);
  }
  const leftSet = new Set(centers.slice(0, splitAt).map((entry) => entry.line));
  const rightSet = new Set(centers.slice(splitAt).map((entry) => entry.line));
  const columnTop = Math.min(...centers.map((entry) => entry.line[0].quad.y));
  const fullWidth = lines.filter((line) => !leftSet.has(line) && !rightSet.has(line));
  const top = fullWidth.filter((line) => line[0].quad.y <= columnTop + 0.035);
  const tail = fullWidth.filter((line) => !top.includes(line));
  const byY = (a: PositionedText[], b: PositionedText[]) => a[0].quad.y - b[0].quad.y;
  return [...top.sort(byY), ...[...leftSet].sort(byY), ...[...rightSet].sort(byY), ...tail.sort(byY)];
}

function lineStructure(
  line: readonly PositionedText[],
  entries: ReadonlyMap<string, StructureEntry>,
): StructureEntry | undefined {
  return line
    .flatMap((item) => {
      const entry = item.markedContentId ? entries.get(item.markedContentId) : undefined;
      return entry ? [entry] : [];
    })
    .sort((left, right) => left.order - right.order)[0];
}

function applyTaggedReadingOrder(
  geometryOrdered: readonly PositionedText[][],
  entries: ReadonlyMap<string, StructureEntry>,
): { readonly lines: PositionedText[][]; readonly taggedRatio: number; readonly used: boolean } {
  if (geometryOrdered.length === 0 || entries.size === 0) {
    return { lines: [...geometryOrdered], taggedRatio: 0, used: false };
  }
  const tagged = geometryOrdered.map((line) => ({ line, structure: lineStructure(line, entries) }));
  const taggedCount = tagged.filter((item) => item.structure).length;
  const taggedRatio = taggedCount / geometryOrdered.length;
  if (taggedRatio < 0.5) return { lines: [...geometryOrdered], taggedRatio, used: false };
  return {
    lines: tagged
      .map((item, geometryOrder) => ({ ...item, geometryOrder }))
      .sort((left, right) => {
        if (left.structure && right.structure) return left.structure.order - right.structure.order;
        if (left.structure) return -1;
        if (right.structure) return 1;
        return left.geometryOrder - right.geometryOrder;
      })
      .map((item) => item.line),
    taggedRatio,
    used: true,
  };
}

export async function extractPdfNativeText(input: {
  page: PdfTextPageLike;
  bookId: string;
  pageIndex: number;
  pageHash: string;
  engineVersion?: string;
  now?: string;
}): Promise<PdfNativeTextResult> {
  const viewport = input.page.getViewport({ scale: 1, rotation: 0 });
  const [content, structure] = await Promise.all([
    input.page.getTextContent({ includeMarkedContent: true }),
    input.page.getStructTree ? input.page.getStructTree().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const rawItems = textItemsWithMarkedContent(content.items);
  const positionedItems = rawItems
    .map(({ item, markedContentId }) => positioned(item, viewport.width, viewport.height, markedContentId))
    .filter((item): item is PositionedText => Boolean(item));
  const structureMap = structureEntries(structure);
  const taggedOrder = applyTaggedReadingOrder(readingOrder(groupLines(positionedItems)), structureMap);
  const orderedLines = taggedOrder.lines;
  const revisionId = pdfNativeTextRevisionId(input.bookId, input.pageHash, input.engineVersion ?? 'pdfjs-5');
  const text = orderedLines
    .flat()
    .map((item) => item.text)
    .join(' ');
  const replacementCharacters = [...text].filter(
    (character) => character === '\ufffd' || character.charCodeAt(0) <= 8,
  ).length;
  const invalidGeometryRatio = rawItems.length === 0 ? 1 : 1 - positionedItems.length / rawItems.length;
  const replacementCharacterRatio = text.length === 0 ? 0 : replacementCharacters / text.length;
  const qualityScore = Math.max(
    0,
    Math.min(
      1,
      Math.min(1, text.length / 120) * 0.65 + (1 - invalidGeometryRatio) * 0.35 - replacementCharacterRatio * 2,
    ),
  );
  const timestamp = input.now ?? new Date().toISOString();
  const revision: DocumentTextRevision = {
    id: revisionId,
    bookId: input.bookId,
    pageIndex: input.pageIndex,
    pageHash: input.pageHash,
    source: 'pdf_native',
    engine: 'pdfjs',
    engineVersion: input.engineVersion ?? '5',
    status: 'ready',
    qualityScore,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const heights = positionedItems.map((item) => item.quad.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const blocks: DocumentTextBlock[] = orderedLines.map((line, order) => {
    const lineText = line.map((item) => item.text).join(line[0]?.direction === 'ttb' ? '' : ' ');
    const maxHeight = Math.max(...line.map((item) => item.quad.height));
    const taggedRole = lineStructure(line, structureMap)?.role;
    return {
      id: persistentId128('document_text_block', [revisionId, String(order), lineText]),
      revisionId,
      bookId: input.bookId,
      pageIndex: input.pageIndex,
      order,
      role:
        taggedRole && taggedRole !== 'unknown'
          ? taggedRole
          : medianHeight > 0 && maxHeight > medianHeight * 1.35
            ? 'heading'
            : 'paragraph',
      text: lineText,
      normalizedText: lineText.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(),
      quads: line.map((item) => item.quad),
      direction: line[0]?.direction ?? 'ltr',
    };
  });
  return {
    revision,
    blocks,
    needsOcr: text.length < 16 || qualityScore < 0.45,
    diagnostics: {
      characters: text.length,
      invalidGeometryRatio,
      replacementCharacterRatio,
      taggedBlockRatio: taggedOrder.taggedRatio,
      usedStructureTree: taggedOrder.used,
    },
  };
}
