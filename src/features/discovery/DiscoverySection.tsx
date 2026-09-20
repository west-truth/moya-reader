import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react';
import type { ExternalItemPage, ExternalItemSummary, ExternalSourceListInput } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { DiscoverySession } from './discovery-session';
import type { DiscoverySection as Section } from './discovery-config';

function useNear(ref: RefObject<HTMLElement>, once = true) {
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
export function DiscoverySection({
  section,
  source,
  session,
  query,
  refresh,
  open,
  owned,
  positions,
}: {
  section: Section;
  source?: ExternalSourceView;
  session: DiscoverySession;
  query: string;
  refresh: number;
  open(source: string, input: ExternalSourceListInput, title?: string): void;
  owned(item: ExternalItemSummary): boolean;
  positions: Map<string, number>;
}) {
  const ref = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const near = useNear(ref);
  const input: ExternalSourceListInput = {
    parentRef: section.parentRef,
    browseMode: query ? 'search' : section.mode,
    query: query || undefined,
    filters: section.filters,
  };
  const descriptor = session.registry
    .getExternalSources()
    .find((entry) => entry.descriptor.id === section.sourceId)?.descriptor;
  const unsupported =
    source?.kind === 'cloud_file'
      ? '파일 소스입니다. 폴더 보기에서 파일을 찾아보세요.'
      : descriptor && !descriptor.capabilities.includes(query ? 'search' : 'browse')
        ? query
          ? '이 소스는 검색을 지원하지 않습니다.'
          : '이 소스는 목록 탐색을 지원하지 않습니다. 검색을 이용해 주세요.'
        : undefined;
  const inputKey = JSON.stringify(input);
  const [page, setPage] = useState<ExternalItemPage | undefined>(() => session.peek(section.sourceId, input)?.page);
  const [candidate, setCandidate] = useState<ExternalItemPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef({ input, page });
  latest.current = { input, page };
  useEffect(() => {
    if (!near || unsupported || source?.connection.state !== 'connected') return;
    let active = true;
    setLoading(true);
    setError('');
    const fetchPage = async () => {
      if (section.filterSignature) {
        const schema = await session.list(section.sourceId, { parentRef: section.parentRef, browseMode: section.mode });
        if (JSON.stringify(schema.browse?.filters ?? []) !== section.filterSignature)
          throw new Error('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
      }
      return session.list(section.sourceId, latest.current.input, refresh > 0 || retry > 0);
    };
    void fetchPage()
      .then((result) => {
        if (!active) return;
        if (result.browse && !result.browse.availableModes.includes(query ? 'search' : section.mode)) {
          setError('이 소스가 해당 목록을 지원하지 않습니다. 다른 목록을 선택해 주세요.');
          setPage(undefined);
          return;
        }
        if (section.filterSignature && JSON.stringify(result.browse?.filters ?? []) !== section.filterSignature) {
          setError('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
          setPage(undefined);
          return;
        }
        if (
          latest.current.page &&
          !refresh &&
          !retry &&
          JSON.stringify(result.items) !== JSON.stringify(latest.current.page.items)
        )
          setCandidate(result);
        else {
          setPage(result);
          setCandidate(undefined);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    near,
    unsupported,
    session,
    section.sourceId,
    section.parentRef,
    section.mode,
    section.filterSignature,
    inputKey,
    source?.connection.state,
    query,
    refresh,
    retry,
  ]);
  useEffect(() => {
    const node = rail.current;
    if (!node || !page) return;
    node.scrollLeft = positions.get(section.id) ?? 0;
    const save = () => positions.set(section.id, node.scrollLeft);
    node.addEventListener('scroll', save, { passive: true });
    return () => node.removeEventListener('scroll', save);
  }, [page, positions, section.id]);
  const title = query
    ? `${source?.title ?? '소스'} · 검색 결과`
    : section.title ||
      `${source?.title ?? '사용할 수 없는 소스'} · ${section.mode === 'popular' ? '인기' : '최신 업데이트'}`;
  return (
    <section ref={ref} className="discovery-section" data-discovery-section={section.id} aria-label={title}>
      <div className="discovery-section-heading">
        <div>
          <small>{section.title ? source?.title : '작품 탐색'}</small>
          <h2>{title}</h2>
        </div>
        {source && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => open(section.sourceId, source?.kind === 'cloud_file' ? {} : input)}
          >
            {source?.kind === 'cloud_file' ? '폴더 보기' : '전체 보기'} <ArrowRight size={16} />
          </button>
        )}
      </div>
      {unsupported ? (
        <p className="discovery-message">{unsupported}</p>
      ) : !source || source.connection.state !== 'connected' ? (
        <p className="discovery-message">소스를 사용할 수 없습니다. 소스 관리에서 연결을 확인해 주세요.</p>
      ) : (
        <>
          {error && (
            <div className="discovery-message" role="status">
              {page ? '이전 목록을 표시하고 있습니다. ' : ''}
              {error}
              <button type="button" className="ghost-btn" disabled={loading} onClick={() => setRetry((v) => v + 1)}>
                다시 시도
              </button>
            </div>
          )}
          {candidate && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setPage(candidate);
                setCandidate(undefined);
              }}
            >
              새 목록 보기
            </button>
          )}
          {!page && !error && (
            <div className="discovery-skeleton" aria-label="목록 불러오는 중" aria-busy="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} />
              ))}
            </div>
          )}
          {page && (
            <>
              <div className="discovery-rail" ref={rail} aria-busy={loading}>
                {page.items.slice(0, 12).map((item) => (
                  <DiscoveryCard
                    key={JSON.stringify(item.key)}
                    item={item}
                    session={session}
                    inLibrary={owned(item)}
                    open={() =>
                      open(
                        section.sourceId,
                        item.navigationRef ? { parentRef: item.navigationRef } : input,
                        item.navigationRef ? item.title : undefined,
                      )
                    }
                  />
                ))}
              </div>
              {!page.items.length && <p className="discovery-message">조건에 맞는 작품이 없습니다.</p>}
              {page.items.length > 3 && (
                <div className="discovery-rail-controls">
                  <button
                    type="button"
                    aria-label={`${title} 이전 작품`}
                    onClick={() =>
                      rail.current?.scrollBy({ left: -rail.current.clientWidth * 0.8, behavior: 'smooth' })
                    }
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${title} 다음 작품`}
                    onClick={() => rail.current?.scrollBy({ left: rail.current.clientWidth * 0.8, behavior: 'smooth' })}
                  >
                    <ArrowRight size={18} />
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
