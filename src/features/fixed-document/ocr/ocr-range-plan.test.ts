import { describe, expect, it } from 'vitest';
import { needsPdfOcr, normalizeOcrPageRange } from './ocr-range-plan';

describe('normalizeOcrPageRange', () => {
  it('accepts a reversed range and caps the job at fifty pages', () => {
    const range = normalizeOcrPageRange(90, 10, 120);

    expect(range.startIndex).toBe(9);
    expect(range.endIndex).toBe(58);
    expect(range.pageIndexes).toHaveLength(50);
  });

  it('clamps invalid page numbers to the document bounds', () => {
    const range = normalizeOcrPageRange(-4, 999, 8);

    expect(range.pageIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('needsPdfOcr', () => {
  it('keeps a sufficiently long, high-quality native revision', () => {
    expect(needsPdfOcr({ hasRevision: true, characters: 200, qualityScore: 0.8 })).toBe(false);
  });

  it.each([
    { hasRevision: false, characters: 200, qualityScore: 0.8 },
    { hasRevision: true, characters: 15, qualityScore: 0.8 },
    { hasRevision: true, characters: 200, qualityScore: 0.44 },
  ])('schedules missing, short, or low-quality text for OCR', (input) => {
    expect(needsPdfOcr(input)).toBe(true);
  });
});
