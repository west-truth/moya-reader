import { useCallback, useEffect, useRef, useState } from 'react';

export interface ReaderChromeController {
  readonly visible: boolean;
  readonly fullscreen: boolean;
  readonly reveal: () => void;
  readonly hide: () => void;
  readonly toggleFullscreen: () => Promise<void>;
}

export function useReaderChrome(keepVisible: boolean, notify: (message: string) => void): ReaderChromeController {
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const hideTimerRef = useRef<number>();

  const reveal = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimerRef.current);
    if (!keepVisible) hideTimerRef.current = window.setTimeout(() => setVisible(false), 2600);
  }, [keepVisible]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => notify('전체 화면을 종료하지 못했습니다.'));
      return;
    }
    if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) {
      notify('이 환경에서는 전체 화면을 지원하지 않습니다.');
      return;
    }
    await document.documentElement.requestFullscreen().catch(() => notify('전체 화면으로 전환하지 못했습니다.'));
  }, [notify]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    reveal();
    return () => window.clearTimeout(hideTimerRef.current);
  }, [reveal]);

  return { visible, fullscreen, reveal, hide: () => setVisible(false), toggleFullscreen };
}
