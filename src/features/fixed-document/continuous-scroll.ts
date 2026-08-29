export interface ContinuousPageMeasurement {
  readonly index: number;
  readonly start: number;
  readonly size: number;
}

export interface ContinuousImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ContinuousPageEstimateInput {
  readonly fit: 'page' | 'width' | 'height' | 'original';
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly zoom: number;
  readonly seamless?: boolean;
  readonly dimensions?: ContinuousImageDimensions;
}

export interface ContinuousDocumentSection {
  readonly id: string;
  readonly startPageIndex: number;
  readonly pageCount: number;
}

export function continuousComicSectionIndex(sections: readonly ContinuousDocumentSection[], pageIndex: number): number {
  return sections.findIndex(
    (section) => pageIndex >= section.startPageIndex && pageIndex < section.startPageIndex + section.pageCount,
  );
}

export function continuousComicPageIndexes(
  totalPages: number,
  sections: readonly ContinuousDocumentSection[],
  pageIndex: number,
): number[] {
  const sectionIndex = continuousComicSectionIndex(sections, pageIndex);
  const section = sections[sectionIndex];
  const start = section ? section.startPageIndex : 0;
  const count = section ? section.pageCount : totalPages;
  return Array.from({ length: Math.max(0, count) }, (_, index) => start + index).filter(
    (index) => index >= 0 && index < totalPages,
  );
}

export function representativeContinuousImageDimensions(
  dimensions: Iterable<ContinuousImageDimensions>,
): ContinuousImageDimensions | undefined {
  const candidates = [...dimensions]
    .filter((value) => value.width > 0 && value.height > 0)
    .sort((left, right) => left.height / left.width - right.height / right.width);
  return candidates[Math.floor(candidates.length / 2)];
}

export function continuousComicPageEstimatedHeight(input: ContinuousPageEstimateInput): number {
  const mobile = input.viewportWidth < 720;
  const widthInset = input.seamless ? 0 : mobile ? 16 : 72;
  const heightInset = input.seamless ? 0 : mobile ? 28 : 68;
  const widthLimit = Math.max(1, input.viewportWidth - widthInset) * input.zoom;
  const heightLimit = Math.max(1, input.viewportHeight - heightInset) * input.zoom;
  const dimensions =
    input.dimensions && input.dimensions.width > 0 && input.dimensions.height > 0 ? input.dimensions : undefined;

  if (input.fit === 'width') {
    return Math.max(1, widthLimit * (dimensions ? dimensions.height / dimensions.width : 1.5));
  }
  if (input.fit === 'height') return dimensions ? Math.min(dimensions.height, heightLimit) : heightLimit;
  if (input.fit === 'original') return dimensions?.height ?? heightLimit * 1.5;
  if (!dimensions) return heightLimit;
  return Math.max(1, dimensions.height * Math.min(1, widthLimit / dimensions.width, heightLimit / dimensions.height));
}

export function continuousPageNearestViewportCenter(
  items: readonly ContinuousPageMeasurement[],
  scrollTop: number,
  viewportHeight: number,
): number | undefined {
  const center = scrollTop + viewportHeight / 2;
  return items.reduce<{ index: number; distance: number } | undefined>((nearest, item) => {
    const distance = Math.abs(item.start + item.size / 2 - center);
    return !nearest || distance < nearest.distance ? { index: item.index, distance } : nearest;
  }, undefined)?.index;
}

export function shouldAnchorContinuousPageResize(itemEnd: number, scrollOffset: number): boolean {
  return itemEnd <= scrollOffset;
}
