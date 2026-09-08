import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { testChapter } from '../book-workspace/book-workspace-test-fixtures';
import { useFixedDocumentEntry, useFixedDocumentPageAnchor } from './use-fixed-document-entry';

describe('fixed document explicit entry', () => {
  it('keeps the same page when an earlier release is inserted', () => {
    const go = vi.fn();
    const first = testChapter(1),
      second = testChapter(2);
    function Probe({ earlier = false }) {
      useFixedDocumentPageAnchor('book', earlier ? [first, second] : [second], 0, go);
      return null;
    }
    let root!: ReturnType<typeof create>;
    act(() => {
      root = create(<Probe />);
    });
    act(() => {
      root.update(<Probe earlier />);
    });
    expect(go).toHaveBeenCalledExactlyOnceWith(1);
    act(() => root.unmount());
  });
  it('does not jump after appended chapters, but honors another explicit chapter', () => {
    const go = vi.fn();
    const first = testChapter(1);
    const second = testChapter(2);
    function Probe({
      target,
      appended = false,
      request = 0,
    }: {
      target: string;
      appended?: boolean;
      request?: number;
    }) {
      useFixedDocumentEntry('book', target, appended ? [first, second] : [first], go, request);
      return null;
    }
    let root!: ReturnType<typeof create>;
    act(() => {
      root = create(<Probe target={first.id} />);
    });
    expect(go).toHaveBeenCalledExactlyOnceWith(0);
    go.mockClear();
    act(() => {
      root.update(<Probe target={first.id} appended />);
    });
    expect(go).not.toHaveBeenCalled();
    act(() => {
      root.update(<Probe target={second.id} appended />);
    });
    expect(go).toHaveBeenCalledExactlyOnceWith(1);
    go.mockClear();
    act(() => {
      root.update(<Probe target={second.id} appended request={1} />);
    });
    expect(go).toHaveBeenCalledExactlyOnceWith(1);
    act(() => root.unmount());
  });
});
