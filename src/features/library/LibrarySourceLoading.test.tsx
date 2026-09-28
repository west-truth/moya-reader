import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { LibrarySourceLoading } from './LibrarySourceLoading';
import type { LibraryScreenProps } from './library-screen-contract';
afterEach(() => vi.useRealTimers());
it('offers a scoped retry after eight seconds and clears it after the source is ready', () => {
  vi.useFakeTimers();
  const retrySourceLibrary = vi.fn();
  const props = {
    model: { viewMode: 'grid', management: {}, externalSources: { libraryBootstrap: { status: 'loading' } } },
    actions: { header: { retrySourceLibrary } },
  } as unknown as LibraryScreenProps;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LibrarySourceLoading {...props} />);
  });
  expect(renderer.root.findAllByType('button')).toHaveLength(0);
  act(() => {
    vi.advanceTimersByTime(8000);
  });
  act(() => renderer.root.findByType('button').props.onClick());
  expect(retrySourceLibrary).toHaveBeenCalledOnce();
  act(() =>
    renderer.update(
      <LibrarySourceLoading
        {...props}
        model={{
          ...props.model,
          externalSources: { ...props.model.externalSources, libraryBootstrap: { status: 'ready' } },
        }}
      />,
    ),
  );
  expect(renderer.toJSON()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  act(() => renderer.unmount());
});
