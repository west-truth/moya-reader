import { useEffect, useState } from 'react';
import './web.css';

/** New code becomes active only after the reader explicitly accepts a reload. */
export function WebUpdateNotice() {
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD || !globalThis.navigator?.serviceWorker || !/^https?:$/.test(location.protocol)) return;
    let active = true;
    let registration: ServiceWorkerRegistration | undefined;
    const inspect = () => {
      if (active && registration?.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
    };
    const update = () => {
      registration?.installing?.addEventListener('statechange', inspect);
    };
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((value) => {
        registration = value;
        if (!active) return;
        inspect();
        registration.addEventListener('updatefound', update);
        update();
      })
      .catch(() => {
        /* Online reading still works if storage/private mode blocks installation. */
      });
    return () => {
      active = false;
      registration?.removeEventListener('updatefound', update);
    };
  }, []);
  if (!waiting || dismissed) return null;
  return (
    <aside className="web-update-notice" aria-label="앱 업데이트">
      <span>새 버전이 준비되었습니다.</span>
      <button
        className="primary-btn"
        onClick={() => {
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
          waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
        }}
      >
        지금 적용
      </button>
      <button className="ghost-btn" onClick={() => setDismissed(true)}>
        나중에
      </button>
    </aside>
  );
}
