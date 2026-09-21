import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscoveryCard } from './DiscoveryCard';
import type { DiscoverySession } from './discovery-session';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(cover: ReturnType<typeof vi.fn>, viewMode: 'grid' | 'text' = 'grid') {
  vi.useFakeTimers();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const key = { connectorId: 'source', remoteId: 'work' };
  await act(async () => {
    renderer = create(
      <DiscoveryCard
        viewMode={viewMode}
        item={{ key, coverRef: key, title: 'Work', kind: 'work', importability: 'supported' }}
        session={{ cover } as unknown as DiscoverySession}
        open={() => undefined}
        inLibrary={false}
      />,
      { createNodeMock: () => ({}) },
    );
  });
}
it('recovers a visible cover after a transient failure without navigation', async () => {
  const cover = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValue('blob:restored');
  await mount(cover);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(cover).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findByType('img').props.src).toBe('blob:restored');
});
it('bounds retries and cancels them when a card is removed', async () => {
  const cover = vi.fn().mockRejectedValue(new Error('network error'));
  await mount(cover);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(cover).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(cover).toHaveBeenCalledTimes(3);
  act(() => renderer!.unmount());
  renderer = undefined;
  cover.mockClear();
  await mount(cover);
  act(() => renderer!.unmount());
  renderer = undefined;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(cover).toHaveBeenCalledTimes(1);
});
it('does not retry denied access', async () => {
  const cover = vi.fn().mockRejectedValue(new Error('source_access_denied'));
  await mount(cover);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(cover).toHaveBeenCalledTimes(1);
});

it('does not resolve or mount covers in text view, and resumes when covers are enabled', async () => {
  const cover = vi.fn().mockResolvedValue('blob:cover');
  await mount(cover, 'text');
  expect(cover).not.toHaveBeenCalled();
  expect(renderer!.root.findAllByType('img')).toHaveLength(0);
  const props = renderer!.root.findByType(DiscoveryCard).props as ComponentProps<typeof DiscoveryCard>;
  await act(async () => {
    renderer!.update(<DiscoveryCard {...props} viewMode="grid" />);
  });
  expect(cover).toHaveBeenCalledOnce();
  expect(renderer!.root.findByType('img').props.src).toBe('blob:cover');
  await act(async () => {
    renderer!.update(<DiscoveryCard {...props} viewMode="text" />);
  });
  expect(cover.mock.calls[0]![1].aborted).toBe(true);
  expect(renderer!.root.findAllByType('img')).toHaveLength(0);
});
