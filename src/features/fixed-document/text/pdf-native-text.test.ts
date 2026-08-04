import { describe, expect, it } from 'vitest';
import { extractPdfNativeText } from './pdf-native-text';

function item(str: string, x: number, y: number, width = 120) {
  return { str, dir: 'ltr', transform: [12, 0, 0, 12, x, y], width, height: 12 };
}

function tagged(id: string, value: ReturnType<typeof item>) {
  return [{ type: 'beginMarkedContentProps', id }, value, { type: 'endMarkedContent' }];
}

describe('extractPdfNativeText', () => {
  it('keeps normalized geometry and traverses detected columns instead of interleaving lines', async () => {
    const result = await extractPdfNativeText({
      bookId: 'book',
      pageIndex: 0,
      pageHash: 'sha256:page',
      now: '2026-08-01T00:00:00.000Z',
      page: {
        getViewport: () => ({ width: 1000, height: 1000 }),
        getTextContent: async () => ({
          items: [
            item('제목', 150, 950, 700),
            item('왼쪽 첫째', 80, 850),
            item('오른쪽 첫째', 600, 850),
            item('왼쪽 둘째', 80, 800),
            item('오른쪽 둘째', 600, 800),
          ],
        }),
      },
    });

    expect(result.blocks.map((block) => block.text)).toEqual([
      '제목',
      '왼쪽 첫째',
      '왼쪽 둘째',
      '오른쪽 첫째',
      '오른쪽 둘째',
    ]);
    expect(result.blocks.flatMap((block) => block.quads).every((quad) => quad.x >= 0 && quad.y >= 0)).toBe(true);
    expect(result.revision.status).toBe('ready');
  });

  it('marks an empty or unusable native layer as an OCR candidate', async () => {
    const result = await extractPdfNativeText({
      bookId: 'book',
      pageIndex: 1,
      pageHash: 'sha256:scan',
      page: {
        getViewport: () => ({ width: 1000, height: 1000 }),
        getTextContent: async () => ({ items: [] }),
      },
    });

    expect(result.needsOcr).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  it('uses a sufficiently covered structure tree for logical order and semantic roles', async () => {
    const result = await extractPdfNativeText({
      bookId: 'book',
      pageIndex: 2,
      pageHash: 'sha256:tagged',
      page: {
        getViewport: () => ({ width: 1_000, height: 1_000 }),
        getTextContent: async () => ({
          items: [
            ...tagged('heading', item('제목', 80, 930, 400)),
            ...tagged('left', item('왼쪽 문단', 80, 850)),
            ...tagged('right', item('오른쪽 항목', 600, 850)),
          ],
        }),
        getStructTree: async () => ({
          role: 'Root',
          children: [
            { role: 'H1', children: [{ type: 'content', id: 'heading' }] },
            { role: 'LI', children: [{ type: 'content', id: 'right' }] },
            { role: 'P', children: [{ type: 'content', id: 'left' }] },
          ],
        }),
      },
    });

    expect(result.blocks.map((block) => [block.text, block.role])).toEqual([
      ['제목', 'heading'],
      ['오른쪽 항목', 'list_item'],
      ['왼쪽 문단', 'paragraph'],
    ]);
    expect(result.diagnostics.usedStructureTree).toBe(true);
    expect(result.diagnostics.taggedBlockRatio).toBe(1);
  });

  it('falls back to geometry when the structure tree has insufficient text coverage', async () => {
    const result = await extractPdfNativeText({
      bookId: 'book',
      pageIndex: 3,
      pageHash: 'sha256:partial-tagged',
      page: {
        getViewport: () => ({ width: 1_000, height: 1_000 }),
        getTextContent: async () => ({
          items: [...tagged('only-tag', item('첫째', 80, 900)), item('둘째', 80, 800), item('셋째', 80, 700)],
        }),
        getStructTree: async () => ({
          role: 'Root',
          children: [{ role: 'P', children: [{ type: 'content', id: 'only-tag' }] }],
        }),
      },
    });

    expect(result.blocks.map((block) => block.text)).toEqual(['첫째', '둘째', '셋째']);
    expect(result.diagnostics.usedStructureTree).toBe(false);
  });
});
