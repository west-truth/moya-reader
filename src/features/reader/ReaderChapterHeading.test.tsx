import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReaderChapterHeading, type ReaderChapterHeadingData } from './ReaderChapterHeading';

describe('ReaderChapterHeading', () => {
  it('keeps ordinary chapter numbering and uses only the preserved title for source sections', () => {
    const ordinary = { index: 1, title: '2화 다음 이야기' };
    expect(renderToStaticMarkup(<ReaderChapterHeading chapter={ordinary} />)).toContain('제 1화');
    for (const metadata of [{ documentSectionId: 'remote-second' }, { documentSectionTitle: '2화 다음 이야기' }]) {
      const chapter: ReaderChapterHeadingData = { ...ordinary, ...metadata };
      const markup = renderToStaticMarkup(<ReaderChapterHeading chapter={chapter} />);
      expect(markup).toContain('<h1>2화 다음 이야기</h1>');
      expect(markup).not.toContain('chapter-kicker');
      expect(markup).not.toContain('제 1화');
    }
  });
});
