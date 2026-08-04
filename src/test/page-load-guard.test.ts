import { describe, expect, it } from 'vitest';
import { isCurrentParagraphPageLoad } from '../reader/page-load-guard';

describe('paragraph page load guard', () => {
  it('accepts only requests for the active chapter and current cache generation', () => {
    expect(
      isCurrentParagraphPageLoad({
        activeChapterId: 'chapter_1',
        requestedChapterId: 'chapter_1',
        activeGeneration: 3,
        requestedGeneration: 3,
      }),
    ).toBe(true);
  });

  it('rejects stale same-chapter responses after the paragraph cache generation changes', () => {
    expect(
      isCurrentParagraphPageLoad({
        activeChapterId: 'chapter_1',
        requestedChapterId: 'chapter_1',
        activeGeneration: 4,
        requestedGeneration: 3,
      }),
    ).toBe(false);
  });

  it('rejects responses for a no-longer-active chapter', () => {
    expect(
      isCurrentParagraphPageLoad({
        activeChapterId: 'chapter_2',
        requestedChapterId: 'chapter_1',
        activeGeneration: 3,
        requestedGeneration: 3,
      }),
    ).toBe(false);
  });
});
