import { useDiscoveryScroll } from './useDiscoveryScroll';
import { useRef, useState } from 'react';
import { Compass, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { LibrarySidebar, LibraryMobileHeader, LibraryNavigationButton } from '../library/LibraryChrome';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { ExternalSourceListInput } from '../../external-sources/contracts';
import type { DiscoveryController } from './useDiscoveryController';
import { DiscoveryEditor } from './DiscoveryEditor';
import { DiscoverySection } from './DiscoverySection';
import { SourceQuickJump } from './SourceQuickJump';
import './discovery.css';

export default function DiscoveryScreen({
  library,
  discovery,
  sources,
  open,
}: {
  library: LibraryScreenProps;
  discovery: DiscoveryController;
  sources: ExternalSourceController;
  open(source: string, input: ExternalSourceListInput, title?: string): void;
}) {
  const { config, scope, session } = discovery;
  const tabs = config.tabs.filter((t) => !t.hidden);
  const [selected, setSelected] = useNavigationViewState(`discovery-tab:${scope}`, tabs[0]?.id ?? '');
  const tab = tabs.find((t) => t.id === selected) ?? tabs[0];
  const [editing, setEditing] = useState(false);
  const [quickJump, setQuickJump] = useState(false);
  const [draftQuery, setDraftQuery] = useNavigationViewState(`discovery-draft:${scope}`, '');
  const [query, setQuery] = useNavigationViewState(`discovery-query:${scope}`, '');
  const [searchSource, setSearchSource] = useNavigationViewState(`discovery-search-source:${scope}`, 'all');
  const [refresh, setRefresh] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = session.railPositions;
  useDiscoveryScroll(scroll, `discovery:${scope}:${tab?.id}:${query}:${searchSource}`, session);
  const sectionSources = [...new Set(tab?.sections.map((s) => s.sourceId) ?? [])];
  const rows = query
    ? sectionSources
        .filter((id) => searchSource === 'all' || id === searchSource)
        .map((id) => ({ id: `search:${id}`, sourceId: id, title: '', mode: 'popular' as const }))
    : (tab?.sections ?? []);
  return (
    <main className="library-screen discovery-screen">
      <div className="library-product-shell">
        <LibrarySidebar {...library} />
        <section className="library-workspace discovery-workspace">
          <LibraryMobileHeader
            {...library}
            sourceMode={{
              title: '탐색',
              query: draftQuery,
              setQuery: setDraftQuery,
              search: () => setQuery(draftQuery.trim()),
              searchable: false,
            }}
          />
          <header className="discovery-topbar">
            <div>
              <LibraryNavigationButton {...library} />
              <Compass size={23} />
              <h1>탐색</h1>
            </div>
            <div>
              <button
                type="button"
                className="ghost-btn"
                aria-label="탐색 목록 새로고침"
                onClick={() => setRefresh((v) => v + 1)}
              >
                <RefreshCw size={18} />
              </button>
              <button type="button" className="ghost-btn" onClick={() => setEditing(true)}>
                <SlidersHorizontal size={17} /> 탐색 편집
              </button>
            </div>
          </header>
          <div className="discovery-body" ref={scroll}>
            <div className="discovery-tab-row">
              <nav className="discovery-tabs" aria-label="탐색 분류">
                {tabs.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    aria-current={t.id === tab?.id ? 'page' : undefined}
                    onClick={() => {
                      setSelected(t.id);
                      setQuery('');
                      setDraftQuery('');
                      setSearchSource('all');
                    }}
                  >
                    {t.title}
                  </button>
                ))}
              </nav>
              <button type="button" className="ghost-btn" aria-haspopup="dialog" onClick={() => setQuickJump(true)}>
                빠른 이동
              </button>
            </div>
            <form
              className="discovery-search"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(draftQuery.trim());
              }}
            >
              <Search size={18} />
              <input
                type="search"
                value={draftQuery}
                aria-label="탐색 작품 검색"
                placeholder="이 탭에서 작품 찾기"
                onChange={(e) => setDraftQuery(e.target.value)}
              />
              <select aria-label="검색할 소스" value={searchSource} onChange={(e) => setSearchSource(e.target.value)}>
                <option value="all">이 탭의 모든 소스</option>
                {sectionSources.map((id) => (
                  <option key={id} value={id}>
                    {sources.sources.find((s) => s.id === id)?.title ?? '사용할 수 없는 소스'}
                  </option>
                ))}
              </select>
              <button className="primary-btn" type="submit">
                검색
              </button>
              {query && (
                <button
                  className="ghost-btn discovery-search-reset"
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setDraftQuery('');
                  }}
                >
                  초기화
                </button>
              )}
            </form>
            {!rows.length ? (
              <div className="discovery-empty">
                <Compass size={44} />
                <h2>나만의 탐색 화면을 만들어 보세요</h2>
                <p>좋아하는 소스의 인기·최신 작품을 모아 보세요.</p>
                <div>
                  <button type="button" className="primary-btn" onClick={() => setEditing(true)}>
                    소스와 목록 선택
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={library.actions.header.openExternalSourceSettings}
                  >
                    소스 관리
                  </button>
                </div>
              </div>
            ) : (
              <div className="discovery-sections" data-density={tab?.density}>
                {rows.map((section) => {
                  const source = sources.sources.find((s) => s.id === section.sourceId);
                  const key = JSON.stringify([
                    section,
                    query,
                    source?.connection.state,
                    source?.connection.accountConnectionId,
                    source?.connection.connectionGeneration,
                  ]);
                  return (
                    <DiscoverySection
                      key={key}
                      section={section}
                      source={source}
                      session={session}
                      query={query}
                      refresh={refresh}
                      positions={positions}
                      open={open}
                      owned={(item) =>
                        sources.libraryWorks.some(
                          (work) =>
                            work.connectorId === item.key.connectorId &&
                            work.accountConnectionId === item.key.accountConnectionId &&
                            work.collectionRemoteId === item.key.remoteId,
                        )
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
      {editing && (
        <DiscoveryEditor
          config={config}
          sources={sources.sources}
          save={discovery.save}
          close={() => setEditing(false)}
        />
      )}
      {quickJump && <SourceQuickJump sources={sources.sources} close={() => setQuickJump(false)} open={open} />}
    </main>
  );
}
