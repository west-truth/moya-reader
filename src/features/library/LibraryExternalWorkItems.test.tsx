import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ExternalWorkCard, ExternalWorkListRow } from './LibraryExternalWorkItems';
import type { LibraryExternalWorkView, LibraryScreenActions } from './library-screen-contract';

const work: LibraryExternalWorkView = {
  id: 'work',
  title: '스트리밍 작품',
  availableReleaseCount: 10,
  readReleaseCount: 3,
  lastReadAt: '2026-09-02T00:00:00.000Z',
  addedAt: '',
  updatedAt: '',
  newReleaseCount: 0,
  thumbnailUrl: 'blob:cover',
};
describe.each([ExternalWorkCard, ExternalWorkListRow])('stream-only library item %s', (Item) => {
  it('shows artwork and 30% progress, and routes the continue action separately from details', async () => {
    const continueExternal = vi.fn();
    const openExternal = vi.fn();
    const actions = {
      books: { continueExternal, openExternal, removeExternal: vi.fn() },
    } as unknown as LibraryScreenActions;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Item work={work} actions={actions} />);
    });
    expect(renderer.root.findAllByProps({ 'aria-label': '스트리밍 작품 라이브러리에서 제거' })).toHaveLength(0);
    expect(renderer.root.findByType('img').props.src).toBe('blob:cover');
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(30);
    await act(async () => renderer.root.findByProps({ 'aria-label': '스트리밍 작품 이어 보기' }).props.onClick());
    expect(continueExternal).toHaveBeenCalledWith(work.id);
    expect(openExternal).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType('img').props.onError());
    expect(renderer.root.findAllByType('img')).toHaveLength(0);
    expect(renderer.root.findByProps({ 'aria-label': '스트리밍 작품 이어 보기' })).toBeTruthy();
    await act(async () =>
      renderer.update(<Item work={{ ...work, lastReadAt: undefined, availableReleaseCount: 0 }} actions={actions} />),
    );
    expect(renderer.root.findByProps({ 'aria-label': '스트리밍 작품 첫 화 보기' }).props.disabled).not.toBe(true);
    await act(async () => renderer.unmount());
  });
});
