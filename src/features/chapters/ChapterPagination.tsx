import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

interface ChapterPaginationProps {
  page: number;
  pageCount: number;
  onPage(page: number): void;
}

function paginationItems(page: number, pageCount: number): Array<number | string> {
  const pages = Array.from(new Set([1, pageCount, page - 1, page, page + 1]))
    .filter((item) => item >= 1 && item <= pageCount)
    .sort((a, b) => a - b);
  const result: Array<number | string> = [];
  pages.forEach((item, index) => {
    const previous = pages[index - 1];
    if (previous !== undefined && item - previous > 1) result.push(`gap-${previous}`);
    result.push(item);
  });
  return result;
}

export function ChapterPagination({ page, pageCount, onPage }: ChapterPaginationProps) {
  const navigation = useRef<HTMLElement>(null);
  const pending = useRef<{ top: number; scroller: Element }>();
  useLayoutEffect(() => {
    const anchor = pending.current;
    pending.current = undefined;
    if (anchor && navigation.current) {
      // Keep the controls in place even when leaving a short final page.
      anchor.scroller.scrollTop += navigation.current.getBoundingClientRect().top - anchor.top;
    }
  }, [page]);

  const choosePage = (next: number) => {
    if (next === page) return;
    const nav = navigation.current;
    if (nav) {
      let scroller = nav.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const target = scroller ?? document.scrollingElement;
      if (target) pending.current = { top: nav.getBoundingClientRect().top, scroller: target };
    }
    onPage(next);
  };

  return (
    <nav ref={navigation} className="chapter-pagination" aria-label="회차 페이지">
      <button type="button" onClick={() => choosePage(page - 1)} disabled={page === 1} aria-label="이전 페이지">
        <ChevronLeft size={16} />
      </button>
      {paginationItems(page, pageCount).map((item) =>
        typeof item === 'number' ? (
          <button
            type="button"
            key={item}
            className={page === item ? 'is-current' : ''}
            onClick={() => choosePage(item)}
            aria-current={page === item ? 'page' : undefined}
            aria-label={`${item}페이지`}
          >
            {item}
          </button>
        ) : (
          <span key={item} aria-hidden="true">
            ···
          </span>
        ),
      )}
      <button type="button" onClick={() => choosePage(page + 1)} disabled={page === pageCount} aria-label="다음 페이지">
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}
