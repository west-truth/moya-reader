import { describe, expect, it, vi } from 'vitest';
import { mayCloseMetadataEditor, normalizeMetadataTags } from './LibraryManagementPanel';

describe('mayCloseMetadataEditor', () => {
  it('closes clean editors without asking for confirmation', () => {
    const confirmDiscard = vi.fn(() => false);

    expect(mayCloseMetadataEditor(false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('keeps a dirty editor open when discarding is rejected', () => {
    const confirmDiscard = vi.fn(() => false);

    expect(mayCloseMetadataEditor(true, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith('저장하지 않은 책 정보 변경을 버릴까요?');
  });

  it('closes a dirty editor after discard confirmation', () => {
    expect(mayCloseMetadataEditor(true, () => true)).toBe(true);
  });
});

describe('normalizeMetadataTags', () => {
  it('trims, removes blanks, and preserves the first occurrence order', () => {
    expect(normalizeMetadataTags([' 판타지 ', '', '성장', '판타지', '  성장  ', '모험'])).toEqual([
      '판타지',
      '성장',
      '모험',
    ]);
  });
});
