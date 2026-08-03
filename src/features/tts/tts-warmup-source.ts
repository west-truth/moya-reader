import type { Paragraph, ParagraphPage } from '../../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import type { BulkParagraphPageRequest } from '../../repositories/reader-repository';

export interface TTSWarmupParagraphSource {
  readonly getParagraph: (paragraphId: string, signal?: AbortSignal) => Promise<Paragraph | undefined>;
  readonly getParagraphPage?: (
    chapterId: string,
    pageIndex: number,
    signal?: AbortSignal,
  ) => Promise<ParagraphPage | undefined>;
  readonly iterateParagraphPages?: (request: BulkParagraphPageRequest) => AsyncIterable<ParagraphPage>;
}

export interface LoadTTSWarmupParagraphsInput {
  readonly source: TTSWarmupParagraphSource;
  readonly chapterId: string;
  readonly paragraphCount: number;
  readonly candidateParagraphIds: readonly string[];
  readonly signal: AbortSignal;
  readonly cachedParagraph?: (paragraphId: string) => Paragraph | undefined;
  readonly preferPageReads?: boolean;
}

const DIRECT_READ_CONCURRENCY = 4;
const DIRECT_READ_THRESHOLD = 8;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function loadDirect(
  source: TTSWarmupParagraphSource,
  paragraphIds: readonly string[],
  signal: AbortSignal,
): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  for (let offset = 0; offset < paragraphIds.length; offset += DIRECT_READ_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = paragraphIds.slice(offset, offset + DIRECT_READ_CONCURRENCY);
    const loaded = await Promise.all(batch.map((paragraphId) => source.getParagraph(paragraphId, signal)));
    throwIfAborted(signal);
    for (const paragraph of loaded) if (paragraph) paragraphs.push(paragraph);
  }
  return paragraphs;
}

export async function loadTTSWarmupParagraphs(input: LoadTTSWarmupParagraphsInput): Promise<Paragraph[]> {
  throwIfAborted(input.signal);
  const candidateIds = [...new Set(input.candidateParagraphIds.filter(Boolean))];
  if (candidateIds.length === 0) return [];

  const selected = new Map<string, Paragraph>();
  const missing = new Set(candidateIds);
  for (const paragraphId of candidateIds) {
    const cached = input.cachedParagraph?.(paragraphId);
    if (!cached || cached.chapterId !== input.chapterId) continue;
    selected.set(paragraphId, cached);
    missing.delete(paragraphId);
  }

  const sparseDirectRead = !input.preferPageReads && missing.size <= DIRECT_READ_THRESHOLD;
  if (!sparseDirectRead && missing.size > 0 && input.source.iterateParagraphPages) {
    for await (const page of input.source.iterateParagraphPages({
      chapterId: input.chapterId,
      signal: input.signal,
    })) {
      throwIfAborted(input.signal);
      for (const paragraph of page.paragraphs) {
        if (paragraph.chapterId !== input.chapterId || !missing.has(paragraph.id)) continue;
        selected.set(paragraph.id, paragraph);
        missing.delete(paragraph.id);
      }
      if (missing.size === 0) break;
    }
  } else if (!sparseDirectRead && missing.size > 0 && input.source.getParagraphPage) {
    const pageCount = Math.ceil(Math.max(0, input.paragraphCount) / PARAGRAPHS_PER_PAGE);
    for (let pageIndex = 0; pageIndex < pageCount && missing.size > 0; pageIndex += 1) {
      throwIfAborted(input.signal);
      const page = await input.source.getParagraphPage(input.chapterId, pageIndex, input.signal);
      throwIfAborted(input.signal);
      for (const paragraph of page?.paragraphs ?? []) {
        if (paragraph.chapterId !== input.chapterId || !missing.has(paragraph.id)) continue;
        selected.set(paragraph.id, paragraph);
        missing.delete(paragraph.id);
      }
    }
  }

  const compatibilitySource = !input.source.iterateParagraphPages;
  if (missing.size > 0 && (missing.size <= DIRECT_READ_THRESHOLD || compatibilitySource)) {
    const direct = await loadDirect(input.source, [...missing], input.signal);
    for (const paragraph of direct) {
      if (paragraph.chapterId === input.chapterId && missing.has(paragraph.id)) selected.set(paragraph.id, paragraph);
    }
  }

  return candidateIds
    .map((paragraphId) => selected.get(paragraphId))
    .filter((paragraph): paragraph is Paragraph => paragraph !== undefined)
    .sort((left, right) => left.index - right.index);
}
