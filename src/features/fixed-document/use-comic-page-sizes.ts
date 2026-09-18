import { useMemo } from 'react';
import type { Chapter, ComicReadingProfile } from '../../domain/types';
import {
  continuousComicPageEstimatedHeight,
  continuousComicPageWidth,
  representativeContinuousImageDimensions,
  type ContinuousImageDimensions,
} from './continuous-scroll';

export function useComicPageSizes(
  dimensions: ReadonlyMap<string, ContinuousImageDimensions>,
  chapters: readonly Chapter[],
  viewport: { width: number; height: number },
  fit: ComicReadingProfile['fit'],
  zoom: number,
  seamless: boolean,
  stable: boolean,
) {
  return useMemo(() => {
    // A stable shell's estimate must not depend on images arriving elsewhere.
    const fallback = stable ? undefined : representativeContinuousImageDimensions(dimensions.values());
    const input = (index: number) => ({
      fit,
      zoom,
      seamless,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      dimensions: dimensions.get(chapters[index]?.id ?? '') ?? fallback,
    });
    return {
      estimateContinuousPageSize: (index: number) => continuousComicPageEstimatedHeight(input(index)),
      seamlessContinuousPageWidth: (index: number) => continuousComicPageWidth({ ...input(index), seamless: true }),
    };
  }, [dimensions, chapters, viewport.width, viewport.height, fit, zoom, seamless, stable]);
}
