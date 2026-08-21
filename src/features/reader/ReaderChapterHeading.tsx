import type { Chapter } from '../../domain/types';

export function chapterSequenceLabel(chapter: Pick<Chapter, 'index'>): string {
  return `제 ${chapter.index}화`;
}

export function ReaderChapterHeading({ chapter }: { readonly chapter: Pick<Chapter, 'index' | 'title'> }) {
  return (
    <header className="reader-chapter-heading" data-reader-chapter-heading>
      <p className="chapter-kicker">{chapterSequenceLabel(chapter)}</p>
      <h1>{chapter.title}</h1>
    </header>
  );
}
