import type { Paragraph } from '../../domain/types';
import {
  readerSearchPageSize,
  throwIfReaderSearchAborted,
  type ReaderSearchPage,
  type ReaderSearchPageRequest,
} from '../../repositories/reader-query-contract';
import type { RemoteRequest } from './remote-api-contracts';

interface RemoteSearchResponse {
  readonly paragraphs?: unknown;
  readonly nextCursor?: unknown;
  readonly capped?: unknown;
  readonly scannedRows?: unknown;
  readonly scannedTextCharacters?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Remote search paragraph ${key} is invalid.`);
  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Remote search paragraph ${key} is invalid.`);
  }
  return value;
}

function parseParagraph(value: unknown): Paragraph {
  const row = record(value);
  if (!row) throw new Error('Remote search paragraph is invalid.');
  return {
    id: requiredString(row, 'id'),
    novelId: requiredString(row, 'novelId'),
    chapterId: requiredString(row, 'chapterId'),
    index: requiredNumber(row, 'index'),
    text: requiredString(row, 'text'),
    startOffsetInChapter: requiredNumber(row, 'startOffsetInChapter'),
    endOffsetInChapter: requiredNumber(row, 'endOffsetInChapter'),
    textHash: requiredString(row, 'textHash'),
  };
}

function optionalNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseSearchResponse(value: RemoteSearchResponse): ReaderSearchPage {
  if (!Array.isArray(value.paragraphs)) throw new Error('Remote search response paragraphs are invalid.');
  const paragraphs = value.paragraphs.map(parseParagraph);
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') {
    throw new Error('Remote search response cursor is invalid.');
  }
  if (value.capped !== undefined && typeof value.capped !== 'boolean') {
    throw new Error('Remote search response capped flag is invalid.');
  }
  return {
    paragraphs,
    nextCursor: value.nextCursor,
    capped: value.capped ?? false,
    scannedRows: optionalNonNegativeNumber(value.scannedRows, paragraphs.length),
    scannedTextCharacters: optionalNonNegativeNumber(
      value.scannedTextCharacters,
      paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
    ),
  };
}

export class RemoteSearchTransport {
  constructor(private readonly request: RemoteRequest) {}

  async searchParagraphPage(input: ReaderSearchPageRequest): Promise<ReaderSearchPage> {
    throwIfReaderSearchAborted(input.signal);
    const params = new URLSearchParams({
      query: input.query,
      pageSize: String(readerSearchPageSize(input.pageSize)),
    });
    if (input.cursor) params.set('cursor', input.cursor);
    const target =
      input.scope === 'chapter'
        ? `/chapters/${encodeURIComponent(input.chapterId)}/search`
        : `/books/${encodeURIComponent(input.novelId)}/search`;
    const response = await this.request<RemoteSearchResponse>(`${target}?${params.toString()}`, {
      signal: input.signal,
    });
    throwIfReaderSearchAborted(input.signal);
    return parseSearchResponse(response);
  }
}
