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
