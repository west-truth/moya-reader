import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testChapter, testNovel } from '../features/book-workspace/book-workspace-test-fixtures';
import { buildChapterListModel } from '../features/chapters/chapters-screen-model';
import { projectLocalSeriesReadingStates } from '../features/external-sources/serial-work-projection';
import { openReaderDb, resetReaderDbForTests } from '../storage/reader-database';
import { transactionDone } from '../storage/indexeddb-transaction';
import { saveReadingPosition, clearReadingPosition } from '../storage/reader-state-store';
import { getChapters, getNovel } from '../storage/reader-query-store';

describe('exact read history for every book format', () => {
  beforeEach(resetReaderDbForTests);
  it.each(['txt', 'epub', 'image_archive'] as const)(
    '%s records 1 and 6 without marking skipped chapters; going back retains 6',
    async (format) => {
      const db = await openReaderDb();
      const novel = testNovel({ format, totalChapters: 6 });
      const chapters = Array.from({ length: 6 }, (_, i) =>
        testChapter(
          i + 1,
          format === 'image_archive'
            ? { documentSectionId: `chapter:${i + 1}`, documentSectionTitle: `${i + 1}화`, documentSectionIndex: i + 1 }
            : {},
        ),
      );
      const tx = db.transaction(['novels', 'chapters'], 'readwrite');
      tx.objectStore('novels').put(novel);
      chapters.forEach((chapter) => tx.objectStore('chapters').put(chapter));
      await transactionDone(tx);
      for (const index of [1, 6, 2]) {
        await saveReadingPosition({
          novelId: novel.id,
          chapterId: chapters[index - 1]!.id,
          chapterProgress: 0.4,
          scrollTop: 10,
          paragraphIndex: 1,
        });
      }
      const saved = await getChapters(novel.id);
      expect(saved.map((chapter) => Boolean(chapter.documentSectionReadAt))).toEqual([
        true,
        true,
        false,
        false,
        false,
        true,
      ]);
      const rows = buildChapterListModel({
        chapters: saved,
        query: '',
        sort: 'asc',
        readFilter: 'read',
        currentChapter: saved[1],
        annotationCounts: new Map(),
      }).rows;
      expect(rows.map((row) => row.chapter.index)).toEqual([1, 2, 6]);
      if (format === 'image_archive') {
        expect([...projectLocalSeriesReadingStates((await getNovel(novel.id))!, saved).values()]).toEqual([
          'read',
          'current',
          'unread',
          'unread',
          'unread',
          'read',
        ]);
      }
      await clearReadingPosition(novel.id);
      expect((await getChapters(novel.id)).some((chapter) => chapter.documentSectionReadAt)).toBe(false);
    },
  );
});
