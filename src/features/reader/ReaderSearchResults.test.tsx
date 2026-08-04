import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Paragraph } from '../../domain/types';
import { ReaderSearchResults } from './ReaderSearchResults';
import type { ReaderSearchController } from './use-reader-search';

function paragraph(index: number): Paragraph {
  return {
    id: `paragraph-${index}`,
    novelId: 'book-1',
    chapterId: 'chapter-1',
    index,
    text: `비가 그친 뒤 검색 결과 ${index} 문장이 이어졌다.`,
    startOffsetInChapter: index * 20,
    endOffsetInChapter: index * 20 + 18,
    textHash: `hash-${index}`,
  };
}

function controller(overrides: Partial<ReaderSearchController> = {}): ReaderSearchController {
  const matches = overrides.matches ?? [];
  return {
    query: '검색',
    scope: 'chapter',
    status: 'ready',
    matches,
    cursor: 0,
    visibleMatches: matches,
    windowStart: 0,
    limit: 200,
    possiblyLimited: false,
    highlightQuery: '검색',
    desktopInputRef: createRef<HTMLInputElement>(),
    mobileInputRef: createRef<HTMLInputElement>(),
    setQuery: vi.fn(),
    setScope: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    jump: vi.fn(),
    goToResult: vi.fn(),
    handleInputKeyDown: vi.fn(),
    ...overrides,
  };
}

const chapters = [{ id: 'chapter-1', title: '제1화' }] as Chapter[];

describe('ReaderSearchResults', () => {
  it('shows a loading state instead of a false empty result', () => {
    const markup = renderToStaticMarkup(
      <ReaderSearchResults search={controller({ status: 'loading' })} chapters={chapters} />,
    );

    expect(markup).toContain('검색 중');
    expect(markup).not.toContain('결과 없음');
  });

  it('keeps the current result compact and collapses the longer result list', () => {
    const markup = renderToStaticMarkup(
      <ReaderSearchResults
        search={controller({ matches: [paragraph(1), paragraph(2)], visibleMatches: [paragraph(1), paragraph(2)] })}
        chapters={chapters}
      />,
    );

    expect(markup).toContain('class="search-result-current"');
    expect(markup).toContain('<summary>결과 목록</summary>');
    expect(markup).not.toContain('<details class="search-result-disclosure" open="">');
  });
});
