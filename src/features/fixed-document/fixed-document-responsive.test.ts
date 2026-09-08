import { describe, expect, it } from 'vitest';
import { fixedDocumentSidebarStartsOpen } from './fixed-document-responsive';

describe('fixed document responsive defaults', () => {
  it('starts with thumbnails collapsed on 11-inch tablet viewports', () => {
    expect(fixedDocumentSidebarStartsOpen(834)).toBe(false);
    expect(fixedDocumentSidebarStartsOpen(1_194)).toBe(false);
  });

  it('keeps the thumbnail rail open on desktop viewports', () => {
    expect(fixedDocumentSidebarStartsOpen(1_280)).toBe(true);
    expect(fixedDocumentSidebarStartsOpen(1_440)).toBe(true);
  });
});
