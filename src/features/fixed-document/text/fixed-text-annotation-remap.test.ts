import { describe, expect, it } from 'vitest';
import type { DocumentAnnotation, DocumentTextBlock, DocumentTextRevision } from '../../../domain/types';
import { remapFixedTextAnnotation } from './fixed-text-annotation-remap';

const revision: DocumentTextRevision = {
  id: 'revision-new',
  bookId: 'book',
  pageIndex: 0,
  pageHash: 'page',
  source: 'ocr',
  engine: 'test',
  engineVersion: '1',
  status: 'ready',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function block(id: string, order: number, text: string): DocumentTextBlock {
  return {
    id,
    revisionId: revision.id,
    bookId: 'book',
    pageIndex: 0,
    order,
    role: 'paragraph',
    text,
    normalizedText: text.toLowerCase(),
    quads: [{ x: 0.1, y: 0.1 + order * 0.1, width: 0.8, height: 0.05 }],
    direction: 'ltr',
  };
}

function annotation(quote = '이어지는\n문장'): DocumentAnnotation {
  return {
    id: 'annotation',
    bookId: 'book',
    pageIndex: 0,
    type: 'text_highlight',
    anchor: {
      kind: 'fixed_text',
      bookId: 'book',
      pageIndex: 0,
      textRevisionId: 'revision-old',
      blockId: 'old-block',
      startOffset: 0,
      endOffset: quote.length,
      quads: [{ x: 0, y: 0, width: 1, height: 0.1 }],
    },
    quote,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('fixed text annotation remap', () => {
  it('remaps a unique quote across new revision blocks', () => {
    const result = remapFixedTextAnnotation({
      annotation: annotation(),
      targetRevision: revision,
      targetBlocks: [block('new-1', 0, '앞에서 이어지는'), block('new-2', 1, '문장 뒤까지')],
      now: '2026-08-01T00:01:00.000Z',
    });
    expect(result.changed).toBe(true);
    expect(result.annotation.anchor).toMatchObject({
      kind: 'fixed_text',
      textRevisionId: revision.id,
      blockId: 'new-1',
      blockRanges: [
        { blockId: 'new-1', startOffset: 4, endOffset: 8 },
        { blockId: 'new-2', startOffset: 0, endOffset: 2 },
      ],
    });
    expect(result.annotation.textAnchorRemap?.status).toBe('remapped');
  });

  it('keeps the old anchor and requires review when the quote is ambiguous', () => {
    const original = annotation('반복');
    const result = remapFixedTextAnnotation({
      annotation: original,
      targetRevision: revision,
      targetBlocks: [block('new-1', 0, '반복 그리고 반복')],
      now: '2026-08-01T00:01:00.000Z',
    });
    expect(result.annotation.anchor).toEqual(original.anchor);
    expect(result.annotation.textAnchorRemap).toMatchObject({
      status: 'needs_review',
      targetTextRevisionId: revision.id,
    });
  });
});
