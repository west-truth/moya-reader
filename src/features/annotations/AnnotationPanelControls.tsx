import { BookmarkIcon, ClipboardCopy, Download, Search, StickyNote, X } from 'lucide-react';
import type { AnnotationsController } from './useAnnotationsController';

export function AnnotationPanelControls({ controller }: { controller: AnnotationsController }) {
  return (
    <>
      <label className="search-box panel-search">
        <Search size={15} aria-hidden="true" />
        <input
          aria-label="주석 검색"
          value={controller.query}
          onChange={(event) => controller.setQuery(event.target.value)}
          placeholder="북마크, 하이라이트, 메모, 화 제목 검색"
        />
      </label>
      <div className="segmented full" aria-label="주석 범위">
        <button
          type="button"
          className={controller.scope === 'all' ? 'active' : ''}
          onClick={() => controller.setScope('all')}
          aria-pressed={controller.scope === 'all'}
        >
          전체
        </button>
        <button
          type="button"
          className={controller.scope === 'chapter' ? 'active' : ''}
          onClick={() => controller.setScope('chapter')}
          aria-pressed={controller.scope === 'chapter'}
        >
          현재 화
        </button>
      </div>
      <div className="segmented full" aria-label="주석 정렬">
        <button
          type="button"
          className={controller.sort === 'recent' ? 'active' : ''}
          onClick={() => controller.setSort('recent')}
          aria-pressed={controller.sort === 'recent'}
        >
          최근순
        </button>
        <button
          type="button"
          className={controller.sort === 'position' ? 'active' : ''}
          onClick={() => controller.setSort('position')}
          aria-pressed={controller.sort === 'position'}
        >
          본문순
        </button>
      </div>
      <div className="annotation-export-actions">
        <button type="button" className="ghost-btn" onClick={() => void controller.copyMarkdown()}>
          <ClipboardCopy size={16} /> Markdown 복사
        </button>
        <button type="button" className="ghost-btn" onClick={controller.downloadMarkdown}>
          <Download size={16} /> 파일 저장
        </button>
      </div>
      <button type="button" className="ghost-btn wide" onClick={() => void controller.toggleBookmark()}>
        <BookmarkIcon size={17} />
        {controller.view.activeBookmark ? '현재 위치 북마크 제거' : '현재 위치 북마크'}
      </button>
      <label className="annotation-note-editor">
        <textarea
          aria-label="메모 내용"
          value={controller.noteDraft}
          onChange={(event) => controller.setNoteDraft(event.target.value)}
          placeholder={
            controller.editingNoteId ? '메모 내용을 수정하세요.' : '선택한 문장 또는 현재 위치에 메모를 남기세요.'
          }
        />
      </label>
      <div className="note-editor-actions">
        <button
          type="button"
          className="primary-btn wide"
          onClick={() => void controller.saveNoteDraft()}
          disabled={!controller.noteDraft.trim()}
        >
          <StickyNote size={17} /> {controller.editingNoteId ? '수정 저장' : '메모 저장'}
        </button>
        {controller.editingNoteId && (
          <button type="button" className="ghost-btn" onClick={controller.resetEditor}>
            <X size={17} /> 취소
          </button>
        )}
      </div>
    </>
  );
}
