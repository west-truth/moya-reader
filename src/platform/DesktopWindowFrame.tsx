import type { MouseEvent, ReactNode } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

function runWindowAction(action: (window: ReturnType<typeof getCurrentWindow>) => Promise<void>): void {
  void action(getCurrentWindow()).catch((error) => {
    console.warn('Desktop window action failed.', error);
  });
}

function handleTitlebarPointer(event: MouseEvent<HTMLElement>): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
  event.preventDefault();
  runWindowAction((window) => (event.detail === 2 ? window.toggleMaximize() : window.startDragging()));
}

function DesktopWindowFrame() {
  return (
    <header className="desktop-window-frame" onMouseDown={handleTitlebarPointer}>
      <span className="desktop-window-title">모야</span>
      <div className="desktop-window-controls" aria-label="창 제어">
        <button
          type="button"
          onClick={() => runWindowAction((window) => window.minimize())}
          aria-label="창 최소화"
          title="최소화"
        >
          <Minus size={15} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={() => runWindowAction((window) => window.toggleMaximize())}
          aria-label="창 최대화 또는 복원"
          title="최대화 또는 복원"
        >
          <Square size={12} strokeWidth={1.7} />
        </button>
        <button
          className="desktop-window-close"
          type="button"
          onClick={() => runWindowAction((window) => window.close())}
          aria-label="창 닫기"
          title="닫기"
        >
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </header>
  );
}

export function DesktopWindowShell({ children }: { readonly children: ReactNode }) {
  const enabled = import.meta.env.TAURI_ENV_PLATFORM === 'windows';
  if (!enabled) return children;
  return (
    <div className="desktop-window-shell">
      <DesktopWindowFrame />
      <div className="desktop-window-content">{children}</div>
    </div>
  );
}
