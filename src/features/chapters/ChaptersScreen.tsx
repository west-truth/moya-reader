import { BookDetailHero } from './BookDetailHero';
import { useRef } from 'react';
import { useNavigationScroll } from '../navigation/navigation-view-state';
import { BookManagementDisclosure } from './BookManagementDisclosure';
import { ChapterPanel } from './ChapterPanel';
import type { ChaptersScreenProps } from './chapters-screen-contract';

export type { ChaptersScreenActions, ChaptersScreenModel, ChaptersScreenProps } from './chapters-screen-contract';

export function ChaptersScreen({ model, actions }: ChaptersScreenProps) {
  const scrollRef = useRef<HTMLElement>(null);
  useNavigationScroll(scrollRef, `chapters:${model.book.novel.id}`);
  return (
    <main ref={scrollRef} className="chapters-screen">
      <div className="book-detail-main">
        <BookDetailHero model={model} actions={actions} />
        <BookManagementDisclosure model={model} actions={actions} />
        <ChapterPanel model={model} actions={actions} />
      </div>
    </main>
  );
}
