import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useDownloadSelectionFocus } from './use-download-selection-focus';

it('waits for the requested work and mounted chapter picker, and focuses it only once', async () => {
  const focus = vi.fn();
  const scrollIntoView = vi.fn();
  const panel = { scrollIntoView, querySelector: () => ({ focus }) };
  let mounted = false;
  const root = {
    current: { querySelector: () => (mounted ? panel : null) },
  } as unknown as React.RefObject<HTMLElement>;
  const request = { workId: 'work', sequence: 1 };
  function Harness({ workId, loading, count }: { workId: string; loading: boolean; count: number }) {
    useDownloadSelectionFocus(root, request, workId, loading, count);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness workId="previous" loading={false} count={5} />);
  });
  expect(focus).not.toHaveBeenCalled();
  await act(async () => renderer.update(<Harness workId="work" loading count={0} />));
  expect(focus).not.toHaveBeenCalled();
  mounted = true;
  await act(async () => renderer.update(<Harness workId="work" loading={false} count={10} />));
  await act(async () => renderer.update(<Harness workId="work" loading={false} count={20} />));
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  await act(async () => renderer.unmount());
});
