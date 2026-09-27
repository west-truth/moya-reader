import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { ArchivePageLoader, type ArchivePageSnapshot } from '../fixed-document/archive-page-loader';
import { ComicPageFlow } from '../fixed-document/ComicPageFlow';
import type { SourceStreamPort, SourceStreamSession } from '../../external-sources/source-stream';
import { sourceReadingPreferences } from '../../external-sources/source-reading-preferences';

/** Foreground pages use the same bounded, cancellation-aware loader as the comic reader. */
export function SourceStreamReader({
  title,
  remoteId,
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
}: {
  title: string;
  remoteId: string;
  port: SourceStreamPort;
  onClose(): void;
  onSave(): Promise<void>;
  onPageSettled?(page: number, count: number): void | Promise<void>;
  saved?: boolean;
  saveStatus?: string;
  saveBusy?: boolean;
  saveFailed?: boolean;
  onCancelSave(): void;
  previous?: () => void;
  next?: () => void;
}) {
  const [preferences] = useState(sourceReadingPreferences);
  const [session, setSession] = useState<SourceStreamSession>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(0);
  const [snapshot, setSnapshot] = useState<ArchivePageSnapshot>({ pages: new Map(), errors: new Map() });
  const [sizes, setSizes] = useState<Record<number, number>>({});
  const [saveError, setSaveError] = useState('');
  const [saveRequested, setSaveRequested] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null),
    loader = useRef<ArchivePageLoader>();
  const autoSaveAttempted = useRef(false);
  const callbacks = useRef({ onSave, onClose, previous, next, onPageSettled });
  callbacks.current = { onSave, onClose, previous, next, onPageSettled };
  const requestSave = () => {
    setSaveRequested(true);
    setSaveError('');
    void callbacks.current.onSave().catch((error) => {
      setSaveRequested(false);
      setSaveError(error instanceof Error ? error.message : '저장을 시작하지 못했습니다.');
    });
  };
  useEffect(() => {
    const controller = new AbortController();
    let opened: SourceStreamSession | undefined;
    setError('');
    setPage(0);
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
              throw new Error(
                packageOperationMessage(error) ??
                  (error instanceof Error ? error.message : '이미지를 불러오지 못했습니다.'),
                { cause: error },
              );
            }
          },
          setSnapshot,
          3,
          12,
        );
        setSession(value);
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
  }, [port, remoteId, attempt]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        callbacks.current.onClose();
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
  useEffect(() => {
    if (!session) return;
    const update = () => {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
        .connection;
      const ahead =
        document.hidden || !navigator.onLine || connection?.saveData || /2g/.test(connection?.effectiveType ?? '')
          ? 0
          : preferences.prefetch;
      loader.current?.update(
        page,
        Array.from({ length: ahead + 1 }, (_, i) => page + i).filter((i) => i >= 0 && i < session.pageCount),
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
  }, [page, session, preferences.prefetch]);
  useEffect(() => {
    // Start saving only once the first visible page is available; opening never waits for the archive.
    if (preferences.mode === 'stream-save' && snapshot.pages.size > 0 && !autoSaveAttempted.current) {
      autoSaveAttempted.current = true;
      requestSave();
    }
  }, [snapshot.pages, preferences.mode, saveRequested]);
  useEffect(() => {
    if (!session || !viewport.current || !content.current) return;
    const root = viewport.current;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (entry.isIntersecting) visible.add(index);
          else visible.delete(index);
        }
        if (visible.size) setPage(Math.min(...visible));
      },
      { root, threshold: 0 },
    );
    for (const element of content.current.querySelectorAll('article')) observer.observe(element);
    return () => observer.disconnect();
  }, [session]);
  useEffect(() => {
    if (!session || !snapshot.pages.has(page)) return;
    const timer = setTimeout(() => {
      void Promise.resolve(callbacks.current.onPageSettled?.(page, session.pageCount)).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [page, session, snapshot.pages, saved]);
  const count = session?.pageCount ?? 0;
  return (
    <main className="source-stream-reader" aria-label={`${title} 바로 읽기`}>
      <header className="source-stream-toolbar">
        <button ref={closeButton} className="icon-btn" type="button" onClick={onClose} aria-label="회차 목록으로">
          <ArrowLeft size={20} />
        </button>
        <strong>{title}</strong>
        <span>{count ? `${page + 1} / ${count}` : '준비 중'}</span>
        <button
          className="ghost-btn"
          type="button"
          disabled={saveRequested && !saveBusy && !saveFailed}
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
      {(saveStatus || saveError) && (
        <p className="source-stream-save-status" role="status">
          {saveError || saveStatus}
        </p>
      )}
      <div className="source-stream-viewport" ref={viewport}>
        {error ? (
          <div className="source-stream-message" role="alert">
            <p>회차를 열지 못했습니다. {error}</p>
            <button className="primary-btn" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw size={16} />
              다시 시도
            </button>
          </div>
        ) : !session ? (
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
              <button className="ghost-btn" disabled={!previous} onClick={previous}>
                <ChevronLeft size={18} />
                이전 회차
              </button>
              <button className="primary-btn" disabled={!next} onClick={next}>
                다음 회차
                <ChevronRight size={18} />
              </button>
            </nav>
          </ComicPageFlow>
        )}
      </div>
    </main>
  );
}
