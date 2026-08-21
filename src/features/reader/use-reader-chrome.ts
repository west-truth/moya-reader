import { useCallback, useEffect, useRef, useState } from 'react';

export interface ReaderChromeController {
  readonly visible: boolean;
  readonly immersive: boolean;
  readonly fullscreen: boolean;
  readonly reveal: () => void;
  readonly hide: () => void;
  readonly enterImmersive: () => void;
  readonly exitImmersive: () => void;
  readonly toggleImmersive: () => void;
  readonly toggleFullscreen: () => Promise<void>;
}

export function useReaderChrome(keepVisible: boolean, notify: (message: string) => void): ReaderChromeController {
  const [visible, setVisible] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const hideTimerRef = useRef<number>();
  const immersiveRef = useRef(false);

  const clearHideTimer = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = undefined;
  }, []);

  const reveal = useCallback(() => {
    if (immersiveRef.current) return;
    setVisible(true);
    clearHideTimer();
    if (!keepVisible) {
      hideTimerRef.current = window.setTimeout(() => {
        if (!immersiveRef.current) setVisible(false);
      }, 2600);
    }
  }, [clearHideTimer, keepVisible]);

  const hide = useCallback(() => {
    clearHideTimer();
    setVisible(false);
  }, [clearHideTimer]);

  const enterImmersive = useCallback(() => {
    immersiveRef.current = true;
    clearHideTimer();
    setImmersive(true);
    setVisible(false);
  }, [clearHideTimer]);

  const exitImmersive = useCallback(() => {
    immersiveRef.current = false;
    setImmersive(false);
    reveal();
  }, [reveal]);

  const toggleImmersive = useCallback(() => {
    if (immersiveRef.current) exitImmersive();
    else enterImmersive();
  }, [enterImmersive, exitImmersive]);

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
    return clearHideTimer;
  }, [clearHideTimer, reveal]);

  return {
    visible,
    immersive,
    fullscreen,
    reveal,
    hide,
    enterImmersive,
    exitImmersive,
    toggleImmersive,
    toggleFullscreen,
  };
}
