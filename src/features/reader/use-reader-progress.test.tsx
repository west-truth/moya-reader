import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { ReaderLocationSnapshot } from './reader-screen-contract';
import { SerializedProgressPersistence } from './reader-progress-controller';
import { useReaderPositionPersistence, useReaderProgress } from './use-reader-progress';

const chapter: Chapter = {
  id: 'chapter',
  novelId: 'book',
  index: 1,
  title: '본문',
  normalizedText: '',
  textHash: 'fixture',
  rawStartOffset: 0,
  rawEndOffset: 100,
  characterCount: 100,
  paragraphCount: 10,
  createdAt: '',
  updatedAt: '',
};
const location = (index: number): ReaderLocationSnapshot => ({
  progress: index / 10,
  scrollTop: index * 100,
  paragraphIndex: index,
  ttsIndex: index - 1,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
    cancelAnimationFrame: clearTimeout,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reader position ownership', () => {
  function harness(saveReadingPosition = vi.fn<ReaderRepository['saveReadingPosition']>(async () => undefined)) {
    const shared = new SerializedProgressPersistence();
    const repository = { saveReadingPosition } as unknown as ReaderRepository;
    const committed = vi.fn();
    let scroll!: ReturnType<typeof useReaderPositionPersistence>;
    let paginated!: ReturnType<typeof useReaderPositionPersistence>;
    function Probe({ flow }: { flow: 'scroll' | 'paginated' }) {
      const options = {
        repository,
        chapter,
        novel: { id: 'book', totalChapters: 1 },
        positionPersistence: shared,
        onLocationCommitted: committed,
        onPersistenceFailed: vi.fn(),
      };
      scroll = useReaderPositionPersistence({ ...options, isActive: flow === 'scroll' });
      paginated = useReaderPositionPersistence({ ...options, isActive: flow === 'paginated' });
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe flow="scroll" />);
    });
    return {
      shared,
      saveReadingPosition,
      committed,
      scroll: () => scroll,
      paginated: () => paginated,
      setFlow: (flow: 'scroll' | 'paginated') => act(() => renderer.update(<Probe flow={flow} />)),
      unmount: () => act(() => renderer.unmount()),
    };
  }

  it('cancels the old debounce on a mode switch and ignores hidden scheduling', async () => {
    const h = harness();
    h.scroll().schedule(location(2));
    h.setFlow('paginated');
    h.scroll().schedule(location(3));
    h.paginated().schedule(location(8), 12);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(h.saveReadingPosition).toHaveBeenCalledTimes(1);
    expect(h.saveReadingPosition).toHaveBeenCalledWith(
      expect.objectContaining({ paragraphIndex: 8, offsetInParagraph: 12 }),
    );
    h.unmount();
  });

  it('lets an in-flight old write settle before the new owner writes', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: number[] = [];
    const save = vi.fn(async (input: Parameters<ReaderRepository['saveReadingPosition']>[0]) => {
      if (input.paragraphIndex === 2) await first;
      writes.push(input.paragraphIndex);
    });
    const h = harness(save);
    h.scroll().schedule(location(2));
    const oldWrite = h.scroll().flush();
    await act(async () => {
      await Promise.resolve();
    });
    h.setFlow('paginated');
    h.paginated().schedule(location(8));
    const newWrite = h.paginated().flush();
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await Promise.all([oldWrite, newWrite]);
    });
    expect(writes).toEqual([2, 8]);
    expect(h.committed).toHaveBeenCalledTimes(1);
    expect(h.committed).toHaveBeenCalledWith(location(8), 0.8, expect.any(String));
    h.unmount();
  });

  it('does not revive an old queued write when its viewport becomes active again', async () => {
    const h = harness();
    let release!: () => void;
    const blocker = h.shared.enqueue(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    h.scroll().schedule(location(2));
    const obsolete = h.scroll().flush();
    h.setFlow('paginated');
    h.setFlow('scroll');
    h.scroll().schedule(location(4));
    const latest = h.scroll().flush();
    await act(async () => {
      release();
      await Promise.all([blocker, obsolete, latest]);
    });
    expect(h.saveReadingPosition).toHaveBeenCalledTimes(1);
    expect(h.saveReadingPosition).toHaveBeenCalledWith(expect.objectContaining({ paragraphIndex: 4 }));
    h.unmount();
  });

  it('still flushes the active position at unmount', async () => {
    const h = harness();
    h.scroll().schedule(location(6));
    h.unmount();
    await h.shared.settled();
    expect(h.saveReadingPosition).toHaveBeenCalledWith(expect.objectContaining({ paragraphIndex: 6 }));
  });

  it('drops a pending visual frame and avoids even reading the hidden scroll geometry', async () => {
    const getVisibleParagraph = vi.fn(() => ({ index: 0 }));
    const onVisualLocation = vi.fn();
    const saveReadingPosition = vi.fn(async () => undefined);
    let controller!: ReturnType<typeof useReaderProgress>;
    const root = { scrollHeight: 1000, clientHeight: 200, scrollTop: 80 } as HTMLDivElement;
    const repository = { saveReadingPosition } as unknown as ReaderRepository;
    function Probe({ active }: { active: boolean }) {
      controller = useReaderProgress({
        isActive: active,
        rootRef: { current: root },
        repository,
        chapter,
        novel: { id: 'book', totalChapters: 1 },
        getVisibleParagraph,
        onVisualLocation,
        onLocationCommitted: vi.fn(),
        onPersistenceFailed: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe active />);
    });
    controller.handleScroll();
    act(() => renderer.update(<Probe active={false} />));
    getVisibleParagraph.mockClear();
    controller.handleScroll();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(getVisibleParagraph).not.toHaveBeenCalled();
    expect(onVisualLocation).not.toHaveBeenCalled();
    expect(saveReadingPosition).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
