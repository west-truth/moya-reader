import type { ChapterStructureChapterView, ChapterStructureCommand } from '@noveldesk/text-core/chapter-structure';

export interface BoundaryAdditionDraft {
  readonly chapterId: string;
  readonly sourceOffset: number;
  readonly title?: string;
}

export interface StructurePreviewWindow {
  readonly before: readonly ChapterStructureChapterView[];
  readonly after: readonly ChapterStructureChapterView[];
  readonly beforeStartIndex: number;
  readonly afterStartIndex: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

function chapterKey(chapter: ChapterStructureChapterView): string {
  return `${chapter.rawStartOffset}:${chapter.rawEndOffset}:${chapter.title}`;
}

export function buildBoundaryRemovalCommands(
  chapters: readonly ChapterStructureChapterView[],
  boundaryChapterIds: ReadonlySet<string>,
): ChapterStructureCommand[] {
  return chapters
    .filter((chapter) => boundaryChapterIds.has(chapter.id) && chapter.index < chapters.length)
    .sort((left, right) => right.index - left.index)
    .map((chapter) => ({ kind: 'merge_next', chapterId: chapter.id, titlePolicy: 'first' }));
}

export function buildBoundaryAdditionCommands(
  chapters: readonly ChapterStructureChapterView[],
  additions: readonly BoundaryAdditionDraft[],
): ChapterStructureCommand[] {
  const chapterIndexes = new Map(chapters.map((chapter) => [chapter.id, chapter.index]));
  return [...additions]
    .filter((addition) => chapterIndexes.has(addition.chapterId))
    .sort((left, right) => {
      const chapterOrder = (chapterIndexes.get(right.chapterId) ?? 0) - (chapterIndexes.get(left.chapterId) ?? 0);
      return chapterOrder || right.sourceOffset - left.sourceOffset;
    })
    .map((addition) => ({
      kind: 'split',
      chapterId: addition.chapterId,
      sourceOffset: addition.sourceOffset,
      title: addition.title?.trim() || undefined,
    }));
}

export function structurePreviewWindow(
  before: readonly ChapterStructureChapterView[],
  after: readonly ChapterStructureChapterView[],
  context = 2,
): StructurePreviewWindow {
  let commonPrefix = 0;
  while (
    commonPrefix < before.length &&
    commonPrefix < after.length &&
    chapterKey(before[commonPrefix]) === chapterKey(after[commonPrefix])
  ) {
    commonPrefix += 1;
  }

  let commonSuffix = 0;
  while (
    commonSuffix < before.length - commonPrefix &&
    commonSuffix < after.length - commonPrefix &&
    chapterKey(before[before.length - 1 - commonSuffix]) === chapterKey(after[after.length - 1 - commonSuffix])
  ) {
    commonSuffix += 1;
  }

  const beforeStartIndex = Math.max(0, commonPrefix - context);
  const afterStartIndex = Math.max(0, commonPrefix - context);
  const beforeEndIndex = Math.min(before.length, before.length - commonSuffix + context);
  const afterEndIndex = Math.min(after.length, after.length - commonSuffix + context);

  return {
    before: before.slice(beforeStartIndex, beforeEndIndex),
    after: after.slice(afterStartIndex, afterEndIndex),
    beforeStartIndex,
    afterStartIndex,
    hiddenBefore: before.length - (beforeEndIndex - beforeStartIndex),
    hiddenAfter: after.length - (afterEndIndex - afterStartIndex),
  };
}
