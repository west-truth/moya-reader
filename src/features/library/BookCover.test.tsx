import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppRuntime } from '../../app/runtime/app-runtime';
import { RuntimeProvider } from '../../app/runtime/RuntimeProvider';
import type { Novel } from '../../domain/types';
import { BookCover } from './BookCover';

function novel(): Novel {
  return {
    id: 'book-cover-lazy',
    title: '표지 지연 로드',
    sourceFileName: 'book.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'sha256:raw',
    normalizedTextHash: 'sha256:normalized',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 2,
    totalParagraphs: 1,
    coverSeed: 1,
    coverAssetId: 'cover-1',
    coverContentHash: 'sha256:cover',
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

describe('BookCover hosted loading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops the previous cover immediately when a new work has a delayed cover', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:first-cover'), revokeObjectURL: vi.fn() });
    let finish!: (value: { blob: Blob }) => void;
    const nextCover = new Promise<{ blob: Blob }>((resolve) => {
      finish = resolve;
    });
    const getActiveCover = vi
      .fn()
      .mockResolvedValueOnce({ blob: new Blob(['first']) })
      .mockReturnValueOnce(nextCover);
    const runtime = { readerRuntime: { bookAssetRepository: { getActiveCover } } } as unknown as AppRuntime;
    const first = { ...novel(), id: 'cover-switch-first' };
    const second = { ...novel(), id: 'cover-switch-second', title: '다음 작품', coverAssetId: 'cover-2' };
    const render = (book: Novel) => (
      <RuntimeProvider runtime={runtime}>
        <BookCover novel={book} className="book-cover" />
      </RuntimeProvider>
    );
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(render(first));
      });
      expect(renderer.root.findByType('img').props.src).toBe('blob:first-cover');
      await act(async () => renderer.update(render(second)));
      expect(renderer.root.findAllByType('img')).toHaveLength(0);
      expect(renderer.root.findByType('strong').children).toEqual(['다음 작품']);
      await act(async () => {
        finish({ blob: new Blob(['second']) });
      });
      expect(renderer.root.findAllByType('img')).toHaveLength(1);
    } finally {
      finish({ blob: new Blob() });
      await act(async () => renderer?.unmount());
    }
  });

  it('does not download an offscreen cover until it approaches the viewport', async () => {
    let callback: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '600px 0px';
      readonly thresholds = [0];
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      disconnect = vi.fn();
      observe = vi.fn();
      takeRecords = () => [];
      unobserve = vi.fn();
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:cover-1'), revokeObjectURL: vi.fn() });
    const getActiveCover = vi.fn(async () => ({ blob: new Blob(['cover'], { type: 'image/jpeg' }) }));
    const runtime = {
      readerRuntime: { bookAssetRepository: { getActiveCover } },
    } as unknown as AppRuntime;
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <RuntimeProvider runtime={runtime}>
          <BookCover novel={novel()} className="book-cover" />
        </RuntimeProvider>,
        { createNodeMock: () => ({}) },
      );
    });
    expect(getActiveCover).not.toHaveBeenCalled();

    await act(async () => {
      callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
    });

    expect(getActiveCover).toHaveBeenCalledOnce();
    renderer!.unmount();
  });
});
