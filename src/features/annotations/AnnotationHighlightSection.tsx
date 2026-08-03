import { Trash2 } from 'lucide-react';
import type { ReaderHighlight } from '../../domain/types';
import { formatCount, formatDateTime } from '../../utils/format';
import type { AnnotationsController } from './useAnnotationsController';

const HIGHLIGHT_PALETTE: Array<{ color: ReaderHighlight['color']; label: string }> = [
  { color: 'yellow', label: '노랑' },
  { color: 'green', label: '초록' },
  { color: 'blue', label: '파랑' },
  { color: 'pink', label: '분홍' },
];

export function AnnotationHighlightSection({ controller }: { controller: AnnotationsController }) {
  const { activeHighlight, filteredHighlights, scopedHighlights } = controller.view;
  return (
    <section className="annotation-section" aria-labelledby="annotation-highlights-heading">
      <div className="panel-section-title">
        <h4 id="annotation-highlights-heading">하이라이트</h4>
        <span>
          {formatCount(filteredHighlights.length)} / {formatCount(scopedHighlights.length)}
        </span>
      </div>
      <div className="highlight-palette" aria-label="하이라이트 색상">
        {HIGHLIGHT_PALETTE.map((item) => (
          <button
            key={item.color}
            type="button"
            className={`highlight-swatch ${item.color}${activeHighlight?.color === item.color ? ' active' : ''}`}
            onClick={() => void controller.setHighlight(item.color)}
            title={`${item.label} 하이라이트`}
            aria-label={`${item.label} 하이라이트`}
            aria-pressed={activeHighlight?.color === item.color}
          />
        ))}
      </div>
      <div className="annotation-list">
        {scopedHighlights.length === 0 ? (
          <p className="empty-panel">
            {controller.scope === 'chapter'
              ? '현재 화에 저장된 하이라이트가 없습니다.'
              : '저장된 하이라이트가 없습니다.'}
          </p>
        ) : filteredHighlights.length === 0 ? (
          <p className="empty-panel">검색 결과가 없습니다.</p>
        ) : (
          filteredHighlights.map((highlight) => (
            <div className="annotation-row" key={highlight.id}>
              <button
                type="button"
                className="annotation-row-main"
                onClick={() => void controller.goToHighlight(highlight)}
              >
                <span>{highlight.quote}</span>
                <small>
                  {controller.view.chapterTitleById.get(highlight.chapterId) ?? '알 수 없는 화'} ·{' '}
                  {formatDateTime(highlight.updatedAt)}
                </small>
              </button>
              <button
                type="button"
                className="mini-icon-btn"
                onClick={() => void controller.deleteHighlight(highlight.id)}
                aria-label="하이라이트 삭제"
                title="하이라이트 삭제"
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
