export interface FocalRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PageFocalRect extends FocalRect {
  readonly pageIndex: number;
}

export interface ViewportFocalAnchor {
  readonly pageIndex: number;
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly viewportOffsetX: number;
  readonly viewportOffsetY: number;
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

export function captureViewportFocalAnchor(input: {
  readonly viewport: FocalRect;
  readonly pages: readonly PageFocalRect[];
  readonly preferredPageIndex: number;
  readonly clientX?: number;
  readonly clientY?: number;
}): ViewportFocalAnchor | undefined {
  const clientX = input.clientX ?? input.viewport.left + input.viewport.width / 2;
  const clientY = input.clientY ?? input.viewport.top + input.viewport.height / 2;
  const containing = input.pages.find(
    (page) =>
      clientX >= page.left &&
      clientX <= page.left + page.width &&
      clientY >= page.top &&
      clientY <= page.top + page.height,
  );
  const preferred = input.pages.find((page) => page.pageIndex === input.preferredPageIndex);
  const page =
    containing ??
    preferred ??
    input.pages.reduce<PageFocalRect | undefined>((nearest, candidate) => {
      if (!nearest) return candidate;
      const distance = Math.hypot(
        candidate.left + candidate.width / 2 - clientX,
        candidate.top + candidate.height / 2 - clientY,
      );
      const nearestDistance = Math.hypot(
        nearest.left + nearest.width / 2 - clientX,
        nearest.top + nearest.height / 2 - clientY,
      );
      return distance < nearestDistance ? candidate : nearest;
    }, undefined);
  if (!page || page.width <= 0 || page.height <= 0) return undefined;

  return {
    pageIndex: page.pageIndex,
    normalizedX: clampUnit((clientX - page.left) / page.width),
    normalizedY: clampUnit((clientY - page.top) / page.height),
    viewportOffsetX: clientX - input.viewport.left,
    viewportOffsetY: clientY - input.viewport.top,
  };
}

export function focalAnchorScrollDelta(
  anchor: ViewportFocalAnchor,
  viewport: FocalRect,
  page: FocalRect,
): { readonly left: number; readonly top: number } {
  const anchoredClientX = page.left + page.width * anchor.normalizedX;
  const anchoredClientY = page.top + page.height * anchor.normalizedY;
  return {
    left: anchoredClientX - (viewport.left + anchor.viewportOffsetX),
    top: anchoredClientY - (viewport.top + anchor.viewportOffsetY),
  };
}
