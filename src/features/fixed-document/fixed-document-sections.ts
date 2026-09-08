import type { Chapter } from '../../domain/types';

export interface FixedDocumentSection {
  readonly id: string;
  readonly title: string;
  readonly startPageIndex: number;
  readonly pageCount: number;
}

export interface FixedDocumentSeekWindow {
  readonly startPageIndex: number;
  readonly pageCount: number;
  readonly pageNumber: number;
  readonly progressPercent: number;
}

function legacySectionTitle(chapterTitle: string): string | undefined {
  const match = /^(.*?)\s*·\s*[1-9][0-9]*페이지$/u.exec(chapterTitle.trim());
  return match?.[1]?.trim() || undefined;
}

function titleKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

export function projectFixedDocumentSections(
  novelId: string,
  chapters: readonly Chapter[],
): readonly FixedDocumentSection[] {
  const sections: Array<FixedDocumentSection & { readonly explicitId?: string; readonly titleKey: string }> = [];

  chapters.forEach((chapter, pageIndex) => {
    const title = chapter.documentSectionTitle?.trim() || legacySectionTitle(chapter.title);
    if (!title) return;
    const normalizedTitle = titleKey(title);
    const current = sections.at(-1);
    const continuesExplicitSection = Boolean(
      chapter.documentSectionId && current?.explicitId === chapter.documentSectionId,
    );
    const continuesLegacySection = Boolean(
      !chapter.documentSectionId &&
      !current?.explicitId &&
      current?.titleKey === normalizedTitle &&
      chapter.documentPageIndexInSection !== 1,
    );

    if (current && (continuesExplicitSection || continuesLegacySection)) {
      sections[sections.length - 1] = { ...current, pageCount: current.pageCount + 1 };
      return;
    }

    sections.push({
      id:
        chapter.documentSectionId ??
        `legacy-document-section:${novelId}:${chapter.documentSectionIndex ?? 'unknown'}:${pageIndex}`,
      title,
      titleKey: normalizedTitle,
      explicitId: chapter.documentSectionId,
      startPageIndex: pageIndex,
      pageCount: 1,
    });
  });

  return sections.map(({ explicitId: _explicitId, titleKey: _titleKey, ...section }) => section);
}

export function fixedDocumentSeekWindow(
  totalPages: number,
  pageIndex: number,
  section?: Pick<FixedDocumentSection, 'startPageIndex' | 'pageCount'>,
): FixedDocumentSeekWindow {
  const normalizedTotal = Math.max(0, Math.trunc(totalPages));
  const requestedStart = Math.max(0, Math.trunc(section?.startPageIndex ?? 0));
  const startPageIndex = Math.min(requestedStart, Math.max(0, normalizedTotal - 1));
  const requestedCount = Math.max(0, Math.trunc(section?.pageCount ?? normalizedTotal));
  const pageCount = Math.min(requestedCount, Math.max(0, normalizedTotal - startPageIndex));
  const pageOffset = pageCount > 0 ? Math.min(pageCount - 1, Math.max(0, Math.trunc(pageIndex) - startPageIndex)) : 0;
  const pageNumber = pageCount > 0 ? pageOffset + 1 : 1;

  return {
    startPageIndex,
    pageCount,
    pageNumber,
    progressPercent: pageCount > 0 ? (pageNumber / pageCount) * 100 : 0,
  };
}
