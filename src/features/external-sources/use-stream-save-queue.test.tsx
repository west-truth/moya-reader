import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useStreamSaveQueue } from './use-stream-save-queue';

describe('stream save admission', () => {
  it('keeps requests across busy transitions, deduplicates, and continues after failure', async () => {
    let queue!: ReturnType<typeof useStreamSaveQueue<string>>;
    const save = vi.fn(async (item: string) => {
      if (item === 'first') throw new Error('offline');
    });
    function Probe({ busy }: { busy: boolean }) {
      queue = useStreamSaveQueue({ key: (item: string) => item, ready: () => !busy, save });
      return null;
    }
    let root!: ReturnType<typeof create>;
    act(() => {
      root = create(<Probe busy />);
    });
    const first = queue.enqueue('first');
    const failure = first.catch((error) => error.message);
    expect(queue.enqueue('first')).toBe(first);
    const second = queue.enqueue('second');
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      root.update(<Probe busy={false} />);
    });
    await act(async () => {
      await second;
    });
    expect(await failure).toBe('offline');
    expect(save.mock.calls.map(([item]) => item)).toEqual(['first', 'second']);
    act(() => root.unmount());
  });

  it('cancels queued requests before they can start on a later render', async () => {
    let queue!: ReturnType<typeof useStreamSaveQueue<string>>;
    const save = vi.fn(async () => {});
    function Probe({ busy }: { busy: boolean }) {
      queue = useStreamSaveQueue({ key: (item: string) => item, ready: () => !busy, save });
      return null;
    }
    let root!: ReturnType<typeof create>;
    act(() => {
      root = create(<Probe busy />);
    });
    const result = queue.enqueue('next').catch((error) => error.name);
    act(() => queue.cancel());
    await act(async () => {
      root.update(<Probe busy={false} />);
    });
    expect(await result).toBe('AbortError');
    expect(save).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
