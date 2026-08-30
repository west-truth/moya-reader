import { BlobReader, BlobWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import { buildSuwayomiChapterCbz } from './suwayomi-chapter-cbz';

function pageIndex(url: string): number {
  return Number.parseInt(url.slice(url.lastIndexOf('/') + 1), 10);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

describe('buildSuwayomiChapterCbz', () => {
  it('fetches pages with bounded concurrency while writing the archive in source order', async () => {
    const pageUrls = Array.from({ length: 8 }, (_, index) => `https://suwayomi.test/page/${index}`);
    const delays = [40, 5, 25, 10, 35, 5, 20, 10];
    const completed: number[] = [];
    let active = 0;
    let peak = 0;

    const archive = await buildSuwayomiChapterCbz(
      pageUrls,
      { title: '병렬 회차' },
      async (url) => {
        const index = pageIndex(url);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await wait(delays[index]!);
          completed.push(index);
          return new Response(Uint8Array.of(index + 1), { headers: { 'Content-Type': 'image/png' } });
        } finally {
          active -= 1;
        }
      },
      new AbortController().signal,
    );

    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(4);
    expect(completed).not.toEqual(pageUrls.map((_, index) => index));

    const reader = new ZipReader(new BlobReader(archive));
    try {
      const entries = await reader.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual([
        'ComicInfo.xml',
        ...pageUrls.map((_, index) => `${String(index + 1).padStart(5, '0')}.png`),
      ]);
      for (const [index, entry] of entries.slice(1).entries()) {
        const blob = await (entry as FileEntry).getData!(new BlobWriter());
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(index + 1));
      }
    } finally {
      await reader.close();
    }
  });

  it('rejects the archive when a scheduled page request fails', async () => {
    const failure = new Error('page fetch failed');

    await expect(
      buildSuwayomiChapterCbz(
        Array.from({ length: 6 }, (_, index) => `https://suwayomi.test/page/${index}`),
        { title: '실패 회차' },
        async (url) => {
          if (pageIndex(url) === 0) {
            await wait(5);
            throw failure;
          }
          await wait(10);
          return new Response(Uint8Array.of(1), { headers: { 'Content-Type': 'image/jpeg' } });
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
  });

  it('aborts unresolved sibling requests when the first scheduled page fails', async () => {
    const failure = new Error('first page failed');
    let abortedSiblings = 0;

    const pending = buildSuwayomiChapterCbz(
      Array.from({ length: 4 }, (_, index) => `https://suwayomi.test/page/${index}`),
      { title: '부분 실패 회차' },
      (url, signal) => {
        if (pageIndex(url) === 0) return Promise.reject(failure);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              abortedSiblings += 1;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      },
      new AbortController().signal,
    );

    await expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(abortedSiblings).toBe(3));
  });

  it('rejects with AbortError when an in-flight page batch is cancelled', async () => {
    const abort = new AbortController();
    let started = 0;
    const fetchPage = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<Response>((_resolve, reject) => {
          started += 1;
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
    );

    const pending = buildSuwayomiChapterCbz(
      Array.from({ length: 6 }, (_, index) => `https://suwayomi.test/page/${index}`),
      { title: '취소 회차' },
      fetchPage,
      abort.signal,
    );
    await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(2));
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });
});
