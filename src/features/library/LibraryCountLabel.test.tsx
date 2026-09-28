import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LibraryCountLabel } from './LibraryCountLabel';
import { buildLibraryBookView } from './library-screen-model';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';

it('keeps exact values accessible while abbreviating long counts', () => {
  const markup = renderToStaticMarkup(<LibraryCountLabel current={12345} total={987654} unit="화" />);
  expect(markup).toContain('title="12,345 / 987,654화"');
  expect(markup).toContain('1.2만 / 99만화');
  expect(markup).toContain('class="sr-only">12,345 / 987,654화');
});
it('uses a short page unit, clamps counts, and handles unread or missing totals', () => {
  expect(renderToStaticMarkup(<LibraryCountLabel current={24} total={300} unit="페이지" />)).toContain('24 / 300p');
  expect(renderToStaticMarkup(<LibraryCountLabel current={24} total={0} unit="화" />)).toContain('0 / 0화');
  expect(renderToStaticMarkup(<LibraryCountLabel current={NaN} total={100} unit="화" />)).toContain('0 / 100화');
});
describe.each(['txt', 'pdf', 'image_archive'] as const)('local %s counts', (format) => {
  it('uses recorded position and total rather than estimating a count from percentage', () => {
    const novel = testNovel({
      format,
      totalChapters: 300,
      lastReadChapterIndex: 24,
      lastReadProgress: 0.1,
      sourceFileName: '',
      coverSeed: 0,
    });
    const state = { hasReadActivity: () => true, isFinished: () => false };
    expect(buildLibraryBookView(novel, state).readingCounts).toEqual({
      current: 24,
      total: 300,
      unit: format === 'txt' ? '화' : '페이지',
    });
    expect(buildLibraryBookView(novel, { ...state, hasReadActivity: () => false }).readingCounts?.current).toBe(0);
  });
});
