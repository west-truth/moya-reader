import { describe, expect, it } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import { createBookWorkspaceTestHarness, testChapter, testNovel } from './book-workspace-test-fixtures';

describe('reading during source imports', () => {
  it('updates available chapters without resetting the current reader or TTS', async () => {
    const first = testChapter(1);
    const updated = testNovel({ activeContentRevisionId: 'new' });
    const h = createBookWorkspaceTestHarness({ novel: updated, chapters: [first, testChapter(2)] });
    const workspace = new BookWorkspaceController(h.ports);
    workspace.replaceSelection({
      selectedNovel: testNovel({ activeContentRevisionId: 'old' }),
      chapters: [first],
      currentChapter: first,
    });
    await workspace.refreshImportedSeries(updated);
    expect(workspace.getSnapshot().chapters).toHaveLength(2);
    expect(workspace.getSnapshot().currentChapter).toBe(first);
    expect(workspace.getSnapshot().selectedNovel).toBe(updated);
    expect(h.calls).toEqual(['repository.listChapters', 'repository.getNovel']);
  });
  it('does not overwrite navigation or a changed active chapter', async () => {
    const first = testChapter(1);
    const novel = testNovel();
    const h = createBookWorkspaceTestHarness({ novel, chapters: [{ ...first, textHash: 'changed' }] });
    const workspace = new BookWorkspaceController(h.ports);
    workspace.replaceSelection({ selectedNovel: novel, chapters: [first], currentChapter: first });
    await workspace.refreshImportedSeries(novel);
    expect(workspace.getSnapshot().chapters).toEqual([first]);
    const pending = workspace.refreshImportedSeries(novel);
    workspace.replaceSelection({ selectedNovel: testNovel({ id: 'other' }), chapters: [] });
    await pending;
    expect(workspace.getSnapshot().selectedNovel?.id).toBe('other');
    expect(workspace.getSnapshot().chapters).toEqual([]);
  });
});
