import { Trash2 } from 'lucide-react';
import { formatCount, formatDateTime } from '../../utils/format';
import type { AnnotationsController } from './useAnnotationsController';

export function AnnotationBookmarkSection({ controller }: { controller: AnnotationsController }) {
  const { filteredBookmarks, scopedBookmarks } = controller.view;
  return (
    <section className="annotation-section" aria-labelledby="annotation-bookmarks-heading">
      <div className="panel-section-title">
        <h4 id="annotation-bookmarks-heading">북마크</h4>
        <span>
          {formatCount(filteredBookmarks.length)} / {formatCount(scopedBookmarks.length)}
        </span>
      </div>
      <div className="annotation-list">
        {scopedBookmarks.length === 0 ? (
          <p className="empty-panel">
            {controller.scope === 'chapter' ? '현재 화에 저장된 북마크가 없습니다.' : '저장된 북마크가 없습니다.'}
          </p>
        ) : filteredBookmarks.length === 0 ? (
          <p className="empty-panel">검색 결과가 없습니다.</p>
        ) : (
          filteredBookmarks.map((bookmark) => (
            <div className="annotation-row" key={bookmark.id}>
              <button
                type="button"
                className="annotation-row-main"
                onClick={() => void controller.goToBookmark(bookmark)}
              >
                <span>{bookmark.label}</span>
                <small>
                  {controller.view.chapterTitleById.get(bookmark.chapterId) ?? '알 수 없는 화'} ·{' '}
                  {formatDateTime(bookmark.createdAt)}
                </small>
              </button>
              <button
                type="button"
                className="mini-icon-btn"
                onClick={() => void controller.deleteBookmark(bookmark.id)}
                aria-label={`${bookmark.label} 북마크 삭제`}
                title="북마크 삭제"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
