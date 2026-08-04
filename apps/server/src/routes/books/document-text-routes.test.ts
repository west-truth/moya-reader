import { describe, expect, it } from 'vitest';
import { parseDocumentTextPage } from './document-text-routes.js';

const revision = {
  id: 'revision_1',
  bookId: 'book_1',
  pageIndex: 0,
  pageHash: 'page_hash_1',
  source: 'pdf_native',
  engine: 'pdfjs',
  engineVersion: '1',
  status: 'ready',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('parseDocumentTextPage', () => {
  it('accepts one bounded ready page and derives normalized search text on the server', () => {
    expect(
      parseDocumentTextPage('book_1', 0, {
        revision,
        blocks: [
          {
            id: 'block_1',
            revisionId: 'revision_1',
            bookId: 'book_1',
            pageIndex: 0,
            order: 0,
            role: 'paragraph',
            text: '  Ｈello   WORLD ',
            normalizedText: 'forged',
            quads: [],
            direction: 'ltr',
          },
        ],
      }),
    ).toMatchObject({
      revision: { id: 'revision_1', status: 'ready' },
      blocks: [{ id: 'block_1', normalizedText: 'hello world' }],
    });
  });

  it('rejects cross-book blocks and non-ready revisions', () => {
    expect(parseDocumentTextPage('book_2', 0, { revision, blocks: [] })).toBeUndefined();
    expect(
      parseDocumentTextPage('book_1', 0, { revision: { ...revision, status: 'pending' }, blocks: [] }),
    ).toBeUndefined();
  });

  it('rejects non-normalized quads and out-of-range quality scores', () => {
    const block = {
      id: 'block_1',
      revisionId: 'revision_1',
      bookId: 'book_1',
      pageIndex: 0,
      order: 0,
      role: 'paragraph',
      text: 'text',
      quads: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }],
      direction: 'ltr',
    };
    expect(parseDocumentTextPage('book_1', 0, { revision, blocks: [block] })).toBeUndefined();
    expect(
      parseDocumentTextPage('book_1', 0, {
        revision: { ...revision, qualityScore: 1.1 },
        blocks: [{ ...block, quads: [] }],
      }),
    ).toBeUndefined();
  });
});
