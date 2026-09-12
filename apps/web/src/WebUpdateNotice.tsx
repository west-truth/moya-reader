import { useEffect, useState } from 'react';
import type { ProductLifecycleProps } from '../../../src/app/runtime/app-runtime';
import { applyWebUpdate, setWebWorkBusy, startWebPwa, useWebPwa } from './web-pwa';
import './web.css';

/** Updates wait for active work and stay out of focused reading. */
export function WebUpdateNotice({ busy, reading }: ProductLifecycleProps) {
  const state = useWebPwa();
  const [dismissed, setDismissed] = useState<ServiceWorker>();
  useEffect(() => {
    startWebPwa();
  }, []);
  useEffect(() => {
    setWebWorkBusy(busy);
    return () => setWebWorkBusy(false);
  }, [busy]);
  useEffect(() => {
    if (!busy && !state.preparing) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [busy, state.preparing]);
  if (!state.waiting || dismissed === state.waiting || reading) return null;
  return (
    <aside className="web-update-notice" aria-label="앱 업데이트">
      <span>{busy ? '작업이 끝나면 새 버전을 적용할 수 있습니다.' : '새 버전이 준비되었습니다.'}</span>
      <button className="primary-btn" disabled={busy || state.preparing} onClick={applyWebUpdate}>
        지금 적용
      </button>
      <button className="ghost-btn" onClick={() => setDismissed(state.waiting)}>
        나중에
      </button>
    </aside>
  );
}
