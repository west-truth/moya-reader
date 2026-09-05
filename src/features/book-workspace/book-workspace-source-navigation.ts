import type { Novel } from '../../domain/types';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { BookWorkspaceController } from './book-workspace-controller';

export function shouldOpenSourceSeriesDetails(novel: Novel, linkedSeriesBookIds: ReadonlySet<string>): boolean {
  return (
    novel.format === 'image_archive' ||
    (novel.format === 'txt' && (novel.documentSectionCount ?? 0) > 0 && linkedSeriesBookIds.has(novel.id))
  );
}

export async function openLibraryBook(
  novel: Novel,
  workspace: Pick<BookWorkspaceController, 'replaceSelection' | 'setView' | 'openNovel'>,
  sources: Pick<ExternalSourceController, 'linkedSeriesBookIds' | 'showLocalSeries' | 'close'>,
): Promise<void> {
  if (shouldOpenSourceSeriesDetails(novel, sources.linkedSeriesBookIds)) {
    workspace.replaceSelection({
      selectedNovel: novel,
      chapters: [],
      currentChapter: undefined,
      localReadingPosition: undefined,
      remoteReadingPosition: undefined,
    });
    workspace.setView('library');
    await sources.showLocalSeries(novel);
    return;
  }
  sources.close();
  await workspace.openNovel(novel);
}

export async function returnToSourceSeriesDetails(
  workspace: Pick<BookWorkspaceController, 'returnToChaptersAndThen' | 'setView'>,
  sources: Pick<ExternalSourceController, 'linkedSeriesBookIds' | 'showLocalSeries'>,
): Promise<void> {
  await workspace.returnToChaptersAndThen(async (novel) => {
    if (!shouldOpenSourceSeriesDetails(novel, sources.linkedSeriesBookIds)) return;
    workspace.setView('library');
    await sources.showLocalSeries(novel);
  });
}

export async function continueLibraryBook(
  novel: Novel,
  workspace: Pick<BookWorkspaceController, 'continueReading'>,
  sources: Pick<ExternalSourceController, 'close'>,
): Promise<void> {
  sources.close();
  await workspace.continueReading(novel);
}
