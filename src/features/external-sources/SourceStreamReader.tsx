import { useComicPageFlow } from '../fixed-document/use-comic-page-flow';
import { AutoScrollControls } from '../reader/AutoScrollControls';
import { useComicAutoReading } from '../fixed-document/use-comic-auto-reading';
import { useReaderChrome } from '../reader/use-reader-chrome';
import {
  readSourceStreamPosition,
  saveSourceStreamPosition,
  type SourceStreamPosition,
} from '../../external-sources/source-stream-history';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, RefreshCw, Play, Maximize } from 'lucide-react';
import { ArchivePageLoader, type ArchivePageSnapshot } from '../fixed-document/archive-page-loader';
import { ComicPageFlow } from '../fixed-document/ComicPageFlow';
import type { SourceStreamPort, SourceStreamSession } from '../../external-sources/source-stream';
import { sourceReadingPreferences } from '../../external-sources/source-reading-preferences';

/** Foreground pages use the same bounded, cancellation-aware loader as the comic reader. */
export function SourceStreamReader({
  title,
  remoteId,
  historyKey = remoteId,
  port,
  onClose,
  onSave,
  onPageSettled,
  saved,
  saveStatus,
  saveBusy,
  saveFailed,
  onCancelSave,
  previous,
  next,
  navigationBusy,
}: {
  title: string;
  remoteId: string;
  historyKey?: string;
  port: SourceStreamPort;
  onClose(): void;
  onSave(): Promise<void>;
  onPageSettled?(page: number, count: number): void | Promise<void>;
  saved?: boolean;
  saveStatus?: string;
  saveBusy?: boolean;
  saveFailed?: boolean;
  onCancelSave(): void;
  previous?: (isCurrent?: () => boolean) => Promise<void>;
  next?: (isCurrent?: () => boolean) => Promise<void>;
  navigationBusy?: boolean;
}) {
  const [readerScope, setReaderScope] = useState({ identity: historyKey, epoch: 0 });
  if (readerScope.identity !== historyKey) setReaderScope({ identity: historyKey, epoch: readerScope.epoch + 1 });
  const scope = `stream:${readerScope.epoch}`;
  const [autoOpen, setAutoOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const chrome = useReaderChrome(false, setNotice);
  const gesture = useRef<{ x: number; y: number; at: number; scroll: number }>();
  const restore = useRef<SourceStreamPosition>();
  const [preferences] = useState(sourceReadingPreferences);
  const [session, setSession] = useState<SourceStreamSession & { identity: string }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [initialPage, setInitialPage] = useState(0);
  const [snapshot, setSnapshot] = useState<ArchivePageSnapshot>({ pages: new Map(), errors: new Map() });
  const [sizes, setSizes] = useState<Record<number, number>>({});
  const [saveError, setSaveError] = useState('');
  const [saveRequested, setSaveRequested] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null),
    loader = useRef<ArchivePageLoader>();
  const autoSaveAttempted = useRef(false);
  const callbacks = useRef({ onSave, onClose, previous, next, onPageSettled, chrome });
  callbacks.current = { onSave, onClose, previous, next, onPageSettled, chrome };
  const saveOwner = useRef(historyKey);
  saveOwner.current = historyKey;
  const requestSave = useCallback(() => {
    const owner = historyKey;
    setSaveRequested(true);
    setSaveError('');
    void callbacks.current
      .onSave()
      .catch((error) => {
        if (saveOwner.current === owner)
          setSaveError(error instanceof Error ? error.message : '저장을 시작하지 못했습니다.');
      })
      .finally(() => {
        if (saveOwner.current === owner) setSaveRequested(false);
      });
  }, [historyKey]);
  useEffect(() => {
    const controller = new AbortController();
    let opened: SourceStreamSession | undefined;
    setError('');
    const position = readSourceStreamPosition(historyKey);
    setInitialPage(position?.page ?? 0);
    setSession(undefined);
    setSnapshot({ pages: new Map(), errors: new Map() });
    void port
      .open(remoteId, controller.signal)
      .then((value) => {
        opened = value;
        if (controller.signal.aborted) {
          value.close();
          return;
        }
        loader.current = new ArchivePageLoader(
          async (index, signal) => {
            try {
              return { blob: await value.loadPage(index, signal) };
            } catch (error) {
              if (error instanceof Error && error.message === 'source_stream_expired' && !controller.signal.aborted)
                setError('읽기 연결이 만료됐습니다. 다시 시도하면 회차를 다시 엽니다.');
              throw Object.assign(
                new Error(
                  packageOperationMessage(error) ??
                    (error instanceof Error ? error.message : '이미지를 불러오지 못했습니다.'),
                ),
                { cause: error },
              );
            }
          },
          setSnapshot,
          3,
          12,
        );
        restore.current = position?.count === value.pageCount ? position : undefined;
        setInitialPage(restore.current?.page ?? 0);
        setSizes(restore.current ? { [restore.current.page]: restore.current.ratio } : {});
        setSession({ ...value, identity: historyKey });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            packageOperationMessage(error) ?? (error instanceof Error ? error.message : '회차를 열지 못했습니다.'),
          );
      });
    return () => {
      controller.abort();
      loader.current?.dispose();
      loader.current = undefined;
      opened?.close();
    };
  }, [port, remoteId, historyKey, attempt]);
  useEffect(() => {
    autoSaveAttempted.current = false;
    setSaveRequested(false);
    setSaveError('');
    setNotice('');
    setAutoOpen(false);
  }, [historyKey]);
  useLayoutEffect(() => {
    if (!session || session.identity !== historyKey || !viewport.current || !content.current) return;
    const position = restore.current;
    const row = content.current.querySelector<HTMLElement>(`article[data-page-index="${position?.page ?? 0}"]`);
    if (row)
      viewport.current.scrollTop =
        row.getBoundingClientRect().top -
        viewport.current.getBoundingClientRect().top +
        viewport.current.scrollTop +
        (position?.fraction ?? 0) * row.getBoundingClientRect().height;
  }, [session, historyKey, error]);
  useEffect(() => {
    const root = viewport.current,
      body = content.current;
    if (!session || session.identity !== historyKey || error || !root || !body) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: Omit<SourceStreamPosition, 'updatedAt'> | undefined;
    const capture = () => {
      const top = root.getBoundingClientRect().top;
      const row = [...body.querySelectorAll<HTMLElement>('article[data-page-index]')].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      if (!row?.querySelector<HTMLImageElement>('img')?.naturalWidth) return;
      const bounds = row.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      last = {
        page: Number(row.dataset.pageIndex),
        count: session.pageCount,
        fraction: Math.max(0, Math.min(0.999999, (top - bounds.top) / bounds.height)),
        ratio: bounds.height / bounds.width,
      };
    };
    const flush = () => {
      if (last) saveSourceStreamPosition(historyKey, last);
    };
    const scroll = () => {
      capture();
      clearTimeout(timer);
      timer = setTimeout(flush, 200);
    };
    const hide = () => {
      capture();
      flush();
    };
    root.addEventListener('scroll', scroll);
    root.addEventListener('load', scroll, true);
    window.addEventListener('pagehide', hide);
    return () => {
      clearTimeout(timer);
      // DOM may already belong to the next episode during passive-effect cleanup.
      // Flush only a position captured while this session owned the viewport.
      flush();
      root.removeEventListener('scroll', scroll);
      root.removeEventListener('load', scroll, true);
      window.removeEventListener('pagehide', hide);
    };
  }, [session, historyKey, error]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    viewport.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role=dialog]'))) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (callbacks.current.chrome.visible) callbacks.current.onClose();
        else callbacks.current.chrome.exitImmersive();
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        viewport.current?.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        viewport.current?.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      before?.focus();
    };
  }, []);
  const pageIndexes = useMemo(() => Array.from({ length: session?.pageCount ?? 0 }, (_, i) => i), [session]);
  const comicFlow = useComicPageFlow(
    Boolean(session && session.identity === historyKey && !error),
    pageIndexes,
    viewport,
    content,
  );
  const visiblePages = useMemo(
    () => (comicFlow.visible.length ? comicFlow.visible : [initialPage]),
    [comicFlow.visible, initialPage],
  );
  const page = visiblePages[0];
  const navigate = async (direction: 'previous' | 'next', isCurrent?: () => boolean) => {
    setNotice('');
    try {
      await callbacks.current[direction]?.(isCurrent);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '회차를 이동하지 못했습니다.');
      throw error;
    }
  };
  const nearbyPages = Array.from({ length: Math.max(2, preferences.prefetch + 1) }, (_, i) => page + i).filter(
    (index) => index < (session?.pageCount ?? 0),
  );
  const autoReading = useComicAutoReading({
    viewport,
    content,
    continuous: true,
    scope,
    allowed: !error,
    ready: Boolean(session) && !navigationBusy,
    visiblePages,
    nearbyPages,
    nextPages: [],
    pages: snapshot.pages,
    errors: snapshot.errors,
    footerHeight: content.current?.querySelector('nav')?.getBoundingClientRect().height ?? 92,
    turn: () => {},
    reportError: (index, url) => loader.current?.reportError(index, url),
    nextChapter: next
      ? { scope: `stream:${readerScope.epoch + 1}`, open: (isCurrent) => navigate('next', isCurrent) }
      : undefined,
  });
  const { enterImmersive } = chrome;
  useEffect(() => {
    if (autoReading.running) enterImmersive();
  }, [autoReading.running, enterImmersive]);
  useEffect(() => {
    if (!session || session.identity !== historyKey || error) return;
    const update = () => {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
        .connection;
      const ahead =
        document.hidden || !navigator.onLine || connection?.saveData || /2g/.test(connection?.effectiveType ?? '')
          ? 0
          : Math.max(autoReading.running ? 1 : 0, preferences.prefetch);
      loader.current?.update(
        page,
        [...new Set([...visiblePages, ...Array.from({ length: ahead + 1 }, (_, i) => page + i)])].filter(
          (i) => i >= 0 && i < session.pageCount,
        ),
      );
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [page, session, preferences.prefetch, historyKey, visiblePages, autoReading.running, error]);
  useEffect(() => {
    // Start saving only once the first visible page is available; opening never waits for the archive.
    if (
      session?.identity === historyKey &&
      preferences.mode === 'stream-save' &&
      snapshot.pages.size > 0 &&
      !autoSaveAttempted.current
    ) {
      autoSaveAttempted.current = true;
      if (!saveBusy && !saved) requestSave();
    }
  }, [snapshot.pages, preferences.mode, saveBusy, saved, session, historyKey, requestSave]);
  useEffect(() => {
    if (!session || session.identity !== historyKey || !snapshot.pages.has(page)) return;
    const timer = setTimeout(() => {
      void Promise.resolve(callbacks.current.onPageSettled?.(page, session.pageCount)).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [page, session, snapshot.pages, saved, historyKey]);
  const count = session?.pageCount ?? 0;
  return (
    <main
      className={`source-stream-reader${chrome.immersive ? ' is-immersive' : ''}`}
      aria-label={`${title} 바로 읽기`}
      data-current-page={page}
      data-visible-pages={visiblePages.join(',')}
    >
      <header className="source-stream-toolbar" hidden={chrome.immersive}>
        <button ref={closeButton} className="icon-btn" type="button" onClick={onClose} aria-label="회차 목록으로">
          <ArrowLeft size={20} />
        </button>
        <strong>{title}</strong>
        <button
          type="button"
          className="icon-btn"
          aria-label="자동 읽기"
          onClick={() => {
            autoReading.stop();
            setAutoOpen(true);
          }}
        >
          <Play size={20} />
        </button>
        <button
          type="button"
          className="icon-btn source-stream-fullscreen"
          aria-label="전체 화면"
          onClick={() => void chrome.toggleFullscreen()}
        >
          <Maximize size={20} />
        </button>
        <span>{count ? `${page + 1} / ${count}` : '준비 중'}</span>
        <button
          className="ghost-btn"
          type="button"
          disabled={Boolean(saved || (saveRequested && !saveBusy && !saveFailed))}
          onClick={
            saveBusy
              ? () => {
                  setSaveRequested(false);
                  onCancelSave();
                }
              : requestSave
          }
        >
          <Download size={16} />
          {saveBusy
            ? '저장 취소'
            : saved
              ? '저장됨'
              : saveFailed
                ? '저장 재시도'
                : saveRequested
                  ? '저장 요청됨'
                  : '회차 저장'}
        </button>
      </header>
      {!chrome.immersive && (saveStatus || saveError) && (
        <p className="source-stream-save-status" role="status">
          {saveError || saveStatus}
        </p>
      )}
      {notice && (
        <p className="source-stream-save-status" role="alert">
          {notice}
        </p>
      )}
      <div
        className="source-stream-viewport"
        tabIndex={0}
        aria-label="만화 본문, 중앙을 누르면 읽기 도구 표시"
        ref={viewport}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button, input, select, a')) return;
          gesture.current = {
            x: event.clientX,
            y: event.clientY,
            at: Date.now(),
            scroll: event.currentTarget.scrollTop,
          };
        }}
        onPointerCancel={() => {
          gesture.current = undefined;
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          gesture.current = undefined;
          if (!start || (event.target as HTMLElement).closest('button, input, select, a')) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - bounds.left) / bounds.width;
          if (
            Date.now() - start.at < 500 &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10 &&
            Math.abs(event.currentTarget.scrollTop - start.scroll) < 10 &&
            x >= 0.33 &&
            x <= 0.67
          )
            chrome.toggleImmersive();
        }}
      >
        {error ? (
          <div className="source-stream-message" role="alert">
            <p>회차를 열지 못했습니다. {error}</p>
            <button className="primary-btn" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw size={16} />
              다시 시도
            </button>
          </div>
        ) : !session || session.identity !== historyKey ? (
          <p className="source-stream-message" role="status">
            이미지 목록을 불러오는 중…
          </p>
        ) : (
          <ComicPageFlow
            enabled
            geometry={sizes}
            sectionKey={remoteId}
            viewportRef={viewport}
            contentRef={content}
            className="source-stream-pages"
          >
            {Array.from({ length: count }, (_, index) => {
              const image = snapshot.pages.get(index),
                failure = snapshot.errors.get(index);
              return (
                <article key={index} data-page-index={index} style={{ aspectRatio: `1 / ${sizes[index] ?? 1.5}` }}>
                  {image ? (
                    <img
                      src={image.url}
                      alt={`${index + 1}페이지`}
                      decoding="async"
                      onLoad={(event) => {
                        const image = event.currentTarget;
                        const ratio = image.naturalHeight / image.naturalWidth;
                        if (Number.isFinite(ratio) && ratio > 0)
                          setSizes((current) => (current[index] === ratio ? current : { ...current, [index]: ratio }));
                      }}
                      onError={() => loader.current?.reportError(index, image.url)}
                    />
                  ) : (
                    <div className="source-stream-placeholder">
                      <span>{index + 1}페이지</span>
                      {failure && (
                        <>
                          <p>{failure}</p>
                          <button className="ghost-btn" onClick={() => loader.current?.retry(index)}>
                            다시 불러오기
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
            <nav className="source-stream-navigation" aria-label="회차 이동">
              <button
                className="ghost-btn"
                disabled={!previous || navigationBusy}
                onClick={() => void navigate('previous').catch(() => {})}
              >
                <ChevronLeft size={18} />
                이전 회차
              </button>
              <button
                className="primary-btn"
                disabled={!next || navigationBusy}
                onClick={() => void navigate('next').catch(() => {})}
              >
                {navigationBusy ? '회차 불러오는 중…' : '다음 회차'}
                <ChevronRight size={18} />
              </button>
            </nav>
          </ComicPageFlow>
        )}
      </div>
      <AutoScrollControls
        controller={autoReading}
        open={autoOpen}
        onClose={() => setAutoOpen(false)}
        allowed={!error && Boolean(session) && autoReading.modeAllowed}
      />
    </main>
  );
}
