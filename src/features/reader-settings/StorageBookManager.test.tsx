import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import { StorageBookManager } from './StorageBookManager';

const usage = {
  totalBytes: 300,
  libraryBytes: 300,
  trashBytes: 0,
  books: [
    { id: 'a', title: 'A', metadataRevision: 4, trashed: false, bytes: 100 },
    { id: 'b', title: 'B', metadataRevision: 9, trashed: false, bytes: 200 },
    { id: 'c', title: 'C', metadataRevision: 2, trashed: true, bytes: 0 },
  ],
};
let root: ReactTestRenderer;
afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
});
const button = (text: string) => root.root.findAllByType('button').find((b) => b.children.includes(text))!;
function setup(blocked = false) {
  const catalog = {
    moveToTrash: vi.fn().mockResolvedValue({}),
    restore: vi.fn().mockResolvedValue({}),
    purge: vi.fn().mockResolvedValue(undefined),
  };
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', { confirm: vi.fn(() => true) });
  act(() => {
    root = create(
      <StorageBookManager
        usage={usage}
        management={{ catalog: catalog as unknown as LibraryCatalogRepository, blocked, onChanged }}
        refresh={refresh}
        onBack={vi.fn()}
      />,
    );
  });
  return { catalog, onChanged, refresh };
}

describe('storage work management', () => {
  it('only trashes selected books with revision checks; partial failure refreshes the library', async () => {
    const { catalog, onChanged, refresh } = setup();
    catalog.moveToTrash.mockRejectedValueOnce(new Error('revision changed'));
    act(() => root.root.findAllByProps({ type: 'checkbox' })[0].props.onChange({ target: { checked: true } }));
    await act(async () => {
      await button('휴지통 이동').props.onClick();
    });
    expect(catalog.moveToTrash).toHaveBeenCalledExactlyOnceWith('b', 9);
    expect(catalog.purge).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(root.toJSON())).toContain('1개 미처리');
  });
  it('clears selection on search and only offers permanent removal in trash after confirmation', async () => {
    const { catalog } = setup();
    act(() => root.root.findAllByProps({ type: 'checkbox' })[0].props.onChange({ target: { checked: true } }));
    act(() => root.root.findByProps({ type: 'search' }).props.onChange({ target: { value: 'A' } }));
    expect(button('휴지통 이동')).toBeUndefined();
    act(() => {
      root.root.findByProps({ type: 'search' }).props.onChange({ target: { value: '' } });
      button('휴지통').props.onClick();
    });
    act(() => root.root.findAllByProps({ type: 'checkbox' })[0].props.onChange({ target: { checked: true } }));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => {
      await button('영구 삭제').props.onClick();
    });
    expect(catalog.purge).not.toHaveBeenCalled();
    await act(async () => {
      await button('영구 삭제').props.onClick();
    });
    expect(catalog.purge).toHaveBeenCalledExactlyOnceWith('c', 2);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('원본과 독서 기록'));
  });
  it('blocks destructive actions during reading or imports even when invoked directly', async () => {
    const { catalog } = setup(true);
    act(() => root.root.findAllByProps({ type: 'checkbox' })[0].props.onChange({ target: { checked: true } }));
    await act(async () => {
      await button('휴지통 이동').props.onClick();
    });
    expect(catalog.moveToTrash).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
