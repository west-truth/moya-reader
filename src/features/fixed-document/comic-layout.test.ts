import { describe, expect, it } from 'vitest';
import {
  buildComicSpreads,
  comicProfileModeToViewMode,
  comicSpreadForPage,
  comicViewModeToProfileMode,
  DEFAULT_COMIC_READING_PROFILE,
  isContinuousComicViewMode,
  nextComicViewMode,
} from './comic-layout';

describe('comic layout', () => {
  it('keeps regular and seamless vertical layouts as distinct persistent modes', () => {
    expect(comicProfileModeToViewMode('vertical')).toBe('continuous');
    expect(comicProfileModeToViewMode('vertical', true)).toBe('continuous-seamless');
    expect(comicViewModeToProfileMode('continuous-seamless')).toBe('vertical');
    expect(isContinuousComicViewMode('continuous-seamless')).toBe(true);
    expect(nextComicViewMode('continuous')).toBe('continuous-seamless');
    expect(nextComicViewMode('continuous-seamless')).toBe('single');
  });

  it('keeps the cover single and pairs following LTR pages without loss', () => {
    const spreads = buildComicSpreads(6, { ...DEFAULT_COMIC_READING_PROFILE, mode: 'spread' });
    expect(spreads).toEqual([
      { left: 0, readingOrder: [0] },
      { left: 1, right: 2, readingOrder: [1, 2] },
      { left: 3, right: 4, readingOrder: [3, 4] },
      { left: 5, right: undefined, readingOrder: [5], syntheticBlank: 'right' },
    ]);
    expect(comicSpreadForPage(spreads, 4)).toBe(2);
  });

  it('places the next manga page on the left while retaining RTL reading order', () => {
    const spreads = buildComicSpreads(5, {
      ...DEFAULT_COMIC_READING_PROFILE,
      mode: 'spread',
      direction: 'rtl',
      coverBehavior: 'paired',
    });
    expect(spreads[0]).toEqual({ right: 0, left: 1, readingOrder: [0, 1] });
    expect(spreads.flatMap((spread) => spread.readingOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it('honors explicit parity with a synthetic blank instead of dropping a page', () => {
    const spreads = buildComicSpreads(3, {
      ...DEFAULT_COMIC_READING_PROFILE,
      mode: 'spread',
      coverBehavior: 'paired',
      pageParity: 'right',
    });
    expect(spreads[0]).toEqual({ right: 0, readingOrder: [0], syntheticBlank: 'left' });
    expect(spreads[1].readingOrder).toEqual([1, 2]);
  });

  it('keeps ComicInfo double pages wide and does not pair across them', () => {
    const spreads = buildComicSpreads(
      6,
      { ...DEFAULT_COMIC_READING_PROFILE, mode: 'spread' },
      new Map([
        [2, { type: 'Story', doublePage: true }],
        [5, { type: 'Advertisement' }],
      ]),
    );
    expect(spreads).toEqual([
      { left: 0, readingOrder: [0] },
      { left: 1, right: undefined, readingOrder: [1], syntheticBlank: 'right' },
      { left: 2, readingOrder: [2], widePage: 2 },
      { left: 3, right: 4, readingOrder: [3, 4] },
      { left: 5, right: undefined, readingOrder: [5], syntheticBlank: 'right' },
    ]);
  });
});
