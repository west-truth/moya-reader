import { describe, expect, it, vi } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import { continueLibraryBook, openLibraryBook, returnToSourceSeriesDetails } from './book-workspace-source-navigation';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testWorkspaceState,
} from './book-workspace-test-fixtures';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

function sourceState(
  bookId: string,
  linked: boolean,
): Pick<ExternalSourceController, 'linkedSeriesBookIds' | 'libraryWorks' | 'showLocalSeries' | 'close'> {
  return {
    libraryWorks: [],
    linkedSeriesBookIds: new Set(linked ? [bookId] : []),
    showLocalSeries: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

describe('Library source-series navigation', () => {
  it.each(['txt', 'image_archive'] as const)(
    'closes the SourceHub back layer before continuing a %s book',
    async (format) => {
      const novel = testNovel({ format, documentSectionCount: 2 });
      const harness = createBookWorkspaceTestHarness({ novel });
      const workspace = new BookWorkspaceController(harness.ports);
      const sources = sourceState(novel.id, true);
      sources.close = vi.fn(() => {
        harness.calls.push('source.close');
      });
      await continueLibraryBook(novel, workspace, sources);
      expect(harness.calls[0]).toBe('source.close');
      expect(sources.close).toHaveBeenCalledOnce();
      expect(workspace.getSnapshot()).toMatchObject({
        selectedNovel: novel,
        view: format === 'txt' ? 'reader' : 'document',
        currentChapter: expect.objectContaining({ id: 'chapter-1' }),
      });
    },
  );

  it.each([
    {
      name: 'directly downloaded TXT series without a subscription',
      format: 'txt' as const,
      sections: 2,
      linked: true,
      sourceDetail: true,
    },
    { name: 'unlinked TXT series', format: 'txt' as const, sections: 2, linked: false, sourceDetail: false },
    { name: 'single TXT', format: 'txt' as const, sections: undefined, linked: false, sourceDetail: false },
    { name: 'ordinary linked TXT', format: 'txt' as const, sections: undefined, linked: true, sourceDetail: false },
    { name: 'local comic', format: 'image_archive' as const, sections: undefined, linked: false, sourceDetail: true },
  ])('opens $name in the appropriate detail screen', async ({ format, sections, linked, sourceDetail }) => {
    const novel = testNovel({ format, documentSectionCount: sections });
    const oldNovel = testNovel({ id: 'old-book' });
    const harness = createBookWorkspaceTestHarness({ novel });
    const workspace = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        view: 'library',
        selectedNovel: oldNovel,
        currentChapter: testChapter(1, { novelId: oldNovel.id }),
      }),
    );
    const sources = sourceState(novel.id, linked);
    expect(sources.libraryWorks).toEqual([]);
    await openLibraryBook(novel, workspace, sources);
    if (sourceDetail) {
      expect(sources.showLocalSeries).toHaveBeenCalledWith(novel);
      expect(sources.close).not.toHaveBeenCalled();
      expect(harness.calls).not.toContain('repository.listChapters');
      expect(workspace.getSnapshot()).toMatchObject({ view: 'library', selectedNovel: novel, chapters: [] });
      expect(workspace.getSnapshot().currentChapter).toBeUndefined();
    } else {
      expect(sources.showLocalSeries).not.toHaveBeenCalled();
      expect(sources.close).toHaveBeenCalledOnce();
      expect(harness.calls).toContain('repository.listChapters');
      expect(workspace.getSnapshot()).toMatchObject({ view: 'chapters', selectedNovel: novel });
    }
  });

  it.each([true, false])(
    'flushes Reader progress before returning a linked=%s TXT to its chapter screen',
    async (linked) => {
      const novel = testNovel({ format: 'txt', documentSectionCount: linked ? 2 : undefined });
      const harness = createBookWorkspaceTestHarness({ novel });
      const workspace = new BookWorkspaceController(
        harness.ports,
        testWorkspaceState({ view: 'reader', selectedNovel: novel }),
      );
      const sources = sourceState(novel.id, linked);
      sources.showLocalSeries = vi.fn(async () => {
        expect(harness.calls).toEqual([
          'transition.stopReaderTTS',
          'transition.flushReaderSession',
          'repository.getNovel',
        ]);
      });
      await returnToSourceSeriesDetails(workspace, sources);
      expect(workspace.getSnapshot().view).toBe(linked ? 'library' : 'chapters');
      expect(sources.showLocalSeries).toHaveBeenCalledTimes(linked ? 1 : 0);
    },
  );

  it.each(['another-book', 'same-book-navigation'])(
    'does not reopen source details after %s supersedes a delayed Reader flush',
    async (target) => {
      const novel = testNovel({ format: 'txt', documentSectionCount: 2 });
      const harness = createBookWorkspaceTestHarness({ novel });
      let finish!: () => void;
      harness.ports.transition.flushReaderSession = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const workspace = new BookWorkspaceController(
        harness.ports,
        testWorkspaceState({ view: 'reader', selectedNovel: novel }),
      );
      const sources = sourceState(novel.id, true);
      const returning = returnToSourceSeriesDetails(workspace, sources);
      const newer = target === 'another-book' ? testNovel({ id: 'new-book' }) : novel;
      workspace.replaceSelection({ selectedNovel: newer });
      workspace.setView('chapters');
      finish();
      await returning;
      expect(workspace.getSnapshot()).toMatchObject({ view: 'chapters', selectedNovel: newer });
      expect(sources.showLocalSeries).not.toHaveBeenCalled();
    },
  );
});
