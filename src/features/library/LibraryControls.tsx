import { CheckSquare, Filter, Folder, FolderCog, Grid2X2, List, Trash2, X } from 'lucide-react';
import { formatCount } from '../../utils/format';
import type { LibraryFilter } from './library-screen-model';
import type { LibraryScreenProps } from './library-screen-contract';

const filterLabels: Record<LibraryFilter, string> = {
  all: '모든 작품',
  reading: '읽는 중',
  finished: '완독',
  unread: '미독',
  favorite: '즐겨찾기',
  trash: '휴지통',
};

export function LibraryControls({ model, actions }: LibraryScreenProps) {
  const counts = model.collection.filterCounts;
  const activeShelf = model.management.shelves.find((shelf) => shelf.id === model.management.activeShelfId);
  const heading = activeShelf?.name ?? filterLabels[model.filter];

  return (
    <section className="library-toolbar" aria-label="작품 목록 도구">
      <div className="library-toolbar-heading">
        <h1>{heading}</h1>
        <span>{formatCount(model.collection.visibleBooks.length)}권</span>
      </div>

      <div className="library-mobile-controls">
        <label>
          <Filter size={15} aria-hidden="true" />
          <select
            value={model.filter}
            onChange={(event) => actions.controls.setFilter(event.target.value as LibraryFilter)}
            aria-label="책장 필터"
          >
            {(Object.keys(filterLabels) as LibraryFilter[]).map((filter) => (
              <option key={filter} value={filter}>
                {filterLabels[filter]} ({formatCount(counts[filter])})
              </option>
            ))}
          </select>
        </label>
        {model.management.available && (
          <label>
            <Folder size={15} aria-hidden="true" />
            <select
              value={model.management.activeShelfId ?? ''}
              onChange={(event) => actions.controls.setShelf(event.target.value || undefined)}
              aria-label="책장 선택"
            >
              <option value="">전체 책장</option>
              {model.management.shelves.map((shelf) => (
                <option key={shelf.id} value={shelf.id}>
                  {shelf.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="library-toolbar-actions">
        <label className="library-sort-select">
          <span className="sr-only">책장 정렬</span>
          <select
            value={model.sort}
            onChange={(event) => actions.controls.setSort(event.target.value as typeof model.sort)}
            aria-label="책장 정렬"
          >
            <option value="recent">최근 읽은 순</option>
            <option value="title">제목 순</option>
            <option value="added">최근 추가 순</option>
          </select>
        </label>
        <div className="library-view-control" role="group" aria-label="책장 보기 방식">
          <button
            type="button"
            className={model.viewMode === 'list' ? 'active' : ''}
            onClick={() => actions.controls.setViewMode('list')}
            aria-label="목록 보기"
            aria-pressed={model.viewMode === 'list'}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            className={model.viewMode === 'grid' ? 'active' : ''}
            onClick={() => actions.controls.setViewMode('grid')}
            aria-label="표지 보기"
            aria-pressed={model.viewMode === 'grid'}
          >
            <Grid2X2 size={16} />
          </button>
        </div>
        {model.management.available && !model.management.selectionMode && (
          <button className="ghost-btn library-select-start" type="button" onClick={actions.controls.startSelection}>
            <CheckSquare size={16} /> 선택
          </button>
        )}
        {model.management.available && (
          <button
            className="icon-btn library-shelf-settings"
            type="button"
            title="책장 관리"
            aria-label="책장 관리"
            onClick={actions.controls.openShelves}
          >
            <FolderCog size={16} />
          </button>
        )}
        {model.management.selectionMode && (
          <div className="library-selection-controls">
            <strong>{model.management.selectedBookIds.size}권 선택</strong>
            <button className="ghost-btn" type="button" onClick={actions.controls.selectVisible}>
              모두 선택
            </button>
            <button className="icon-btn" type="button" aria-label="선택 종료" onClick={actions.controls.clearSelection}>
              <X size={17} />
            </button>
          </div>
        )}
        {model.filter === 'trash' && counts.trash > 0 && (
          <button className="ghost-btn danger" type="button" onClick={() => void actions.controls.emptyTrash()}>
            <Trash2 size={16} /> 비우기
          </button>
        )}
      </div>
    </section>
  );
}
