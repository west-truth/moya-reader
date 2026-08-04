import { describe, expect, it } from 'vitest';
import type { DocumentAnnotation } from '../../../domain/types';
import { manuallyReanchorFixedTextAnnotation } from './manual-fixed-text-reanchor';

const annotation: DocumentAnnotation = {
  id: 'annotation',
  bookId: 'book',
  pageIndex: 2,
  type: 'text_note',
  anchor: {
    kind: 'fixed_text',
    bookId: 'book',
    pageIndex: 2,
    textRevisionId: 'old-revision',
    blockId: 'old-block',
    startOffset: 1,
    endOffset: 5,
  },
  quote: 'old quote',
  body: '사용자 메모',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:01:00.000Z',
  textAnchorRemap: {
    status: 'needs_review',
    fromTextRevisionId: 'old-revision',
    targetTextRevisionId: 'ambiguous-revision',
    updatedAt: '2026-08-01T00:01:00.000Z',
  },
};

describe('manuallyReanchorFixedTextAnnotation', () => {
  it('preserves user content and identity while replacing the fixed-text anchor', () => {
    const updated = manuallyReanchorFixedTextAnnotation({
      annotation,
      anchor: {
        kind: 'fixed_text',
        bookId: 'book',
        pageIndex: 2,
        textRevisionId: 'ready-revision',
        blockId: 'new-block',
        startOffset: 3,
        endOffset: 9,
        quads: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      },
      quote: 'new quote',
      updatedAt: '2026-08-01T00:02:00.000Z',
    });

    expect(updated).toMatchObject({
      id: annotation.id,
      body: '사용자 메모',
      quote: 'new quote',
      updatedAt: '2026-08-01T00:02:00.000Z',
      textAnchorRemap: {
        status: 'remapped',
        fromTextRevisionId: 'old-revision',
        targetTextRevisionId: 'ready-revision',
      },
    });
  });

  it('rejects a selection from another page', () => {
    expect(() =>
      manuallyReanchorFixedTextAnnotation({
        annotation,
        anchor: {
          kind: 'fixed_text',
          bookId: 'book',
          pageIndex: 3,
          textRevisionId: 'ready-revision',
          blockId: 'new-block',
          startOffset: 0,
          endOffset: 4,
        },
        quote: 'wrong page',
        updatedAt: '2026-08-01T00:02:00.000Z',
      }),
    ).toThrow('같은 책의 같은 페이지');
  });
});
