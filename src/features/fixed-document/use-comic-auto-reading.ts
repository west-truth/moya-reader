import { useEffect, useRef, type RefObject } from 'react';
import { useAutoScroll, type AutoReadingViewport } from '../reader/use-auto-scroll';
import type { AutoReadingResult } from '../reader/auto-reading-modes';

interface ComicAutoReadingInput {
  viewport: RefObject<HTMLElement>;
  content: RefObject<HTMLElement>;
  continuous: boolean;
  scope: string;
  allowed: boolean;
  ready: boolean;
  visiblePages: readonly number[];
  nearbyPages: readonly number[];
  nextPages: readonly number[];
  pages: ReadonlyMap<number, { url: string }>;
  errors: ReadonlyMap<number, string>;
  footerHeight: number;
  turn: () => void;
  reportError: (index: number, url: string) => void;
  nextChapter?: { scope: string; open: (isCurrent: () => boolean) => Promise<void> };
}

export function useComicAutoReading(input: ComicAutoReadingInput) {
  const adapter = useRef<AutoReadingViewport>();
  const preload = useRef<{ key: string; state: AutoReadingResult }>();
  const targets = input.continuous ? [] : input.nextPages.map((index) => ({ index, url: input.pages.get(index)?.url }));
  const preloadKey = JSON.stringify([input.scope, targets]);
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    const pending = { key: preloadKey, state: 'waiting' as AutoReadingResult };
    preload.current = pending;
    const entries = JSON.parse(preloadKey)[1] as { index: number; url?: string }[];
    if (!entries.length || entries.some((entry) => !entry.url)) return;
    let cancelled = false;
    const images = entries.map((entry) => {
      const image = new Image();
      image.src = entry.url!;
      return image;
    });
    const timeout = window.setTimeout(() => {
      if (!cancelled && pending.state === 'waiting') pending.state = 'failed';
    }, 30000);
    void Promise.all(
      images.map(async (image, index) => {
        try {
          await image.decode();
        } catch {
          if (!cancelled) latest.current.reportError(entries[index].index, entries[index].url!);
          throw new Error('Image decode failed');
        }
      }),
    )
      .then(
        () => {
          if (!cancelled) pending.state = 'moving';
        },
        () => {
          if (!cancelled) pending.state = 'failed';
        },
      )
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      images.forEach((image) => image.removeAttribute('src'));
    };
  }, [preloadKey]);
  const settled = (indexes: readonly number[], mounted: boolean): AutoReadingResult => {
    for (const index of indexes) {
      if (input.errors.has(index)) return 'failed';
      if (!input.pages.has(index)) return 'waiting';
      if (mounted) {
        const image = input.content.current?.querySelector<HTMLImageElement>(`article[data-page-index="${index}"] img`);
        if (!image || !image.complete) return 'waiting';
        if (!image.naturalWidth) return 'failed';
      }
    }
    return indexes.length ? 'moving' : 'waiting';
  };
  adapter.current = {
    flow: input.continuous ? 'scroll' : 'paginated',
    advanceAutoScroll: (pixels) => {
      const viewport = input.viewport.current;
      if (!viewport) return 'waiting';
      const bounds = viewport.getBoundingClientRect();
      // Only inspect the existing near-screen window, not the entire episode.
      const visible = input.nearbyPages.filter((index) => {
        const row = input.content.current?.querySelector<HTMLElement>(`article[data-page-index="${index}"]`);
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom + pixels;
      });
      const state = settled(visible, true);
      if (state !== 'moving') return state;
      const end = Math.max(0, viewport.scrollHeight - input.footerHeight - viewport.clientHeight);
      if (viewport.scrollTop >= end - 1) return 'end';
      viewport.scrollTop = Math.min(end, viewport.scrollTop + pixels);
      return 'moving';
    },
    advanceAutoReading: (mode, amount) => {
      if (mode !== 'page-turn') return 'waiting';
      const current = settled(input.visiblePages, true);
      if (current !== 'moving') return current;
      if (!input.nextPages.length) return 'end';
      const next = settled(input.nextPages, false);
      if (next !== 'moving') return next;
      if (preload.current?.key !== preloadKey) return 'waiting';
      if (preload.current.state !== 'moving') return preload.current.state;
      if (amount > 0) input.turn();
      return 'moving';
    },
  };
  return useAutoScroll(adapter, input.scope, input.allowed, input.ready, input.nextChapter, 'comic');
}
