import type { WorkView } from '../../components/work-view';
import { DiscoveryCard, useNear } from './DiscoveryCard';
import { DiscoverySourceView } from './DiscoverySourceView';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import { useEffect, useRef, useState } from 'react';
import type { ExternalItemPage, ExternalItemSummary, ExternalSourceListInput } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { DiscoverySession } from './discovery-session';
import type { DiscoverySection as Section } from './discovery-config';

export function DiscoverySection({
  viewMode = 'grid',
  section,
  source,
  session,
  query,
  refresh,
  open,
  owned,
  positions,
}: {
  viewMode?: WorkView;
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
  const [expanded, setExpanded] = useNavigationViewState(`expanded:${session.scope}:${section.id}:${query}`, false);
  const collapse = () => {
    setExpanded(false);
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start' }));
  };
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
  const previous = useRef({ refresh, retry });
  const latest = useRef({ input, page });
  latest.current = { input, page };
  useEffect(() => {
    if (expanded || !near || unsupported || source?.connection.state !== 'connected') return;
    let active = true;
    const force = previous.current.refresh !== refresh || previous.current.retry !== retry;
    previous.current = { refresh, retry };
    setLoading(true);
    setError('');
    const fetchPage = async () => {
      const saved = await session.restore(section.sourceId, latest.current.input);
      if (active && saved && !latest.current.page) {
        setPage(saved);
        latest.current.page = saved;
      }
      if (!active) return undefined;
      if (section.filterSignature) {
        const schema = await session.schema(
          section.sourceId,
          { parentRef: section.parentRef, browseMode: section.mode },
          force,
        );
        if (JSON.stringify(schema.browse?.filters ?? []) !== section.filterSignature)
          throw new Error('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
      }
      return session.list(section.sourceId, latest.current.input, force);
    };
    void fetchPage()
      .then((result) => {
        if (!active || !result) return;
        if (result.cache?.stale) setError('연결을 확인하지 못했습니다.');
        if (result.browse && !result.browse.availableModes.includes(latest.current.input.browseMode ?? section.mode)) {
          setError('이 소스가 해당 목록을 지원하지 않습니다. 다른 목록을 선택해 주세요.');
          setPage(undefined);
          return;
        }
        if (section.filterSignature && JSON.stringify(result.browse?.filters ?? []) !== section.filterSignature) {
          setError('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
          setPage(undefined);
          return;
        }
        if (latest.current.page && !force && JSON.stringify(result.items) !== JSON.stringify(latest.current.page.items))
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
    expanded,
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
      </div>
      {expanded && !unsupported ? (
        <>
          <DiscoverySourceView
            viewMode={viewMode}
            section={section}
            source={source}
            session={session}
            refresh={refresh}
            open={open}
            owned={owned}
            controls={false}
            query={query}
          />
        </>
      ) : unsupported ? (
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
              <div className="discovery-rail" data-view={viewMode} ref={rail} aria-busy={loading}>
                {page.items.slice(0, 12).map((item) => (
                  <DiscoveryCard
                    viewMode={viewMode}
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
            </>
          )}
        </>
      )}
      <div className="discovery-section-footer">
        {source && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() =>
              source.kind === 'cloud_file' ? open(section.sourceId, {}) : expanded ? collapse() : setExpanded(true)
            }
            aria-expanded={source.kind === 'cloud_file' ? undefined : expanded}
          >
            {source?.kind === 'cloud_file' ? '폴더 보기' : expanded ? '접기' : '펼쳐 보기'}
          </button>
        )}
      </div>
    </section>
  );
}
