import type { Chapter } from '../../domain/types';

export interface FixedDocumentSection {
  readonly id: string;
  readonly title: string;
  readonly startPageIndex: number;
  readonly pageCount: number;
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
