import { LoaderCircle, RotateCcw, X } from 'lucide-react';
import { importTaskIsActive, importTaskLabel, type ImportTaskView } from '../import/import-task-projection';
import type { LibraryScreenProps } from './library-screen-contract';

export function LibraryImportTaskOverlay({
  task,
  compact = false,
}: {
  readonly task: ImportTaskView;
  readonly compact?: boolean;
}) {
  const active = importTaskIsActive(task);
  return (
    <div
      className={`book-import-overlay${active ? '' : ' is-failed'}${compact ? ' is-compact' : ''}`}
      role="status"
      aria-label={importTaskLabel(task)}
    >
      {active ? <LoaderCircle size={24} className="spin" /> : <span aria-hidden="true">!</span>}
      <strong>{importTaskLabel(task)}</strong>
      {task.total && task.total > 1 && (
        <small>
          {Math.min(task.total, task.current ?? 0)}/{task.total}
        </small>
      )}
    </div>
  );
}

export function LibraryImportTaskActions({
  task,
  actions,
}: Pick<LibraryScreenProps, 'actions'> & { task: ImportTaskView }) {
  if (importTaskIsActive(task)) return null;
  return (
    <div className="card-actions import-task-actions">
      <button className="mini-icon-btn" type="button" title="다시 시도" onClick={() => actions.imports.open(task)}>
        <RotateCcw size={15} />
      </button>
      <button className="mini-icon-btn" type="button" title="닫기" onClick={() => actions.imports.dismiss(task.id)}>
        <X size={15} />
      </button>
    </div>
  );
}

export function LibraryImportTaskCard({
  task,
  actions,
}: Pick<LibraryScreenProps, 'actions'> & { task: ImportTaskView }) {
  return (
    <article className="book-card import-task-card" role="listitem" data-state={task.phase}>
      <button
        type="button"
        className="book-card-open"
        aria-label={`${task.title} 가져오기 상태 열기`}
        onClick={() => actions.imports.open(task)}
      />
      <div className="book-cover-wrap">
        <div className="book-cover import-task-cover" aria-hidden="true" />
        <LibraryImportTaskOverlay task={task} />
      </div>
      <div className="book-info">
        <div className="book-title-line">
          <h3>{task.title}</h3>
        </div>
        <p>{task.fileName}</p>
        <div className="card-row">
          <strong>{importTaskLabel(task)}</strong>
          <span>{task.error}</span>
          <LibraryImportTaskActions task={task} actions={actions} />
        </div>
      </div>
    </article>
  );
}

export function LibraryImportTaskListRow({
  task,
  actions,
}: Pick<LibraryScreenProps, 'actions'> & { task: ImportTaskView }) {
  return (
    <article className="book-list-row import-task-card" role="listitem" data-state={task.phase}>
      <button
        type="button"
        className="book-card-open"
        aria-label={`${task.title} 가져오기 상태 열기`}
        onClick={() => actions.imports.open(task)}
      />
      <div className="book-cover-wrap">
        <div className="book-cover thumb import-task-cover" aria-hidden="true" />
        <LibraryImportTaskOverlay task={task} />
      </div>
      <div className="book-list-main">
        <div className="book-list-title">
          <h3>{task.title}</h3>
        </div>
        <p>{task.fileName}</p>
      </div>
      <div className="book-list-progress">
        <strong>{importTaskLabel(task)}</strong>
        <span>{task.error}</span>
      </div>
      <LibraryImportTaskActions task={task} actions={actions} />
    </article>
  );
}
