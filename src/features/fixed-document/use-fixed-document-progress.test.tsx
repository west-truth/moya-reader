import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { useFixedDocumentProgress } from './use-fixed-document-progress';

describe('fixed document progress persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('flushes a pending read before back navigation and does not save it twice on unmount', async () => {
    const save = vi.fn();
    let flush!: () => Promise<void>;
    let page = 0;
    let novel = testNovel({ format: 'image_archive' });
    const chapters = [testChapter(1), testChapter(2)];
    function Harness() {
      flush = useFixedDocumentProgress(page, chapters[page], novel, save);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    page = 1;
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      await flush();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(1, chapters[1], novel);
    novel = { ...novel, lastReadChapterId: chapters[1]!.id };
    await act(async () => {
      renderer.update(<Harness />);
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      renderer.unmount();
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it('serializes saves and captures the original book before an in-flight save finishes', async () => {
    let finishFirst!: () => void;
    const save = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const original = testNovel({ format: 'image_archive' });
    let novel = original;
    let page = 0;
    function Harness() {
      useFixedDocumentProgress(page, testChapter(page + 1), novel, save);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await vi.advanceTimersByTimeAsync(350);
    });
    page = 5;
    await act(async () => {
      renderer.update(<Harness />);
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(save).toHaveBeenCalledOnce();
    novel = testNovel({ id: 'other-book', format: 'image_archive' });
    await act(async () => {
      renderer.update(<Harness />);
    });
    await act(async () => {
      finishFirst();
    });
    expect(save.mock.calls[1]?.[2]).toBe(original);
    await act(async () => {
      renderer.unmount();
    });
    expect(save.mock.calls[2]?.[2]).toBe(novel);
  });
});
