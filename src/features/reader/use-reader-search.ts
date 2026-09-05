import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { Chapter, Novel, Paragraph } from '../../domain/types';
import type { ReaderQueries } from '../../repositories/reader-repository';
import {
  READER_SEARCH_DEFAULT_PAGE_SIZE,
  throwIfReaderSearchAborted,
  type ReaderSearchScope,
} from '../../repositories/reader-query-contract';
import {
  canHighlightReaderSearchQuery,
  canRunReaderSearch,
  normalizedReaderSearchQuery,
  readerSearchBlockedReason,
  readerSearchLimit,
} from '../../reader/search-policy';
import { clamp } from '../../utils/format';
import type { OpenReaderChapterOptions } from './reader-screen-contract';

export interface ReaderSearchController {
  readonly query: string;
  readonly scope: ReaderSearchScope;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly matches: readonly Paragraph[];
  readonly cursor: number;
  readonly visibleMatches: readonly Paragraph[];
  readonly windowStart: number;
  readonly limit: number;
  readonly blockedReason?: string;
  readonly possiblyLimited: boolean;
  readonly highlightQuery: string;
  readonly desktopInputRef: RefObject<HTMLInputElement>;
  readonly mobileInputRef: RefObject<HTMLInputElement>;
  readonly setQuery: (query: string) => void;
  readonly setScope: (scope: ReaderSearchScope) => void;
  readonly clear: () => void;
  readonly focus: () => void;
  readonly jump: (direction: -1 | 1) => Promise<void>;
  readonly goToResult: (paragraph: Paragraph, matchIndex?: number) => Promise<void>;
  readonly handleInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export interface ReaderSearchOptions {
  readonly repository: ReaderQueries;
  readonly novel: Pick<Novel, 'id'>;
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly scrollToParagraph: (paragraphId: string) => Promise<boolean>;
  readonly openChapter: (chapter: Chapter, options: OpenReaderChapterOptions) => Promise<void>;
  readonly notify: (message: string) => void;
}

export interface CollectedReaderSearch {
  readonly matches: Paragraph[];
  readonly capped: boolean;
}

export async function collectReaderSearchMatches(
  repository: Pick<ReaderQueries, 'searchParagraphPage'>,
  input:
    | { readonly scope: 'chapter'; readonly chapterId: string; readonly query: string; readonly signal: AbortSignal }
    | { readonly scope: 'book'; readonly novelId: string; readonly query: string; readonly signal: AbortSignal },
  limit: number,
): Promise<CollectedReaderSearch> {
  const matches: Paragraph[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    throwIfReaderSearchAborted(input.signal);
    const pageSize = Math.min(READER_SEARCH_DEFAULT_PAGE_SIZE, Math.max(1, limit - matches.length));
    const page = await repository.searchParagraphPage(
      input.scope === 'chapter' ? { ...input, cursor, pageSize } : { ...input, cursor, pageSize },
    );
    throwIfReaderSearchAborted(input.signal);
    matches.push(...page.paragraphs.slice(0, Math.max(0, limit - matches.length)));
    const capped = page.capped || matches.length >= limit;
    if (capped || !page.nextCursor) return { matches, capped };
    if (seenCursors.has(page.nextCursor)) throw new Error('Reader search cursor did not advance.');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (matches.length < limit);
  return { matches, capped: matches.length >= limit };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function useReaderSearch(options: ReaderSearchOptions): ReaderSearchController {
  const [query, setQueryState] = useState('');
  const [scope, setScopeState] = useState<ReaderSearchScope>('chapter');
  const [matches, setMatches] = useState<Paragraph[]>([]);
  const [cursor, setCursor] = useState(0);
  const [searchCapped, setSearchCapped] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  const scopeRef = useRef(scope);
  const requestGenerationRef = useRef(0);
  const activeRequestRef = useRef<AbortController>();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { repository, notify } = options;
  const novelId = options.novel.id;
  const chapterId = scope === 'chapter' ? options.chapter.id : '';

  const invalidateSearch = useCallback(() => {
    requestGenerationRef.current += 1;
    activeRequestRef.current?.abort();
    activeRequestRef.current = undefined;
  }, []);

  const resetSearchResults = useCallback(() => {
    setMatches([]);
    setCursor(0);
    setSearchCapped(false);
  }, []);

  const setQuery = useCallback(
    (nextQuery: string) => {
      if (nextQuery === queryRef.current) return;
      queryRef.current = nextQuery;
      invalidateSearch();
      resetSearchResults();
      setStatus(canRunReaderSearch(scopeRef.current, nextQuery) ? 'loading' : 'idle');
      setQueryState(nextQuery);
    },
    [invalidateSearch, resetSearchResults],
  );

  const setScope = useCallback(
    (nextScope: ReaderSearchScope) => {
      if (nextScope === scopeRef.current) return;
      scopeRef.current = nextScope;
      invalidateSearch();
      resetSearchResults();
      setStatus(canRunReaderSearch(nextScope, queryRef.current) ? 'loading' : 'idle');
      setScopeState(nextScope);
    },
    [invalidateSearch, resetSearchResults],
  );

  useEffect(() => {
    const normalized = normalizedReaderSearchQuery(query);
    if (!canRunReaderSearch(scope, query)) {
      resetSearchResults();
      setStatus('idle');
      return;
    }

    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;
    setStatus('loading');
    const timer = window.setTimeout(() => {
      const limit = readerSearchLimit(scope);
      const input =
        scope === 'chapter'
          ? { scope: 'chapter' as const, chapterId, query: normalized, signal: controller.signal }
          : { scope: 'book' as const, novelId, query: normalized, signal: controller.signal };
      void collectReaderSearchMatches(repository, input, limit)
        .then((result) => {
          if (controller.signal.aborted || requestGenerationRef.current !== generation) return;
          setMatches(result.matches);
          setCursor(0);
          setSearchCapped(result.capped);
          setStatus('ready');
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || requestGenerationRef.current !== generation || isAbortError(error)) return;
          resetSearchResults();
          setStatus('error');
          notify('본문 검색에 실패했습니다.');
        })
        .finally(() => {
          if (activeRequestRef.current === controller) activeRequestRef.current = undefined;
        });
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (activeRequestRef.current === controller) activeRequestRef.current = undefined;
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [chapterId, novelId, notify, query, repository, resetSearchResults, scope]);

  const clear = useCallback(() => {
    queryRef.current = '';
    invalidateSearch();
    setQueryState('');
    resetSearchResults();
    setStatus('idle');
  }, [invalidateSearch, resetSearchResults]);

  const goToResult = useCallback(
    async (paragraph: Paragraph, matchIndex?: number) => {
      const current = optionsRef.current;
      const nextCursor =
        matchIndex === undefined ? matches.findIndex((match) => match.id === paragraph.id) : matchIndex;
      if (paragraph.chapterId === current.chapter.id) {
        if (nextCursor >= 0) setCursor(nextCursor);
        await current.scrollToParagraph(paragraph.id);
        return;
      }

      const chapter =
        current.chapters.find((item) => item.id === paragraph.chapterId) ??
        (await current.repository.getChapter(paragraph.chapterId));
      if (!chapter) return;
      await current.openChapter(chapter, {
        restore: true,
        preserveSearch: true,
        position: {
          id: `search_position_${paragraph.id}`,
          novelId: current.novel.id,
          chapterId: paragraph.chapterId,
          paragraphId: paragraph.id,
          paragraphIndex: paragraph.index,
          offsetInParagraph: 0,
          chapterProgress: chapter.paragraphCount > 0 ? clamp(paragraph.index / chapter.paragraphCount, 0, 1) : 0,
          scrollTop: 0,
          deviceId: 'search',
          updatedAt: new Date().toISOString(),
        },
      });
      if (nextCursor >= 0) setCursor(nextCursor);
    },
    [matches],
  );

  const jump = useCallback(
    async (direction: -1 | 1) => {
      if (matches.length === 0) return;
      const next = (cursor + direction + matches.length) % matches.length;
      setCursor(next);
      await goToResult(matches[next], next);
    },
    [cursor, goToResult, matches],
  );

  const focus = useCallback(() => {
    const target = [mobileInputRef.current, desktopInputRef.current].find(
      (input) => input && input.getClientRects().length > 0,
    );
    target?.focus();
    target?.select();
  }, []);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void jump(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clear();
      }
    },
    [clear, jump],
  );

  const windowStart = matches.length <= 6 ? 0 : clamp(cursor - 2, 0, matches.length - 6);
  const limit = readerSearchLimit(scope);
  const blockedReason = readerSearchBlockedReason(scope, query);
  const possiblyLimited = query.trim().length > 0 && searchCapped;
  const highlightQuery = canHighlightReaderSearchQuery(scope, query) ? query : '';
  const visibleMatches = useMemo(() => matches.slice(windowStart, windowStart + 6), [matches, windowStart]);
  return useMemo(
    () => ({
      query,
      scope,
      status,
      matches,
      cursor,
      visibleMatches,
      windowStart,
      limit,
      blockedReason,
      possiblyLimited,
      highlightQuery,
      desktopInputRef,
      mobileInputRef,
      setQuery,
      setScope,
      clear,
      focus,
      jump,
      goToResult,
      handleInputKeyDown,
    }),
    [
      blockedReason,
      clear,
      cursor,
      focus,
      goToResult,
      handleInputKeyDown,
      highlightQuery,
      jump,
      limit,
      matches,
      possiblyLimited,
      query,
      setQuery,
      setScope,
      status,
      scope,
      visibleMatches,
      windowStart,
    ],
  );
}
