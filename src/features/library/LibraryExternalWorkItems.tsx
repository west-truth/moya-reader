import { BookOpen, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, formatProgress } from '../../utils/format';
import { importTaskIsActive, importTaskLabel, type ImportTaskView } from '../import/import-task-projection';
import type { LibraryExternalWorkView, LibraryScreenProps } from './library-screen-contract';
import { externalWorkListMeta, externalWorkReleaseLabel } from './library-source-progress';
import { LibraryImportTaskActions, LibraryImportTaskOverlay } from './LibraryImportTaskItems';
import { LibraryReadingProgress } from './LibraryReadingProgress';

interface ExternalWorkItemProps extends Pick<LibraryScreenProps, 'actions'> {
  readonly work: LibraryExternalWorkView;
  readonly importTask?: ImportTaskView;
}

function workProgress(work: LibraryExternalWorkView): number {
  return work.availableReleaseCount > 0 ? Math.min(1, (work.readReleaseCount ?? 0) / work.availableReleaseCount) : 0;
}

function workLastReadLabel(work: LibraryExternalWorkView): string {
  return work.lastReadAt ? formatDateTime(work.lastReadAt) : '읽은 기록 없음';
}

function ExternalWorkCover({ work, thumbnail }: { work: LibraryExternalWorkView; thumbnail: boolean }) {
  // A cover that fails to load (expired link, offline source) falls back like a missing one.
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = work.thumbnailUrl && work.thumbnailUrl !== failedUrl ? work.thumbnailUrl : undefined;
  return (
    <div className={['book-cover', thumbnail ? 'has-remote-cover' : 'thumb'].join(' ')}>
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className="external-work-cover-fallback" aria-hidden="true">
          <BookOpen size={32} />
        </span>
      )}
    </div>
  );
}

function ExternalWorkActions({ work, actions, importTask }: ExternalWorkItemProps) {
  const continueLabel = work.lastReadAt ? '이어 보기' : '첫 화 보기';
  const continueExternal = actions.books.continueExternal;
  return (
    <div className="card-actions">
      {continueExternal && (
        <button
          type="button"
          className="book-direct-action book-continue-action"
          title={continueLabel}
          aria-label={`${work.title} ${continueLabel}`}
          onClick={() => void continueExternal(work.id)}
        >
          <Play size={13} fill="currentColor" />
          <span>{continueLabel}</span>
        </button>
      )}
      <button
        type="button"
        className="mini-icon-btn book-remove-action"
        title="라이브러리에서 제거"
        aria-label={`${work.title} 라이브러리에서 제거`}
        disabled={Boolean(importTask && importTaskIsActive(importTask))}
        onClick={() => void actions.books.removeExternal(work.id)}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

/** A streamed work reads like any library book: cover, progress, last read and a direct continue. */
export function ExternalWorkCard({ work, actions, importTask }: ExternalWorkItemProps) {
  const progress = workProgress(work);
  return (
    <article className="book-card external-work-card" role="listitem">
      <button
        type="button"
        className="book-card-open"
        aria-label={`${work.title} 원격 회차 열기`}
        onClick={() => void actions.books.openExternal(work.id)}
      />
      <div className="book-cover-wrap">
        <ExternalWorkCover work={work} thumbnail />
        {importTask && <LibraryImportTaskOverlay task={importTask} />}
      </div>
      <div className="book-info">
        <div className="book-title-line">
          <h3>{work.title}</h3>
        </div>
        <p>
          {[
            work.author,
            work.sourceLabel,
            externalWorkReleaseLabel(work),
            work.newReleaseCount > 0 ? `새 회차 ${work.newReleaseCount}개` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <LibraryReadingProgress
          novel={{ title: work.title }}
          progress={progress}
          positionLabel={externalWorkReleaseLabel(work)}
          className="card-progress"
        />
        <div className="card-row">
          <strong>{importTask ? importTaskLabel(importTask) : formatProgress(progress)}</strong>
          <span>{workLastReadLabel(work)}</span>
          {importTask?.phase === 'failed' ? (
            <LibraryImportTaskActions task={importTask} actions={actions} />
          ) : (
            <ExternalWorkActions work={work} actions={actions} importTask={importTask} />
          )}
        </div>
      </div>
    </article>
  );
}

export function ExternalWorkListRow({
  work,
  actions,
  importTask,
  showCover = true,
}: ExternalWorkItemProps & { readonly showCover?: boolean }) {
  const progress = workProgress(work);
  return (
    <article className="book-list-row external-work-list-row" role="listitem">
      <button
        type="button"
        className="book-card-open"
        aria-label={`${work.title} 원격 회차 열기`}
        onClick={() => void actions.books.openExternal(work.id)}
      />
      {showCover && (
        <div className="book-cover-wrap">
          <ExternalWorkCover work={work} thumbnail={false} />
          {importTask && <LibraryImportTaskOverlay task={importTask} />}
        </div>
      )}
      <div className="book-list-main">
        <div className="book-list-title">
          <h3>{work.title}</h3>
        </div>
        <p>{externalWorkListMeta(work)}</p>
        <LibraryReadingProgress
          novel={{ title: work.title }}
          progress={progress}
          positionLabel={externalWorkReleaseLabel(work)}
          className="card-progress"
        />
      </div>
      <div className="book-list-progress">
        <strong>{importTask ? importTaskLabel(importTask) : formatProgress(progress)}</strong>
        <span>{work.newReleaseCount > 0 ? `새 회차 ${work.newReleaseCount}개` : workLastReadLabel(work)}</span>
      </div>
      {importTask?.phase === 'failed' ? (
        <LibraryImportTaskActions task={importTask} actions={actions} />
      ) : (
        <ExternalWorkActions work={work} actions={actions} importTask={importTask} />
      )}
    </article>
  );
}
