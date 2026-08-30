import { describe, expect, it } from 'vitest';
import type { ChapterStructureChapterView } from '@noveldesk/text-core/chapter-structure';
import {
  buildBoundaryAdditionCommands,
  buildBoundaryRemovalCommands,
  structurePreviewWindow,
} from './chapter-structure-view-model';

function chapter(index: number, title = `${index}화`): ChapterStructureChapterView {
  return {
    id: `chapter_${index}`,
    index,
    title,
    rawStartOffset: (index - 1) * 100,
    rawEndOffset: index * 100,
    paragraphCount: 2,
    characterCount: 90,
    sourcePreview: title,
    splitCandidates: [],
  };
}

describe('chapter structure view model', () => {
  it('removes consecutive boundaries from the end so every original chapter id remains addressable', () => {
    const chapters = [chapter(1), chapter(2), chapter(3), chapter(4)];
    expect(buildBoundaryRemovalCommands(chapters, new Set(['chapter_1', 'chapter_2']))).toEqual([
      { kind: 'merge_next', chapterId: 'chapter_2', titlePolicy: 'first' },
      { kind: 'merge_next', chapterId: 'chapter_1', titlePolicy: 'first' },
    ]);
  });

  it('adds multiple boundaries from the end of each original chapter', () => {
    const chapters = [chapter(1), chapter(2)];
    expect(
      buildBoundaryAdditionCommands(chapters, [
        { chapterId: 'chapter_1', sourceOffset: 20, title: '둘' },
        { chapterId: 'chapter_1', sourceOffset: 60, title: '셋' },
        { chapterId: 'chapter_2', sourceOffset: 120, title: '다음 둘' },
      ]),
    ).toEqual([
      { kind: 'split', chapterId: 'chapter_2', sourceOffset: 120, title: '다음 둘' },
      { kind: 'split', chapterId: 'chapter_1', sourceOffset: 60, title: '셋' },
      { kind: 'split', chapterId: 'chapter_1', sourceOffset: 20, title: '둘' },
    ]);
  });

  it('keeps only the changed area and nearby chapters in a structure preview', () => {
    const before = Array.from({ length: 12 }, (_, index) => chapter(index + 1));
    const after = [...before.slice(0, 5), { ...before[5], title: '변경된 6화' }, ...before.slice(6)];
    const window = structurePreviewWindow(before, after);
    expect(window.before.map((item) => item.index)).toEqual([4, 5, 6, 7, 8]);
    expect(window.after.map((item) => item.index)).toEqual([4, 5, 6, 7, 8]);
    expect(window.hiddenBefore).toBe(7);
  });
});
