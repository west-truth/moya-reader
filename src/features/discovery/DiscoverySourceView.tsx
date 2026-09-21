import type { WorkView } from '../../components/work-view';
import { useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import type {
  ExternalSourceBrowseState,
  ExternalItemSummary,
  ExternalSourceFilterChange,
  ExternalSourceFilterValue,
  ExternalSourceListInput,
} from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { SourceFilterControl } from '../external-sources/SourceFilterControl';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import { DiscoveryCard } from './DiscoveryCard';
import type { DiscoverySession } from './discovery-session';
import type { DiscoverySection } from './discovery-config';
import { useDiscoveryPages } from './useDiscoveryPages';

export function DiscoverySourceView({
  viewMode = 'grid',
  section,
  source,
  session,
  refresh,
  open,
  owned,
  controls = true,
  query = '',
}: {
  viewMode?: WorkView;
  section: DiscoverySection;
  source?: ExternalSourceView;
  session: DiscoverySession;
  refresh: number;
  open(source: string, input: ExternalSourceListInput, title?: string): void;
  owned(item: ExternalItemSummary): boolean;
  controls?: boolean;
  query?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const initial: ExternalSourceListInput = {
    parentRef: section.parentRef,
    browseMode: query ? 'search' : section.mode,
    query: query || undefined,
    filters: section.filters,
  };
  const stateKey = `source-view:${section.id}:${session.key(section.sourceId, initial)}`;
  const [savedInput, setInput] = useNavigationViewState<ExternalSourceListInput>(stateKey, initial);
  const input = controls ? savedInput : initial;
  const [draftQuery, setDraftQuery] = useNavigationViewState(`${stateKey}:query`, input.query ?? '');
  const [values, setValues] = useNavigationViewState<Record<string, ExternalSourceFilterValue>>(
    `${stateKey}:filters`,
    {},
  );
  const [filtersOpen, setFiltersOpen] = useNavigationViewState(`${stateKey}:open`, false);
  const data = useDiscoveryPages(
    session,
    section.sourceId,
    input,
    refresh,
    source?.connection.state === 'connected',
    input.filters?.length ? section.filterSignature : undefined,
  );
  const [browse, setBrowse] = useNavigationViewState<ExternalSourceBrowseState | undefined>(
    `${stateKey}:schema`,
    undefined,
  );
  useEffect(() => {
    if (data.browse) setBrowse(data.browse);
  }, [data.browse, setBrowse]);
  const definitions = (data.browse ?? browse)?.filters ?? [];
  const fields = definitions.filter((f) => f.kind !== 'header' && f.kind !== 'separator');
  const activeFilters =
    input.browseMode === 'search'
      ? fields.filter((f) => {
          const value = input.filters?.find(
            (v) => v.position === f.position && v.groupPosition === f.groupPosition,
          )?.value;
          return value !== undefined && JSON.stringify(value) !== JSON.stringify(f.defaultValue);
        })
      : [];
  const filterSummary = activeFilters
    .slice(0, 2)
    .map((f) => {
      const value = input.filters?.find((v) => v.position === f.position && v.groupPosition === f.groupPosition)?.value;
      if (f.kind === 'select' && typeof value === 'number') return `${f.label}: ${f.options[value]}`;
      if (f.kind === 'tri_state') return `${f.label} ${value === 'EXCLUDE' ? '제외' : '포함'}`;
      return f.label;
    })
    .join(' · ');
  const modes = (data.browse ?? browse)?.availableModes ?? ['popular', 'search'];
  const setRequest = (next: ExternalSourceListInput) => {
    setInput(next);
    root.current?.scrollIntoView({ block: 'start' });
  };
  const apply = () => {
    const filters: ExternalSourceFilterChange[] = fields.map((f) => ({
      position: f.position,
      groupPosition: f.groupPosition,
      value:
        values[f.id] ??
        input.filters?.find((v) => v.position === f.position && v.groupPosition === f.groupPosition)?.value ??
        f.defaultValue,
    }));
    setRequest({ parentRef: section.parentRef, browseMode: 'search', query: draftQuery.trim() || undefined, filters });
  };
  if (!source || source.connection.state !== 'connected')
    return <p className="discovery-message">소스를 사용할 수 없습니다. 소스 관리에서 연결을 확인해 주세요.</p>;
  return (
    <div className="discovery-source-view" ref={root}>
      {controls && (
        <>
          <h2>{section.title || source.title}</h2>
          <div className="discovery-source-modes" aria-label="작품 목록">
            {modes
              .filter((mode) => mode !== 'search')
              .map((mode) => (
                <button
                  key={mode}
                  className="ghost-btn"
                  type="button"
                  aria-pressed={input.browseMode === mode}
                  onClick={() => {
                    setDraftQuery('');
                    setValues({});
                    setRequest({ parentRef: section.parentRef, browseMode: mode });
                  }}
                >
                  {mode === 'popular' ? '인기' : '최신'}
                </button>
              ))}
          </div>
          {modes.includes('search') && (
            <form
              className="discovery-search"
              onSubmit={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              <Search size={18} aria-hidden="true" />
              <input
                aria-label="소스 작품 검색"
                placeholder="작품 검색"
                type="search"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
              />
              <button className="primary-btn" type="submit">
                검색
              </button>
              {(input.query || input.filters?.length) && (
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => {
                    setDraftQuery('');
                    setValues({});
                    setRequest({ parentRef: section.parentRef, browseMode: section.mode });
                  }}
                >
                  초기화
                </button>
              )}
            </form>
          )}
          {fields.length > 0 && modes.includes('search') && (
            <details
              className="discovery-filters"
              open={filtersOpen}
              onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
            >
              <summary>
                상세 필터{filterSummary ? ` · ${filterSummary}` : ''}
                {activeFilters.length > 2 ? ` 외 ${activeFilters.length - 2}개` : ''}
              </summary>
              <div className="discovery-filter-fields">
                {definitions.map((definition) => (
                  <SourceFilterControl
                    key={definition.id}
                    definition={definition}
                    value={
                      values[definition.id] ??
                      input.filters?.find(
                        (v) => v.position === definition.position && v.groupPosition === definition.groupPosition,
                      )?.value
                    }
                    setValue={(value) => setValues({ ...values, [definition.id]: value })}
                    compactChoices
                  />
                ))}
              </div>
              <div className="discovery-filter-actions">
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => setValues(Object.fromEntries(fields.map((f) => [f.id, f.defaultValue])))}
                >
                  조건 초기화
                </button>
                <button className="primary-btn" type="button" onClick={apply}>
                  적용
                </button>
              </div>
            </details>
          )}
        </>
      )}
      {data.error && (
        <div className="discovery-message" role="status">
          {data.hasPage ? '불러온 작품은 그대로 표시합니다. ' : ''}
          {data.error}
          <button type="button" className="ghost-btn" disabled={data.busy} onClick={data.retry}>
            다시 시도
          </button>
        </div>
      )}
      {!data.hasPage && data.busy && <p role="status">작품을 불러오는 중…</p>}
      <div className="discovery-grid" data-view={viewMode} aria-busy={data.busy}>
        {data.items.map((item) => (
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
      {data.hasPage && !data.items.length && <p className="discovery-message">조건에 맞는 작품이 없습니다.</p>}
      {data.more && !data.error && (
        <button className="ghost-btn discovery-load-more" type="button" disabled={data.busy} onClick={data.loadMore}>
          {data.busy ? '불러오는 중…' : '더 불러오기'}
        </button>
      )}
    </div>
  );
}
