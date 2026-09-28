import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
const FixedDocumentScreen = lazy(() => import('../fixed-document/FixedDocumentScreen'));
import '../fixed-document/fixed-document.css';
import type { SourceStreamPort, SourceStreamSession } from '../../external-sources/source-stream';
import { SourceStreamBuffer } from '../../external-sources/source-stream-buffer';
import { sourceReadingPreferences } from '../../external-sources/source-reading-preferences';
import { readSourceStreamPosition, saveSourceStreamPosition } from '../../external-sources/source-stream-history';
import { sourceStreamDocument } from './source-stream-document';
import { stableId } from '../../domain/hash';

export function SourceStreamReader({
  title,
  remoteId,
  historyKey = remoteId,
  profileKey = historyKey,
  fromStart = false,
  port,
  onClose,
  onSave,
  onPageSettled,
  saved,
  saveBusy,
  previous,
  next,
  nextEpisode,
  navigationBusy,
}: {
  title: string;
  remoteId: string;
  historyKey?: string;
  profileKey?: string;
  fromStart?: boolean;
  port: SourceStreamPort;
  onClose(): void;
  onSave(): Promise<void>;
  onPageSettled?(page: number, count: number): void | Promise<void>;
  saved?: boolean;
  saveBusy?: boolean;
  previous?: (isCurrent?: () => boolean) => Promise<void>;
  next?: (isCurrent?: () => boolean) => Promise<void>;
  nextEpisode?: { remoteId: string; title: string; saved: boolean; busy: boolean; save(): Promise<void> };
  navigationBusy?: boolean;
}) {
  const [preferences] = useState(sourceReadingPreferences);
  const buffer = useMemo(() => new SourceStreamBuffer(port), [port]);
  const [opened, setOpened] = useState<{
    session: SourceStreamSession;
    key: string;
    title: string;
    epoch: number;
    fromStart: boolean;
  }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState('');
  const [prepared, setPrepared] = useState('');
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden' && navigator.onLine);
  const callbacks = useRef({ onSave, onPageSettled, nextEpisode });
  callbacks.current = { onSave, onPageSettled, nextEpisode };
  const saveAttempts = useRef(new Set<string>());
  useEffect(() => () => buffer.close(), [buffer]);
  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden' && navigator.onLine);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void buffer
      .open(remoteId, controller.signal)
      .then((session) => {
        if (controller.signal.aborted) return;
        setOpened((before) => ({ session, key: historyKey, title, fromStart, epoch: (before?.epoch ?? -1) + 1 }));
        buffer.retain([remoteId, ...(callbacks.current.nextEpisode ? [callbacks.current.nextEpisode.remoteId] : [])]);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            packageOperationMessage(error) ?? (error instanceof Error ? error.message : '회차를 열지 못했습니다.'),
          );
      });
    return () => controller.abort();
  }, [buffer, remoteId, historyKey, title, attempt, fromStart]);
  const projection = useMemo(
    () =>
      opened
        ? sourceStreamDocument(stableId('source_stream', opened.key), opened.title, opened.session, () =>
            setLoaded(opened.key),
          )
        : undefined,
    [opened],
  );
  const position = useMemo(() => {
    if (!opened || opened.fromStart) return undefined;
    const value = readSourceStreamPosition(opened.key);
    return value?.count === opened.session.pageCount ? value : undefined;
  }, [opened]);
  useEffect(() => {
    if (
      !opened ||
      opened.key !== historyKey ||
      loaded !== historyKey ||
      preferences.mode !== 'stream-save' ||
      saved ||
      saveBusy ||
      saveAttempts.current.has(`save:${remoteId}`)
    )
      return;
    saveAttempts.current.add(`save:${remoteId}`);
    // Failures are reported by the existing download task and retried from the episode list.
    void callbacks.current.onSave().catch(() => undefined);
  }, [opened, loaded, historyKey, remoteId, preferences.mode, saved, saveBusy]);
  const nextId = nextEpisode?.remoteId;
  useEffect(() => {
    if (
      !nextId ||
      !opened ||
      opened.key !== historyKey ||
      loaded !== historyKey ||
      !foreground ||
      !preferences.prefetch
    )
      return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const controller = new AbortController();
    // Wait until the current viewer has submitted its visible pages, then warm one neighbor.
    const timer = window.setTimeout(() => {
      void buffer
        .open(nextId, controller.signal)
        .then(async (session) => {
          for (let index = 0; index < Math.min(session.pageCount, Math.max(4, preferences.prefetch)); index++) {
            controller.signal.throwIfAborted();
            try {
              await session.loadPage(index, controller.signal);
            } catch {
              controller.signal.throwIfAborted(); /* Retry individual failures when they become visible. */
            }
          }
          controller.signal.throwIfAborted();
          setPrepared(nextId);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [buffer, nextId, opened, historyKey, loaded, preferences.prefetch, foreground, nextEpisode?.saved]);
  useEffect(() => {
    const target = callbacks.current.nextEpisode;
    if (
      !foreground ||
      preferences.mode !== 'stream-save' ||
      !saved ||
      saveBusy ||
      !target ||
      target.remoteId !== prepared ||
      target.saved ||
      target.busy
    )
      return;
    const key = `save:${target.remoteId}`;
    if (saveAttempts.current.has(key)) return;
    saveAttempts.current.add(key);
    void target.save().catch(() => undefined);
  }, [foreground, preferences.mode, saved, saveBusy, prepared, nextId, nextEpisode?.saved, nextEpisode?.busy]);
  if (!opened || !projection)
    return (
      <main className="fixed-doc-screen">
        <header className="fixed-doc-header">
          <button type="button" className="icon-btn" aria-label="회차 목록으로" onClick={onClose}>
            <ArrowLeft size={20} />
          </button>
          <strong>{title}</strong>
        </header>
        <div className="fixed-doc-page-loading" role="status">
          {error || '회차 불러오는 중'}
          {error && (
            <button type="button" className="secondary-btn" onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw size={16} />
              다시 시도
            </button>
          )}
        </div>
      </main>
    );
  return (
    <>
      <Suspense
        fallback={
          <div className="fixed-doc-screen" role="status">
            뷰어 불러오는 중
          </div>
        }
      >
        <FixedDocumentScreen
          {...projection}
          initialChapterId={projection.chapters[position?.page ?? 0]?.id}
          entryRequestVersion={opened.epoch}
          onBack={onClose}
          remoteNavigation={{
            invalidatePage: opened.session.invalidatePage,
            scope: `stream:${opened.epoch}`,
            nextScope: `stream:${opened.epoch + 1}`,
            profileKey,
            busy: navigationBusy || opened.key !== historyKey,
            prefetchPages: foreground ? preferences.prefetch : 0,
            previous,
            next,
            nextTitle: nextEpisode?.title,
            error,
            retry: () => setAttempt((value) => value + 1),
            initialPosition: position,
            savePosition: (value) =>
              saveSourceStreamPosition(opened.key, { ...value, count: opened.session.pageCount }),
          }}
          onPageSettled={(page, _chapter, _novel) => {
            if (opened.key === historyKey) return onPageSettled?.(page, opened.session.pageCount);
          }}
        />
      </Suspense>
    </>
  );
}
