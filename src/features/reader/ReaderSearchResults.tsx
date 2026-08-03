import { SkipBack, SkipForward } from 'lucide-react';
import type { Chapter } from '../../domain/types';
import { formatCount } from '../../utils/format';
import type { ReaderSearchController } from './use-reader-search';

function searchSnippet(text: string, query: string): string {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return text.slice(0, 120);
  const index = text.toLocaleLowerCase().indexOf(normalizedQuery);
  if (index < 0) return text.slice(0, 120);
  const start = Math.max(0, index - 36);
  const end = Math.min(text.length, index + query.length + 72);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function ReaderSearchResults({
  search,
  chapters,
}: {
  readonly search: ReaderSearchController;
  readonly chapters: readonly Chapter[];
}) {
  if (!search.query.trim()) return null;
  const chapterTitles = new Map(chapters.map((chapter) => [chapter.id, chapter.title]));
  const currentMatch = search.matches[search.cursor];
  const resultLabel =
    search.status === 'loading'
      ? '검색 중'
      : search.status === 'error'
        ? '검색 실패'
        : search.blockedReason
          ? '검색어 부족'
          : search.matches.length > 0
            ? `${formatCount(search.matches.length)}개 결과${search.possiblyLimited ? '+' : ''}`
            : '결과 없음';
  return (
    <div className="search-result-strip">
      <div className="search-result-summary">
        <span>{search.scope === 'chapter' ? '현재 화 검색' : '책 전체 검색'}</span>
        <strong role="status" aria-live="polite">
          {resultLabel}
        </strong>
      </div>
      {search.blockedReason && <p className="search-limit-note">{search.blockedReason}</p>}
      {search.status === 'error' && <p className="search-limit-note">검색하지 못했습니다. 잠시 후 다시 시도하세요.</p>}
      {search.possiblyLimited && (
        <p className="search-limit-note">
          성능 보호를 위해 최대 {formatCount(search.limit)}개까지만 표시합니다. 검색어를 더 구체적으로 입력하세요.
        </p>
      )}
      <div className="search-result-toolbar">
        <div className="search-scope-toggle" aria-label="본문 검색 범위">
          <button
            type="button"
            className={search.scope === 'chapter' ? 'active' : undefined}
            onClick={() => search.setScope('chapter')}
          >
            현재 화
          </button>
          <button
            type="button"
            className={search.scope === 'book' ? 'active' : undefined}
            onClick={() => search.setScope('book')}
          >
            책 전체
          </button>
        </div>
        {search.matches.length > 0 && (
          <div className="search-result-controls">
            <button type="button" onClick={() => void search.jump(-1)} aria-label="이전 검색 결과">
              <SkipBack size={14} />
            </button>
            <span>
              {search.cursor + 1} / {search.matches.length}
            </span>
            <button type="button" onClick={() => void search.jump(1)} aria-label="다음 검색 결과">
              <SkipForward size={14} />
            </button>
          </div>
        )}
      </div>
      {currentMatch && (
        <button
          type="button"
          className="search-result-current"
          onClick={() => void search.goToResult(currentMatch, search.cursor)}
        >
          <span>
            {chapterTitles.get(currentMatch.chapterId) ?? '알 수 없는 화'} · {currentMatch.index}문단
          </span>
          <strong>{searchSnippet(currentMatch.text, search.query)}</strong>
        </button>
      )}
      {search.matches.length > 1 && (
        <details className="search-result-disclosure">
          <summary>결과 목록</summary>
          <div className="search-result-list">
            {search.visibleMatches.map((paragraph, offset) => {
              const matchIndex = search.windowStart + offset;
              return (
                <button
                  key={paragraph.id}
                  type="button"
                  className={search.cursor === matchIndex ? 'active' : undefined}
                  onClick={() => void search.goToResult(paragraph, matchIndex)}
                >
                  <span>
                    {chapterTitles.get(paragraph.chapterId) ?? '알 수 없는 화'} · {paragraph.index}문단
                  </span>
                  <strong>{searchSnippet(paragraph.text, search.query)}</strong>
                </button>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
