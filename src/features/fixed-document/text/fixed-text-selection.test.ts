import { describe, expect, it } from 'vitest';
import type { DocumentTextBlock } from '../../../domain/types';
import { buildFixedTextSelection } from './fixed-text-selection';

function block(id: string, order: number, text: string, direction: DocumentTextBlock['direction'] = 'ltr') {
  return {
    id,
    revisionId: 'revision',
    bookId: 'book',
    pageIndex: 0,
    order,
    role: 'paragraph',
    text,
    normalizedText: text.toLowerCase(),
    quads: [{ x: 0.1, y: 0.1 + order * 0.1, width: 0.8, height: 0.05 }],
    direction,
  } satisfies DocumentTextBlock;
}

describe('fixed PDF text selection', () => {
  it('preserves exact ranges and quads across multiple blocks', () => {
    const result = buildFixedTextSelection({
      blocks: [block('a', 0, '첫 문단'), block('b', 1, '두 번째 문단'), block('c', 2, '마지막 문단')],
      startBlockId: 'a',
      startOffset: 2,
      endBlockId: 'c',
      endOffset: 3,
    });

    expect(result?.quote).toBe('문단\n두 번째 문단\n마지막');
    expect(result?.ranges.map((range) => [range.block.id, range.startOffset, range.endOffset])).toEqual([
      ['a', 2, 4],
      ['b', 0, 7],
      ['c', 0, 3],
    ]);
    expect(result?.quads).toHaveLength(3);
  });

  it('normalizes a backwards range within one block', () => {
    const result = buildFixedTextSelection({
      blocks: [block('a', 0, 'abcdef')],
      startBlockId: 'a',
      startOffset: 5,
      endBlockId: 'a',
      endOffset: 2,
    });
    expect(result?.quote).toBe('cde');
    expect(result?.ranges[0]).toMatchObject({ startOffset: 2, endOffset: 5 });
  });
});
