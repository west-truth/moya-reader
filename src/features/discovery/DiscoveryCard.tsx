import { useEffect, useRef, useState, type RefObject } from 'react';
import { BookOpen } from 'lucide-react';
import type { ExternalItemSummary } from '../../external-sources/contracts';
import type { DiscoverySession } from './discovery-session';
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
  item,
  session,
  open,
  inLibrary,
}: {
  item: ExternalItemSummary;
  session: DiscoverySession;
  open(): void;
  inLibrary: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref, false);
  const [url, setUrl] = useState(item.thumbnailUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!near) {
      if (item.coverRef) setUrl(undefined);
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
      .catch(() => undefined);
    return () => abort.abort();
  }, [item.coverRef, near, session]);
  return (
    <button type="button" className="discovery-card" ref={ref} onClick={open} aria-label={`${item.title} 상세 보기`}>
      <span className="discovery-cover">
        {near && url && !failed ? (
          <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        ) : (
          <BookOpen size={30} aria-hidden="true" />
        )}
        {inLibrary && <span className="discovery-owned">보관 중</span>}
      </span>
      <strong>{item.title}</strong>
      <span>{item.author ?? item.subtitle ?? (item.kind === 'folder' ? '소스 열기' : '')}</span>
    </button>
  );
}
