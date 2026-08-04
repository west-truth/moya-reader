import { describe, expect, it } from 'vitest';
import type { DocumentTextBlock, DocumentTextRevision } from './types';
import {
  applyDocumentTextOrderOverride,
  createDocumentTextOrderOverride,
  documentTextBlockFingerprint,
} from './document-text-order';

const revision: DocumentTextRevision = {
  id: 'revision',
  bookId: 'book',
  pageIndex: 2,
  pageHash: 'page-hash',
  source: 'pdf_native',
  engine: 'pdfjs',
  engineVersion: '5',
  status: 'ready',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function block(id: string, text: string, order: number, y: number): DocumentTextBlock {
  return {
    id,
    revisionId: revision.id,
    bookId: revision.bookId,
    pageIndex: revision.pageIndex,
    order,
    role: 'paragraph',
    text,
    normalizedText: text.toLocaleLowerCase(),
    quads: [{ x: 0.1, y, width: 0.5, height: 0.03 }],
    direction: 'ltr',
  };
}

describe('document text order override', () => {
  it('projects user order and exclusions without mutating source blocks', () => {
    const first = block('first', 'First', 0, 0.1);
    const second = block('second', 'Second', 1, 0.2);
    const third = block('third', 'Footer', 2, 0.9);
    const override = createDocumentTextOrderOverride({
      revision,
      orderedBlocks: [second, first, third],
      excludedBlockIds: new Set([third.id]),
      now: '2026-08-01T00:01:00.000Z',
    });

    expect(applyDocumentTextOrderOverride([first, second, third], override).map((item) => item.id)).toEqual([
      'second',
      'first',
    ]);
    expect([first.order, second.order, third.order]).toEqual([0, 1, 2]);
  });

  it('conservatively reapplies matching fingerprints to a new revision and appends unmatched blocks', () => {
    const first = block('first', 'First', 0, 0.1);
    const second = block('second', 'Second', 1, 0.2);
    const override = createDocumentTextOrderOverride({
      revision,
      orderedBlocks: [second, first],
      excludedBlockIds: new Set(),
    });
    const newFirst = { ...first, id: 'new-first', revisionId: 'next' };
    const newSecond = { ...second, id: 'new-second', revisionId: 'next' };
    const added = block('added', 'Added', 2, 0.3);

    expect(applyDocumentTextOrderOverride([newFirst, newSecond, added], override).map((item) => item.id)).toEqual([
      'new-second',
      'new-first',
      'added',
    ]);
    expect(documentTextBlockFingerprint(newFirst)).toBe(documentTextBlockFingerprint(first));
  });
});
