import { BookDetailHero } from './BookDetailHero';
import { BookManagementDisclosure } from './BookManagementDisclosure';
import { ChapterPanel } from './ChapterPanel';
import type { ChaptersScreenProps } from './chapters-screen-contract';

export type { ChaptersScreenActions, ChaptersScreenModel, ChaptersScreenProps } from './chapters-screen-contract';

export function ChaptersScreen({ model, actions }: ChaptersScreenProps) {
  return (
    <main className="chapters-screen">
      <div className="book-detail-main">
        <BookDetailHero model={model} actions={actions} />
        <BookManagementDisclosure model={model} actions={actions} />
        <ChapterPanel model={model} actions={actions} />
      </div>
    </main>
  );
}
