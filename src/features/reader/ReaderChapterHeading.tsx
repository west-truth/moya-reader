import type { Chapter } from '../../domain/types';

export function chapterSequenceLabel(chapter: Pick<Chapter, 'index'>): string {
  return `제 ${chapter.index}화`;
}

export type ReaderChapterHeadingData = Pick<Chapter, 'index' | 'title' | 'documentSectionId' | 'documentSectionTitle'>;

export function showChapterSequence(chapter: Pick<Chapter, 'documentSectionId' | 'documentSectionTitle'>): boolean {
  return !chapter.documentSectionId && !chapter.documentSectionTitle;
}

export function ReaderChapterHeading({ chapter }: { readonly chapter: ReaderChapterHeadingData }) {
  return (
    <header className="reader-chapter-heading" data-reader-chapter-heading>
      {showChapterSequence(chapter) && <p className="chapter-kicker">{chapterSequenceLabel(chapter)}</p>}
      <h1>{chapter.title}</h1>
    </header>
  );
}
