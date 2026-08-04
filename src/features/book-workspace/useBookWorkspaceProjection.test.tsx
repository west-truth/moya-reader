import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { BookWorkspaceProjection } from './book-workspace-projection';
import { testChapter, testNovel, testWorkspaceState } from './book-workspace-test-fixtures';
import { useBookWorkspaceProjection } from './useBookWorkspaceProjection';

describe('useBookWorkspaceProjection', () => {
  it('retains library and chapter projections when only reader session state changes', async () => {
    const novel = testNovel();
    const chapter = testChapter(1);
    let state = testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters: [chapter] });
    const annotationCounts = new Map();
    let projection!: BookWorkspaceProjection;
    function Harness() {
      projection = useBookWorkspaceProjection(state, annotationCounts);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const libraryCollection = projection.libraryCollection;
    const chapterList = projection.chapterList;

    state = { ...state, readerProgress: 0.4, readerSessionDisplaySeconds: 12 };
    await act(async () => {
      renderer.update(<Harness />);
    });

    expect(projection.libraryCollection).toBe(libraryCollection);
    expect(projection.chapterList).toBe(chapterList);
    renderer.unmount();
  });
});
