import { describe, expect, it } from 'vitest';
import {
  continuousComicPageEstimatedHeight,
  continuousComicPageIndexes,
  continuousComicSectionIndex,
  continuousPageNearestViewportCenter,
  representativeContinuousImageDimensions,
  shouldAnchorContinuousPageResize,
} from './continuous-scroll';

describe('continuous comic scroll stability', () => {
  it('tracks the page nearest the viewport center', () => {
    const items = [
      { index: 10, start: 0, size: 600 },
      { index: 11, start: 600, size: 900 },
      { index: 12, start: 1500, size: 700 },
    ];

    expect(continuousPageNearestViewportCenter(items, 520, 700)).toBe(11);
    expect(continuousPageNearestViewportCenter(items, 1500, 600)).toBe(12);
    expect(continuousPageNearestViewportCenter([], 0, 600)).toBeUndefined();
  });

  it('anchors only page resizes that are fully above the viewport', () => {
    expect(shouldAnchorContinuousPageResize(799, 800)).toBe(true);
    expect(shouldAnchorContinuousPageResize(800, 800)).toBe(true);
    expect(shouldAnchorContinuousPageResize(801, 800)).toBe(false);
    expect(shouldAnchorContinuousPageResize(1_400, 800)).toBe(false);
  });

  it('matches the reader fit constraints before an image is mounted', () => {
    const viewport = { viewportWidth: 1_118, viewportHeight: 628, zoom: 1 };
    const portrait = { width: 690, height: 1_600 };

    expect(continuousComicPageEstimatedHeight({ ...viewport, fit: 'page' })).toBe(560);
    expect(continuousComicPageEstimatedHeight({ ...viewport, fit: 'page', dimensions: portrait })).toBe(560);
    expect(continuousComicPageEstimatedHeight({ ...viewport, fit: 'height', dimensions: portrait })).toBe(560);
    expect(continuousComicPageEstimatedHeight({ ...viewport, fit: 'width', dimensions: portrait })).toBeCloseTo(
      2_425.51,
      1,
    );
    expect(continuousComicPageEstimatedHeight({ ...viewport, fit: 'original', dimensions: portrait })).toBe(1_600);
  });

  it('uses the mobile reader insets at narrow widths', () => {
    expect(
      continuousComicPageEstimatedHeight({
        fit: 'page',
        viewportWidth: 390,
        viewportHeight: 700,
        zoom: 1,
      }),
    ).toBe(672);
  });

  it('always fits borderless continuous pages to the viewport width on desktop and mobile', () => {
    const portrait = { width: 690, height: 1_600 };

    expect(
      continuousComicPageEstimatedHeight({
        fit: 'page',
        viewportWidth: 809,
        viewportHeight: 769,
        zoom: 1,
        seamless: true,
        dimensions: portrait,
      }),
    ).toBeCloseTo((809 * 1_600) / 690, 4);
    expect(
      continuousComicPageEstimatedHeight({
        fit: 'page',
        viewportWidth: 390,
        viewportHeight: 844,
        zoom: 1,
        seamless: true,
        dimensions: portrait,
      }),
    ).toBeCloseTo((390 * 1_600) / 690, 4);
    expect(
      continuousComicPageEstimatedHeight({
        fit: 'height',
        viewportWidth: 390,
        viewportHeight: 844,
        zoom: 1,
        seamless: true,
        dimensions: portrait,
      }),
    ).toBeCloseTo((390 * 1_600) / 690, 4);
  });

  it('uses a viewport-height placeholder until a borderless page ratio is known', () => {
    expect(
      continuousComicPageEstimatedHeight({
        fit: 'page',
        viewportWidth: 390,
        viewportHeight: 844,
        zoom: 1,
        seamless: true,
      }),
    ).toBe(844);
  });

  it('uses the median page ratio instead of a cover outlier', () => {
    expect(
      representativeContinuousImageDimensions([
        { width: 1_600, height: 1_300 },
        { width: 690, height: 1_600 },
        { width: 690, height: 1_600 },
        { width: 690, height: 1_600 },
        { width: 690, height: 1_600 },
      ]),
    ).toEqual({ width: 690, height: 1_600 });
  });

  it('scopes a continuous comic to the active episode while preserving global page indexes', () => {
    const sections = [
      { id: 'episode-1', startPageIndex: 0, pageCount: 76 },
      { id: 'episode-2', startPageIndex: 76, pageCount: 66 },
      { id: 'episode-3', startPageIndex: 142, pageCount: 70 },
    ];

    expect(continuousComicSectionIndex(sections, 80)).toBe(1);
    expect(continuousComicPageIndexes(212, sections, 80)).toEqual(Array.from({ length: 66 }, (_, index) => 76 + index));
    expect(continuousComicPageIndexes(35, [], 12)).toEqual(Array.from({ length: 35 }, (_, index) => index));
  });
});
