import { describe, expect, it } from 'vitest';
import { captureComicFlowAnchor, restoreComicFlowAnchor } from './ComicPageFlow';

describe('comic flow position preservation', () => {
  it('accounts for native scroll clamping when images above the viewport shrink', () => {
    const viewport = { scrollTop: 800, getBoundingClientRect: () => ({ top: 0 }) } as HTMLElement;
    let documentTop = 750;
    const row = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: documentTop - viewport.scrollTop,
        bottom: documentTop - viewport.scrollTop + 900,
      }),
    } as HTMLElement;
    const content = { querySelectorAll: () => [row] } as unknown as HTMLElement;
    const anchor = captureComicFlowAnchor(viewport, content)!;
    documentTop -= 200;
    viewport.scrollTop -= 200;
    restoreComicFlowAnchor(viewport, anchor);
    expect(viewport.scrollTop).toBe(600);
    expect(row.getBoundingClientRect().top).toBe(-50);
    // Capture occurs at commit, so wheel input before the commit is included.
    viewport.scrollTop += 100;
    const next = captureComicFlowAnchor(viewport, content)!;
    documentTop += 300;
    restoreComicFlowAnchor(viewport, next);
    expect(viewport.scrollTop).toBe(1000);
    expect(row.getBoundingClientRect().top).toBe(-150);
  });
});
