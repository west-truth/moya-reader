import { useMemo } from 'react';
import type { ChapterAnnotationCounts } from '../chapters/chapters-screen-model';
import type { BookWorkspaceState } from './book-workspace-contract';
import {
  buildBookWorkspaceChapterProjection,
  buildBookWorkspaceLibraryProjection,
  buildBookWorkspaceReaderProjection,
  buildBookWorkspaceReadingProjection,
  type BookWorkspaceProjection,
} from './book-workspace-projection';

export function useBookWorkspaceProjection(
  state: BookWorkspaceState,
  annotationCounts: ReadonlyMap<string, ChapterAnnotationCounts>,
): BookWorkspaceProjection {
  const {
    chapterQuery,
    chapterReadFilter,
    chapterSort,
    chapters,
    currentChapter,
    libraryFilter,
    libraryQuery,
    librarySort,
    localReadingPosition,
    novels,
    outlineQuery,
    readerProgress,
    readerSessionCommittedSeconds,
    readerSessionDisplaySeconds,
    selectedNovel,
  } = state;
  const reading = useMemo(
    () => buildBookWorkspaceReadingProjection({ chapters, localReadingPosition, selectedNovel }),
    [chapters, localReadingPosition, selectedNovel],
  );
  const library = useMemo(
    () => buildBookWorkspaceLibraryProjection({ libraryFilter, libraryQuery, librarySort, novels, selectedNovel }),
    [libraryFilter, libraryQuery, librarySort, novels, selectedNovel],
  );
  const chapter = useMemo(
    () =>
      buildBookWorkspaceChapterProjection(
        { chapterQuery, chapterReadFilter, chapterSort, chapters, outlineQuery },
        annotationCounts,
        reading,
      ),
    [annotationCounts, chapterQuery, chapterReadFilter, chapterSort, chapters, outlineQuery, reading],
  );
  const reader = useMemo(
    () =>
      buildBookWorkspaceReaderProjection({
        currentChapter,
        localReadingPosition,
        readerProgress,
        readerSessionCommittedSeconds,
        readerSessionDisplaySeconds,
        selectedNovel,
      }),
    [
      currentChapter,
      localReadingPosition,
      readerProgress,
      readerSessionCommittedSeconds,
      readerSessionDisplaySeconds,
      selectedNovel,
    ],
  );
  return useMemo(() => ({ ...reading, ...library, ...chapter, ...reader }), [reading, library, chapter, reader]);
}
