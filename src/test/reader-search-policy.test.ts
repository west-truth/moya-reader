import { describe, expect, it } from 'vitest';
import {
  canHighlightReaderSearchQuery,
  canRunReaderSearch,
  readerSearchBlockedReason,
  readerSearchLimit,
} from '../reader/search-policy';

describe('reader search policy', () => {
  it('defaults to bounded current-chapter and whole-book limits', () => {
    expect(readerSearchLimit('chapter')).toBe(200);
    expect(readerSearchLimit('book')).toBe(300);
  });

  it('allows one-character current-chapter search but blocks one-character book search', () => {
    expect(canRunReaderSearch('chapter', '검')).toBe(true);
    expect(canRunReaderSearch('book', '검')).toBe(false);
    expect(readerSearchBlockedReason('book', '검')).toContain('2글자');
  });

  it('allows whole-book search from two characters', () => {
    expect(canRunReaderSearch('book', '검은')).toBe(true);
    expect(readerSearchBlockedReason('book', '검은')).toBeUndefined();
  });

  it('does not highlight when a query is blocked or too long', () => {
    expect(canHighlightReaderSearchQuery('book', '검')).toBe(false);
    expect(canHighlightReaderSearchQuery('chapter', '가'.repeat(80))).toBe(true);
    expect(canHighlightReaderSearchQuery('chapter', '가'.repeat(81))).toBe(false);
  });
});
