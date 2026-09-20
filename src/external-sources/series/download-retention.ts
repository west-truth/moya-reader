import type { Chapter, Novel } from '../../domain/types';

export type RetainedReadCount = 5 | 10 | 20;

/** Only explicit completion markers count; a jump to a later chapter is not reading. */
export function retentionCandidates(novel: Novel, chapters: readonly Chapter[], keep: RetainedReadCount): string[] {
  if (novel.deletedAt || novel.favorite || !novel.activeContentRevisionId) return [];
  const ordered = [...chapters].sort((a, b) => a.index - b.index);
  const current =
    ordered.find((chapter) => chapter.id === novel.lastReadChapterId) ??
    ordered.find((chapter) => chapter.index === novel.lastReadChapterIndex);
  const sections = new Map<string, boolean>();
  for (const chapter of ordered) {
    const id = chapter.documentSectionId;
    if (!id) continue;
    sections.set(id, Boolean(chapter.documentSectionReadAt) || Boolean(sections.get(id)));
  }
  const read = [...sections].filter(([, completed]) => completed).map(([id]) => id);
  return read.slice(0, Math.max(0, read.length - keep)).filter((id) => id !== current?.documentSectionId);
}
