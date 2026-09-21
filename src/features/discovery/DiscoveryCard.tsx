import type { WorkView } from '../../components/work-view';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { BookOpen } from 'lucide-react';
import type { ExternalItemSummary } from '../../external-sources/contracts';
import type { DiscoverySession } from './discovery-session';
import { transientSourceFailure } from '../../external-sources/cache-policy';
export function useNear(ref: RefObject<HTMLElement>, once = true) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          if (once) observer.disconnect();
        } else if (!once) setNear(false);
      },
      { rootMargin: '300px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, once]);
  return near;
}
export function DiscoveryCard({
  viewMode = 'grid',
  item,
  session,
  open,
  inLibrary,
}: {
  viewMode?: WorkView;
  item: ExternalItemSummary;
  session: DiscoverySession;
  open(): void;
  inLibrary: boolean;
}) {
  const showCover = viewMode !== 'text';
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref, false);
  const [url, setUrl] = useState(item.thumbnailUrl);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!near || !showCover) {
      if (item.coverRef) setUrl(undefined);
      setRetry(0);
      return;
    }
    if (!item.coverRef) return;
    const abort = new AbortController();
    void session
      .cover(item.coverRef, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && value) {
          setUrl(value);
          setFailed(false);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && retry < 2 && transientSourceFailure(error))
          retryTimer.current = setTimeout(() => setRetry((value) => value + 1), 2500 * (retry + 1));
      });
    return () => {
      abort.abort();
      clearTimeout(retryTimer.current);
    };
  }, [item.coverRef, near, session, retry, showCover]);
  return (
    <button type="button" className="discovery-card" ref={ref} onClick={open} aria-label={`${item.title} 상세 보기`}>
      {viewMode !== 'text' && (
        <span className="discovery-cover">
          {near && url && !failed ? (
            <img
              src={url}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => {
                setFailed(true);
                if (item.coverRef && retry < 1)
                  retryTimer.current = setTimeout(() => setRetry((value) => value + 1), 2500);
              }}
            />
          ) : (
            <BookOpen size={30} aria-hidden="true" />
          )}
          {inLibrary && <span className="discovery-owned">보관 중</span>}
        </span>
      )}
      <span className="discovery-card-copy">
        <strong>{item.title}</strong>
        <span className="discovery-card-description">
          {item.author ?? item.subtitle ?? (item.kind === 'folder' ? '소스 열기' : '')}
        </span>
        {viewMode === 'text' && inLibrary && <small>보관 중</small>}
      </span>
    </button>
  );
}
