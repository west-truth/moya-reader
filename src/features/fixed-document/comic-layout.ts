import type { ComicReadingProfile } from '../../domain/types';

export type ComicViewMode = 'single' | 'spread' | 'continuous' | 'continuous-seamless';

export function isContinuousComicViewMode(mode: ComicViewMode): boolean {
  return mode === 'continuous' || mode === 'continuous-seamless';
}

export function comicProfileModeToViewMode(mode: ComicReadingProfile['mode'], seamlessVertical = false): ComicViewMode {
  if (mode === 'vertical') return seamlessVertical ? 'continuous-seamless' : 'continuous';
  return mode;
}

export function comicViewModeToProfileMode(mode: ComicViewMode): ComicReadingProfile['mode'] {
  if (mode === 'continuous') return 'vertical';
  if (mode === 'continuous-seamless') return 'vertical';
  return mode;
}

export function nextComicViewMode(mode: ComicViewMode): ComicViewMode {
  if (mode === 'single') return 'spread';
  if (mode === 'spread') return 'continuous';
  if (mode === 'continuous') return 'continuous-seamless';
  return 'single';
}

export interface ComicSpread {
  readonly left?: number;
  readonly right?: number;
  readonly readingOrder: readonly number[];
  readonly syntheticBlank?: 'left' | 'right';
  readonly widePage?: number;
}

export interface ComicPageLayoutHint {
  readonly type?: string;
  readonly doublePage?: boolean;
}

export const DEFAULT_COMIC_READING_PROFILE: ComicReadingProfile = {
  schemaVersion: 1,
  mode: 'single',
  seamlessVertical: false,
  direction: 'ltr',
  coverBehavior: 'single',
  pageParity: 'auto',
  fit: 'page',
  crop: 'off',
  brightness: 1,
  contrast: 1,
  saturation: 1,
  grayscale: false,
  invert: false,
  manualCrop: { top: 0, right: 0, bottom: 0, left: 0 },
  gap: 8,
  background: 'charcoal',
};

function pairedSpread(
  first: number,
  second: number | undefined,
  direction: ComicReadingProfile['direction'],
): ComicSpread {
  if (direction === 'rtl') {
    return {
      right: first,
      left: second,
      readingOrder: second === undefined ? [first] : [first, second],
      syntheticBlank: second === undefined ? 'left' : undefined,
    };
  }
  return {
    left: first,
    right: second,
    readingOrder: second === undefined ? [first] : [first, second],
    syntheticBlank: second === undefined ? 'right' : undefined,
  };
}

function standaloneSpread(page: number, direction: ComicReadingProfile['direction'], wide = false): ComicSpread {
  return {
    readingOrder: [page],
    ...(direction === 'rtl' ? { right: page } : { left: page }),
    ...(wide ? { widePage: page } : {}),
  };
}

export function buildComicSpreads(
  totalPages: number,
  profile: ComicReadingProfile,
  pageHints: ReadonlyMap<number, ComicPageLayoutHint> = new Map(),
): ComicSpread[] {
  if (totalPages <= 0) return [];
  const result: ComicSpread[] = [];
  let page = 0;
  if (profile.coverBehavior === 'single') {
    result.push(standaloneSpread(0, profile.direction, pageHints.get(0)?.doublePage));
    page = 1;
  }

  const naturalFirstSide = profile.direction === 'rtl' ? 'right' : 'left';
  const configuredFirstSide = profile.pageParity === 'auto' ? naturalFirstSide : profile.pageParity;
  if (page < totalPages && !pageHints.get(page)?.doublePage && configuredFirstSide !== naturalFirstSide) {
    result.push({
      readingOrder: [page],
      [configuredFirstSide]: page,
      syntheticBlank: configuredFirstSide === 'left' ? 'right' : 'left',
    });
    page += 1;
  }

  while (page < totalPages) {
    if (pageHints.get(page)?.doublePage) {
      result.push(standaloneSpread(page, profile.direction, true));
      page += 1;
      continue;
    }
    if (page + 1 < totalPages && pageHints.get(page + 1)?.doublePage) {
      result.push(pairedSpread(page, undefined, profile.direction));
      page += 1;
      continue;
    }
    result.push(pairedSpread(page, page + 1 < totalPages ? page + 1 : undefined, profile.direction));
    page += 2;
  }
  return result;
}

export function comicSpreadForPage(spreads: readonly ComicSpread[], pageIndex: number): number {
  const index = spreads.findIndex((spread) => spread.readingOrder.includes(pageIndex));
  return Math.max(0, index);
}

export function comicSpreadPages(spread: ComicSpread): number[] {
  return [spread.left, spread.right].filter((page): page is number => page !== undefined);
}
