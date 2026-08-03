export interface OcrPageRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly pageIndexes: readonly number[];
}

export function normalizeOcrPageRange(
  startPage: number,
  endPage: number,
  totalPages: number,
  maxPages = 50,
): OcrPageRange {
  const lastIndex = Math.max(0, Math.trunc(totalPages) - 1);
  const clamp = (page: number) => Math.min(lastIndex, Math.max(0, Math.trunc(page || 1) - 1));
  const first = Math.min(clamp(startPage), clamp(endPage));
  const requestedEnd = Math.max(clamp(startPage), clamp(endPage));
  const endIndex = Math.min(requestedEnd, first + Math.max(1, Math.trunc(maxPages)) - 1);

  return {
    startIndex: first,
    endIndex,
    pageIndexes: Array.from({ length: endIndex - first + 1 }, (_, offset) => first + offset),
  };
}

export function needsPdfOcr(input: {
  readonly hasRevision: boolean;
  readonly characters: number;
  readonly qualityScore?: number;
}): boolean {
  return !input.hasRevision || input.characters < 16 || (input.qualityScore ?? 0) < 0.45;
}
