import { formatCount, formatDateTime } from '../../utils/format';
import type { AnnotationsController } from './useAnnotationsController';

export function AnnotationNoteSection({ controller }: { controller: AnnotationsController }) {
  const { filteredNotes, scopedNotes } = controller.view;
  return (
    <section className="annotation-section" aria-labelledby="annotation-notes-heading">
      <div className="panel-section-title">
        <h4 id="annotation-notes-heading">메모</h4>
        <span>
          {formatCount(filteredNotes.length)} / {formatCount(scopedNotes.length)}
        </span>
      </div>
      <div className="note-list">
        {scopedNotes.length === 0 ? (
          <p className="empty-panel">
            {controller.scope === 'chapter'
              ? '현재 화에 저장된 메모가 없습니다.'
              : '선택한 문장이나 현재 위치에 메모를 남길 수 있습니다.'}
          </p>
        ) : filteredNotes.length === 0 ? (
          <p className="empty-panel">검색 결과가 없습니다.</p>
        ) : (
          filteredNotes.map((note) => (
            <article key={note.id} className={controller.editingNoteId === note.id ? 'is-editing' : undefined}>
              {note.quote && <blockquote>{note.quote}</blockquote>}
              <p>{note.body}</p>
              <small>
                {controller.view.chapterTitleById.get(note.chapterId) ?? '알 수 없는 화'} ·{' '}
                {formatDateTime(note.updatedAt)}
              </small>
              <footer>
                <button type="button" onClick={() => void controller.goToNote(note)}>
                  이동
                </button>
                <button type="button" onClick={() => controller.editNote(note)}>
                  수정
                </button>
                <button type="button" onClick={() => void controller.deleteNote(note.id)}>
                  삭제
                </button>
              </footer>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
