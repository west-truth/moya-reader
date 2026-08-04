import { describe, expect, it } from 'vitest';
import { captureViewportFocalAnchor, focalAnchorScrollDelta } from './viewport-focal-anchor';

describe('viewport focal anchor', () => {
  it('selects the page under a spread focal point and records its normalized position', () => {
    const anchor = captureViewportFocalAnchor({
      viewport: { left: 100, top: 50, width: 800, height: 600 },
      pages: [
        { pageIndex: 4, left: 150, top: 100, width: 300, height: 500 },
        { pageIndex: 5, left: 470, top: 100, width: 300, height: 500 },
      ],
      preferredPageIndex: 4,
      clientX: 620,
      clientY: 350,
    });

    expect(anchor).toEqual({
      pageIndex: 5,
      normalizedX: 0.5,
      normalizedY: 0.5,
      viewportOffsetX: 520,
      viewportOffsetY: 300,
    });
  });

  it('returns the scroll correction needed after a zoomed page relayout', () => {
    const delta = focalAnchorScrollDelta(
      {
        pageIndex: 2,
        normalizedX: 0.25,
        normalizedY: 0.75,
        viewportOffsetX: 200,
        viewportOffsetY: 300,
      },
      { left: 100, top: 50, width: 800, height: 600 },
      { left: 180, top: -100, width: 800, height: 1200 },
    );

    expect(delta).toEqual({ left: 80, top: 450 });
  });

  it('falls back to the preferred page and clamps a focal point in the surrounding margin', () => {
    const anchor = captureViewportFocalAnchor({
      viewport: { left: 0, top: 0, width: 1000, height: 700 },
      pages: [{ pageIndex: 9, left: 300, top: 100, width: 400, height: 500 }],
      preferredPageIndex: 9,
      clientX: 100,
      clientY: 350,
    });

    expect(anchor?.normalizedX).toBe(0);
    expect(anchor?.normalizedY).toBe(0.5);
  });
});
