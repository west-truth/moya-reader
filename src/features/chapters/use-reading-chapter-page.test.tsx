import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReadingChapterPage } from './use-reading-chapter-page';

afterEach(() => vi.unstubAllGlobals());

describe('reading chapter page on entry', () => {
  it('follows late reading state once, preserves browsing, and follows again on a new visit', () => {
    vi.stubGlobal('window', {});
    let result!: ReturnType<typeof useReadingChapterPage>;
    function Probe({ current = -1, count = 0, scope = 'late-reading-fixture' }) {
      result = useReadingChapterPage(scope, current, count, 10);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    expect(result[0]).toBe(1);
    act(() => renderer.update(<Probe count={125} />));
    act(() => renderer.update(<Probe count={125} current={114} />));
    expect(result[0]).toBe(12);
    act(() => result[1](3));
    act(() => renderer.update(<Probe count={140} current={124} />));
    expect(result[0]).toBe(3);
    act(() => renderer.unmount());
    act(() => {
      renderer = create(<Probe count={140} current={124} />);
    });
    expect(result[0]).toBe(13);
    act(() => renderer.update(<Probe count={50} current={22} scope="other-book-fixture" />));
    expect(result[0]).toBe(3);
    act(() => renderer.unmount());
  });

  it('does not hijack a page chosen before reading state arrives', () => {
    let result!: ReturnType<typeof useReadingChapterPage>;
    function Probe({ current }: { current: number }) {
      result = useReadingChapterPage('manual-before-reading', current, 125, 10);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe current={-1} />);
    });
    act(() => result[1](4));
    act(() => renderer.update(<Probe current={114} />));
    expect(result[0]).toBe(4);
    act(() => renderer.unmount());
  });
});
