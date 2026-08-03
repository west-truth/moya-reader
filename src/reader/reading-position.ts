import type { Chapter, Paragraph, ReadingPosition } from '../domain/types';
import { clamp } from '../utils/format';

export interface RestoreReadingPositionTarget {
  canRestore: boolean;
  paragraphIndex?: number;
  paragraphId?: string;
  scrollTop: number;
}

export function resolveRestoreReadingPositionTarget(
  chapter: Chapter,
  position: ReadingPosition | undefined,
  resolvedParagraph?: Paragraph,
): RestoreReadingPositionTarget {
  if (!position || position.chapterId !== chapter.id) {
    return { canRestore: false, scrollTop: 0 };
  }

  if (position.paragraphIndex > 0) {
    return {
      canRestore: true,
      paragraphIndex: clamp(position.paragraphIndex - 1, 0, Math.max(chapter.paragraphCount - 1, 0)),
      paragraphId: position.paragraphId,
      scrollTop: Math.max(0, Math.round(position.scrollTop)),
    };
  }

  if (position.paragraphId && resolvedParagraph?.chapterId === chapter.id) {
    return {
      canRestore: true,
      paragraphIndex: clamp(resolvedParagraph.index - 1, 0, Math.max(chapter.paragraphCount - 1, 0)),
      paragraphId: position.paragraphId,
      scrollTop: Math.max(0, Math.round(position.scrollTop)),
    };
  }

  return {
    canRestore: true,
    paragraphId: position.paragraphId,
    scrollTop: Math.max(0, Math.round(position.scrollTop)),
  };
}
