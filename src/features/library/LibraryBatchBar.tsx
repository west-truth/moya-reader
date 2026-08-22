import { Download, FolderMinus, FolderPlus, RotateCcw, Star, StarOff, Tag, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LibraryScreenProps } from './library-screen-contract';

function ActiveLibraryBatchBar({ model, actions }: LibraryScreenProps) {
  const defaultShelfId = model.management.activeShelfId ?? model.management.shelves[0]?.id ?? '';
  const [shelfId, setShelfId] = useState(defaultShelfId);
  const [tag, setTag] = useState('');
  const disabled = model.management.selectedBookIds.size === 0 || model.management.busy;

  useEffect(() => {
    if (shelfId && model.management.shelves.some((shelf) => shelf.id === shelfId)) return;
    setShelfId(model.management.activeShelfId ?? model.management.shelves[0]?.id ?? '');
  }, [model.management.activeShelfId, model.management.shelves, shelfId]);

  return (
    <div className="library-batch-bar" role="toolbar" aria-label="선택한 책 일괄 작업">
      <div className="library-batch-summary">
        <div>
          <strong>{model.management.selectedBookIds.size}권</strong>
          <span>선택됨</span>
        </div>
        <button className="icon-btn" type="button" aria-label="선택 종료" onClick={actions.controls.clearSelection}>
          <X size={17} />
        </button>
      </div>

      {model.management.shelves.length > 0 && (
        <div className="library-batch-group library-batch-shelf">
          <span className="library-batch-label">책장 · 컬렉션</span>
          <select value={shelfId} aria-label="일괄 작업 책장" onChange={(event) => setShelfId(event.target.value)}>
            {model.management.shelves.map((shelf) => (
              <option key={shelf.id} value={shelf.id}>
                {shelf.name}
              </option>
            ))}
          </select>
          <button
            className="ghost-btn"
            disabled={disabled || !shelfId}
            onClick={() => void actions.controls.applyBatch({ kind: 'add_to_shelf', shelfId })}
          >
            <FolderPlus size={16} /> 선택 책장에 추가
          </button>
          <button
            className="ghost-btn"
            disabled={disabled || !shelfId}
            onClick={() => void actions.controls.applyBatch({ kind: 'remove_from_shelf', shelfId })}
          >
            <FolderMinus size={16} /> 선택 책장에서 제외
          </button>
        </div>
      )}

      <div className="library-batch-group library-batch-tags">
        <span className="library-batch-label">태그</span>
        <label className="batch-tag-input">
          <Tag size={15} />
          <input
            value={tag}
            maxLength={80}
            aria-label="일괄 태그"
            placeholder="태그 입력"
            onChange={(event) => setTag(event.target.value)}
          />
        </label>
        <button
          className="ghost-btn"
          disabled={disabled || !tag.trim()}
          onClick={() => void actions.controls.applyBatch({ kind: 'add_tag', tag })}
        >
          추가
        </button>
        <button
          className="ghost-btn"
          disabled={disabled || !tag.trim()}
          onClick={() => void actions.controls.applyBatch({ kind: 'remove_tag', tag })}
        >
          제거
        </button>
      </div>

      <div className="library-batch-utilities">
        <button
          className="icon-btn"
          disabled={disabled}
          aria-label="선택한 책 즐겨찾기 설정"
          onClick={() => void actions.controls.applyBatch({ kind: 'set_favorite', favorite: true })}
        >
          <Star size={17} />
        </button>
        <button
          className="icon-btn"
          disabled={disabled}
          aria-label="선택한 책 즐겨찾기 해제"
          onClick={() => void actions.controls.applyBatch({ kind: 'set_favorite', favorite: false })}
        >
          <StarOff size={17} />
        </button>
        <button
          className="icon-btn"
          disabled={disabled}
          aria-label="선택한 책 정보 내보내기"
          onClick={actions.controls.exportSelectedMetadata}
        >
          <Download size={17} />
        </button>
        <button
          className="ghost-btn danger"
          disabled={disabled}
          onClick={() =>
            void actions.controls.applyBatch(
              model.filter === 'trash' ? { kind: 'restore_from_trash' } : { kind: 'move_to_trash' },
            )
          }
        >
          {model.filter === 'trash' ? <RotateCcw size={16} /> : <Trash2 size={16} />}
          {model.filter === 'trash' ? '복원' : '휴지통'}
        </button>
      </div>
    </div>
  );
}

export function LibraryBatchBar(props: LibraryScreenProps) {
  return props.model.management.selectionMode ? <ActiveLibraryBatchBar {...props} /> : null;
}
