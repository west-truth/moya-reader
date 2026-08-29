import { ArrowLeft, ArrowRight, LoaderCircle, RefreshCw, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import type { WebNovelMetadataCollectorBrowserFrame } from '../../services/webnovel-metadata-collector-client';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';

const REMOTE_BROWSER_POLL_MIN_MS = 500;
const REMOTE_BROWSER_POLL_MAX_MS = 3_000;
const CONTROL_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export interface RemoteCollectorAuthBrowserProps {
  readonly broker: WebNovelMetadataCollectorBroker;
  readonly platformLabel: string;
  readonly busy: boolean;
  onComplete(): void;
  onCancel(): void;
  onDismiss(): void;
}

export function RemoteCollectorAuthBrowser({
  broker,
  platformLabel,
  busy,
  onComplete,
  onCancel,
  onDismiss,
}: RemoteCollectorAuthBrowserProps) {
  const [frame, setFrame] = useState<WebNovelMetadataCollectorBrowserFrame>();
  const [frameUrl, setFrameUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const frameUrlRef = useRef<string>();
  const textInputRef = useRef<HTMLInputElement>(null);
  const pointerRef = useRef<{
    frameX: number;
    frameY: number;
    clientY: number;
    moved: boolean;
  }>();
  const pendingScrollRef = useRef(0);
  const scrollTimerRef = useRef<ReturnType<typeof globalThis.setTimeout>>();
  const actionQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let revision = 0;
    let nextDelay = REMOTE_BROWSER_POLL_MIN_MS;
    const poll = async () => {
      while (!stopped) {
        if (document.visibilityState === 'hidden') {
          await new Promise((resolve) => globalThis.setTimeout(resolve, REMOTE_BROWSER_POLL_MAX_MS));
          continue;
        }
        try {
          const nextFrame = await broker.authBrowserFrame(revision, controller.signal);
          if (nextFrame) {
            revision = nextFrame.revision;
            const nextUrl = URL.createObjectURL(nextFrame.blob);
            const previousUrl = frameUrlRef.current;
            frameUrlRef.current = nextUrl;
            setFrame(nextFrame);
            setFrameUrl(nextUrl);
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            setError(undefined);
            nextDelay = REMOTE_BROWSER_POLL_MIN_MS;
          } else {
            nextDelay = Math.min(REMOTE_BROWSER_POLL_MAX_MS, Math.round(nextDelay * 1.5));
          }
        } catch (cause) {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : '로그인 화면을 불러오지 못했습니다.');
          nextDelay = REMOTE_BROWSER_POLL_MAX_MS;
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, nextDelay));
      }
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = undefined;
      if (scrollTimerRef.current) globalThis.clearTimeout(scrollTimerRef.current);
    };
  }, [broker]);

  const sendAction = (action: Parameters<WebNovelMetadataCollectorBroker['authBrowserAction']>[0]) => {
    const task = actionQueueRef.current.then(async () => {
      try {
        await broker.authBrowserAction(action);
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '브라우저 입력을 전달하지 못했습니다.');
      }
    });
    actionQueueRef.current = task.catch(() => undefined);
    return task;
  };

  const queueScroll = (deltaY: number) => {
    pendingScrollRef.current = Math.max(-4_000, Math.min(4_000, pendingScrollRef.current + deltaY));
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = globalThis.setTimeout(() => {
      scrollTimerRef.current = undefined;
      const delta = pendingScrollRef.current;
      pendingScrollRef.current = 0;
      if (delta) void sendAction({ action: 'scroll', deltaY: delta });
    }, 60);
  };

  const pointerDownFrame = (event: PointerEvent<HTMLDivElement>) => {
    if (!frame) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = {
      frameX: Math.max(0, Math.min(frame.width, ((event.clientX - bounds.left) / bounds.width) * frame.width)),
      frameY: Math.max(0, Math.min(frame.height, ((event.clientY - bounds.top) / bounds.height) * frame.height)),
      clientY: event.clientY,
      moved: false,
    };
  };

  const pointerMoveFrame = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = pointer.clientY - event.clientY;
    if (Math.abs(delta) < 4) return;
    pointer.moved = true;
    pointer.clientY = event.clientY;
    queueScroll(delta * 2);
  };

  const pointerUpFrame = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    pointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointer && !pointer.moved) {
      void sendAction({ action: 'click', x: pointer.frameX, y: pointer.frameY });
    }
  };

  const keyFrame = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (CONTROL_KEYS.has(event.key)) {
      event.preventDefault();
      void sendAction({ action: 'key', key: event.key });
    } else if (event.key.length === 1) {
      event.preventDefault();
      void sendAction({ action: 'text', text: event.key });
    }
  };

  const wheelFrame = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    queueScroll(event.deltaY);
  };

  const sendText = (event: FormEvent) => {
    event.preventDefault();
    const input = textInputRef.current;
    const text = input?.value ?? '';
    if (!text) return;
    if (input) input.value = '';
    void sendAction({ action: 'text', text });
  };

  return (
    <div className="collector-auth-browser-backdrop" role="presentation">
      <section
        className="collector-auth-browser-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${platformLabel} 로그인`}
      >
        <header>
          <strong>{platformLabel} 로그인</strong>
          <div className="collector-auth-browser-nav">
            <button
              type="button"
              className="icon-btn"
              aria-label="뒤로"
              onClick={() => void sendAction({ action: 'back' })}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="앞으로"
              onClick={() => void sendAction({ action: 'forward' })}
            >
              <ArrowRight size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="새로고침"
              onClick={() => void sendAction({ action: 'reload' })}
            >
              <RefreshCw size={16} />
            </button>
            <button type="button" className="icon-btn" aria-label="화면 닫기" onClick={onDismiss}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div
          className="collector-auth-browser-frame"
          style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
          role="application"
          aria-label="원격 로그인 브라우저"
          tabIndex={0}
          onPointerDown={pointerDownFrame}
          onPointerMove={pointerMoveFrame}
          onPointerUp={pointerUpFrame}
          onPointerCancel={() => {
            pointerRef.current = undefined;
          }}
          onKeyDown={keyFrame}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (!text) return;
            event.preventDefault();
            void sendAction({ action: 'text', text });
          }}
          onWheel={wheelFrame}
        >
          {frameUrl ? (
            <img src={frameUrl} alt="" draggable={false} />
          ) : (
            <div className="collector-auth-browser-loading" role="status">
              <LoaderCircle className="spin" size={22} />
            </div>
          )}
        </div>

        <form className="collector-auth-browser-input" onSubmit={sendText}>
          <input
            ref={textInputRef}
            type="password"
            autoComplete="off"
            maxLength={2048}
            aria-label="선택한 로그인 입력칸에 입력"
            placeholder="선택한 칸에 입력"
          />
          <button className="ghost-btn" type="submit">
            입력
          </button>
        </form>

        {error && (
          <p className="field-help warning" role="alert">
            {error}
          </p>
        )}

        <footer>
          <button className="ghost-btn danger" type="button" disabled={busy} onClick={onCancel}>
            취소
          </button>
          <button className="primary-btn" type="button" disabled={busy || !frame} onClick={onComplete}>
            {busy && <LoaderCircle size={15} className="spin" />} 로그인 완료
          </button>
        </footer>
      </section>
    </div>
  );
}
