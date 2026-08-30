import { GitCompareArrows } from 'lucide-react';
import { useMemo } from 'react';
import { formatCount } from '../../utils/format';
import { structurePreviewWindow } from './chapter-structure-view-model';
import type { ChapterStructureController } from './useChapterStructureController';
import type { ChapterStructureChapterView } from '@noveldesk/text-core/chapter-structure';

function chapterIdentity(chapter: ChapterStructureChapterView): string {
  return `${chapter.rawStartOffset}:${chapter.rawEndOffset}:${chapter.title}`;
}

export default function ChapterStructurePreview({ controller }: { controller: ChapterStructureController }) {
  const preview = controller.preview!;
  const window = useMemo(() => structurePreviewWindow(preview.before, preview.after), [preview]);
  const beforeKeys = useMemo(() => new Set(preview.after.map(chapterIdentity)), [preview.after]);
  const afterKeys = useMemo(() => new Set(preview.before.map(chapterIdentity)), [preview.before]);
  const reviewRisk = preview.impact.readerAnnotationsAtRisk + preview.impact.correctionsForReview;

  return (
    <div className="chapter-structure-preview">
      <header>
        <GitCompareArrows size={20} />
        <span>
          <strong>변경 결과</strong>
          <small>
            {preview.before.length}화 → {preview.after.length}화
          </small>
        </span>
      </header>

      <dl>
        <div>
          <dt>화 수</dt>
          <dd>
            {preview.before.length} → {preview.after.length}
          </dd>
        </div>
        <div>
          <dt>유지되는 문단</dt>
          <dd>{formatCount(preview.impact.preservedParagraphs)}</dd>
        </div>
        <div>
          <dt>확인할 독서 기록</dt>
          <dd>{formatCount(reviewRisk)}</dd>
        </div>
      </dl>

      {(window.hiddenBefore > 0 || window.hiddenAfter > 0) && (
        <p className="structure-preview-omission">변경되지 않은 앞뒤 화는 생략했습니다.</p>
      )}

      <div className="structure-preview-columns">
        <div>
          <strong>현재 구조</strong>
          <div className="structure-preview-titles">
            {window.before.map((chapter) => (
              <span className={!beforeKeys.has(chapterIdentity(chapter)) ? 'removed' : ''} key={chapter.id}>
                <b>{chapter.index}화</b>
                <span>{chapter.title}</span>
                <small>{formatCount(chapter.characterCount)}자</small>
              </span>
            ))}
          </div>
        </div>
        <div>
          <strong>변경 후</strong>
          <div className="structure-preview-titles">
            {window.after.map((chapter) => (
              <span className={!afterKeys.has(chapterIdentity(chapter)) ? 'added' : ''} key={chapter.id}>
                <b>{chapter.index}화</b>
                <span>{chapter.title}</span>
                <small>{formatCount(chapter.characterCount)}자</small>
              </span>
            ))}
          </div>
        </div>
      </div>

      {preview.warnings.map((warning) => (
        <p className="field-help warning" key={warning}>
          {warning}
        </p>
      ))}

      <div className="dialog-actions chapter-structure-preview-actions">
        <button type="button" className="ghost-btn" onClick={controller.clearPreview} disabled={controller.busy}>
          돌아가기
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() => void controller.applyPreview()}
          disabled={controller.busy}
        >
          변경 적용
        </button>
      </div>
    </div>
  );
}
