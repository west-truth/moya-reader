import { useCallback, useEffect, useRef, useState } from 'react';
import type { Novel } from '../../domain/types';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
import type { ImportController, ImportProgress } from '../../services/import/import-service';
import type { SyncState } from '../../sync/types';
import { clamp } from '../../utils/format';

type NoticeTone = 'success' | 'warning' | 'info' | 'danger';

export function serverAttachPercent(progress: ImportProgress | undefined): number {
  if (!progress) return 0;
  return clamp(Math.round((progress.bytesRead / Math.max(progress.totalBytes, 1)) * 100), 0, 100);
}

export function serverAttachIsBusy(progress: ImportProgress | undefined): boolean {
  return Boolean(progress && progress.status !== 'ready' && progress.status !== 'failed');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface ServerAttachControllerInput {
  readonly service: ReaderRuntime['serverAttachService'];
  readonly novel?: Novel;
  readonly onAttached: (novel: Novel) => Promise<SyncState | undefined>;
  readonly notify: (message: string, tone: NoticeTone) => void;
  readonly clearDelayMs?: number;
}

export function useServerAttachController({
  service,
  novel,
  onAttached,
  notify,
  clearDelayMs = 700,
}: ServerAttachControllerInput) {
  const [progress, setProgress] = useState<ImportProgress>();
  const controllerRef = useRef<ImportController>();
  const clearTimerRef = useRef<number>();
  const mountedRef = useRef(true);
  const runVersionRef = useRef(0);
  const busy = serverAttachIsBusy(progress);

  useEffect(
    () => () => {
      mountedRef.current = false;
      runVersionRef.current += 1;
      controllerRef.current?.cancel();
      if (clearTimerRef.current !== undefined) window.clearTimeout(clearTimerRef.current);
    },
    [],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.cancel();
    setProgress((current) =>
      current ? { ...current, status: 'cancelling', message: '서버 업로드를 취소하고 있습니다.' } : current,
    );
  }, []);

  const upload = useCallback(async () => {
    if (!novel) {
      notify('서버에 업로드할 책을 먼저 열어주세요.', 'info');
      return;
    }
    if (!service) {
      notify('서버 동기화 주소가 설정되지 않았습니다.', 'warning');
      return;
    }
    if (controllerRef.current) return;

    if (clearTimerRef.current !== undefined) window.clearTimeout(clearTimerRef.current);
    const runVersion = ++runVersionRef.current;
    const controller = service.attachNovel(novel, setProgress);
    controllerRef.current = controller;
    try {
      await controller.promise;
      if (!mountedRef.current || runVersionRef.current !== runVersion) return;
      const state = await onAttached(novel);
      if (!mountedRef.current || runVersionRef.current !== runVersion || !state) return;
      notify(
        state.status === 'idle'
          ? '현재 책 본문을 서버에 업로드하고 동기화했습니다.'
          : '현재 책 본문은 서버에 업로드됐고, 동기화 상태 확인이 필요합니다.',
        state.status === 'idle' ? 'success' : 'warning',
      );
    } catch (error) {
      if (!mountedRef.current || runVersionRef.current !== runVersion) return;
      const aborted = isAbortError(error);
      setProgress((current) =>
        current
          ? {
              ...current,
              status: 'failed',
              message: aborted ? '서버 업로드를 취소했습니다.' : '서버 업로드에 실패했습니다.',
            }
          : current,
      );
      notify(aborted ? '서버 업로드를 취소했습니다.' : '서버 업로드에 실패했습니다.', aborted ? 'info' : 'danger');
    } finally {
      if (mountedRef.current && runVersionRef.current === runVersion) {
        controllerRef.current = undefined;
        clearTimerRef.current = window.setTimeout(() => setProgress(undefined), clearDelayMs);
      }
    }
  }, [clearDelayMs, notify, novel, onAttached, service]);

  return {
    available: Boolean(service),
    busy,
    progress,
    percent: serverAttachPercent(progress),
    cancel,
    upload,
  } as const;
}
