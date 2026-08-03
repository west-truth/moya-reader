import type { Bookmark, Chapter, ReaderHighlight, ReaderNote } from '../../domain/types';
import type { ReadingPosition } from '../../sync/types';
import type { AnnotationReaderPort, AnnotationRepository } from './annotation-contract';

export type AnnotationNavigationTarget =
  | { readonly kind: 'bookmark'; readonly item: Bookmark }
  | { readonly kind: 'highlight'; readonly item: ReaderHighlight }
  | { readonly kind: 'note'; readonly item: ReaderNote };

export async function navigateToAnnotation(input: {
  readonly target: AnnotationNavigationTarget;
  readonly novelId: string;
  readonly currentChapterId?: string;
  readonly chapters: readonly Chapter[];
  readonly repository: Pick<AnnotationRepository, 'getChapter' | 'getParagraph'>;
  readonly reader: Pick<AnnotationReaderPort, 'scrollToParagraph' | 'scrubTo'>;
  readonly openChapter: (chapter: Chapter, position: ReadingPosition) => Promise<void>;
  readonly now?: () => string;
  readonly schedule?: (callback: () => void, delayMs: number) => void;
}): Promise<boolean> {
  const { item } = input.target;
  if (item.chapterId === input.currentChapterId) {
    if (item.paragraphId && (await input.reader.scrollToParagraph(item.paragraphId))) return true;
    await input.reader.scrubTo(item.progress);
    return true;
  }

  const chapter =
    input.chapters.find((candidate) => candidate.id === item.chapterId) ??
    (await input.repository.getChapter(item.chapterId));
  if (!chapter) return false;
  const paragraph = item.paragraphId ? await input.repository.getParagraph(item.paragraphId) : undefined;
  const paragraphIndex = paragraph?.chapterId === item.chapterId ? paragraph.index : 0;
  const position: ReadingPosition = {
    id: `${input.target.kind}_position_${item.id}`,
    novelId: input.novelId,
    chapterId: item.chapterId,
    paragraphId: item.paragraphId,
    paragraphIndex,
    offsetInParagraph: 0,
    chapterProgress: item.progress,
    scrollTop: input.target.kind === 'bookmark' ? input.target.item.scrollTop : 0,
    deviceId: input.target.kind,
    updatedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
  await input.openChapter(chapter, position);
  if (input.target.kind === 'note' && !item.paragraphId) {
    (input.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)))(
      () => void input.reader.scrubTo(item.progress),
      90,
    );
  }
  return true;
}
