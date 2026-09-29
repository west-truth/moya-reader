import { LibraryWorkMenu } from './LibraryWorkMenu';
import { LibraryCountLabel } from './LibraryCountLabel';
import { BookOpen, Check, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, formatProgress } from '../../utils/format';
import { importTaskIsActive, importTaskLabel, type ImportTaskView } from '../import/import-task-projection';
import type { LibraryExternalWorkView, LibraryScreenProps } from './library-screen-contract';
import { externalWorkListMeta, externalWorkReleaseLabel } from './library-source-progress';
import { LibraryImportTaskActions, LibraryImportTaskOverlay } from './LibraryImportTaskItems';
import { LibraryReadingProgress } from './LibraryReadingProgress';

interface ExternalWorkItemProps extends Pick<LibraryScreenProps, 'actions'> {
  readonly selectionMode?: boolean;
  readonly selected?: boolean;
  readonly busy?: boolean;
  readonly work: LibraryExternalWorkView;
  readonly importTask?: ImportTaskView;
  readonly showReadingCounts?: boolean;
}

function SelectionMark({ selected }: { selected?: boolean }) {
  return (
    <span className="book-selection-mark" aria-hidden="true">
      {selected && <Check size={15} />}
    </span>
  );
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
          key={url}
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

function ExternalWorkActions({ work, actions, selectionMode }: ExternalWorkItemProps) {
  if (selectionMode) return null;
  if (work.deletedAt)
    return (
      <div className="card-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={`${work.title} 복원`}
          title="복원"
          onClick={() => void actions.books.restoreExternal?.(work.id)}
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="icon-btn danger"
          aria-label={`${work.title} 영구 삭제`}
          title="영구 삭제"
          onClick={() => void actions.books.purgeExternal?.(work.id)}
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
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
    </div>
  );
}

/** A streamed work reads like any library book: cover, progress, last read and a direct continue. */
export function ExternalWorkCard({
  work,
  actions,
  importTask,
  showReadingCounts,
  selectionMode,
  selected,
  busy,
}: ExternalWorkItemProps) {
  const progress = workProgress(work);
  return (
    <article className={`book-card external-work-card${selected ? ' is-selected' : ''}`} role="listitem">
      {(selectionMode || !work.deletedAt) && (
        <button
          type="button"
          className="book-card-open"
          aria-pressed={selectionMode ? Boolean(selected) : undefined}
          disabled={selectionMode && (busy || Boolean(importTask && importTaskIsActive(importTask)))}
          aria-label={
            selectionMode ? `${work.title} ${selected ? '선택 해제' : '선택'}` : `${work.title} 원격 회차 열기`
          }
          onClick={() =>
            selectionMode ? actions.books.toggleSelectedExternal?.(work.id) : void actions.books.openExternal(work.id)
          }
        />
      )}
      <div className="book-cover-wrap">
        <ExternalWorkCover work={work} thumbnail />
        {selectionMode && <SelectionMark selected={selected} />}
        {importTask && <LibraryImportTaskOverlay task={importTask} />}
      </div>
      <div className="book-info">
        <div className="book-title-line">
          <h3>{work.title}</h3>
          {!selectionMode && !work.deletedAt && (
            <LibraryWorkMenu
              title={work.title}
              disabled={Boolean(busy || (importTask && importTaskIsActive(importTask)))}
              remove={() => actions.books.removeExternal(work.id)}
              rename={actions.books.renameExternal ? () => actions.books.renameExternal!(work.id) : undefined}
              move={actions.books.moveExternalToShelf ? () => actions.books.moveExternalToShelf!(work.id) : undefined}
              download={actions.books.downloadExternal ? () => actions.books.downloadExternal!(work.id) : undefined}
            />
          )}
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
        {!work.deletedAt && (
          <LibraryReadingProgress
            novel={{ title: work.title }}
            progress={progress}
            positionLabel={externalWorkReleaseLabel(work)}
            className="card-progress"
          />
        )}
        <div className="card-row">
          <strong>
            {work.deletedAt ? (
              '휴지통'
            ) : importTask ? (
              importTaskLabel(importTask)
            ) : showReadingCounts ? (
              <LibraryCountLabel current={work.readReleaseCount ?? 0} total={work.availableReleaseCount} unit="화" />
            ) : (
              formatProgress(progress)
            )}
          </strong>
          <span>{workLastReadLabel(work)}</span>
          {!selectionMode && importTask?.phase === 'failed' ? (
            <LibraryImportTaskActions task={importTask} actions={actions} />
          ) : (
            <ExternalWorkActions work={work} actions={actions} importTask={importTask} selectionMode={selectionMode} />
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
  selectionMode,
  selected,
  busy,
}: ExternalWorkItemProps & { readonly showCover?: boolean }) {
  const progress = workProgress(work);
  return (
    <article className={`book-list-row external-work-list-row${selected ? ' is-selected' : ''}`} role="listitem">
      {(selectionMode || !work.deletedAt) && (
        <button
          type="button"
          className="book-card-open"
          aria-pressed={selectionMode ? Boolean(selected) : undefined}
          disabled={selectionMode && (busy || Boolean(importTask && importTaskIsActive(importTask)))}
          aria-label={
            selectionMode ? `${work.title} ${selected ? '선택 해제' : '선택'}` : `${work.title} 원격 회차 열기`
          }
          onClick={() =>
            selectionMode ? actions.books.toggleSelectedExternal?.(work.id) : void actions.books.openExternal(work.id)
          }
        />
      )}
      {showCover && (
        <div className="book-cover-wrap">
          <ExternalWorkCover work={work} thumbnail={false} />
          {selectionMode && <SelectionMark selected={selected} />}
          {importTask && <LibraryImportTaskOverlay task={importTask} />}
        </div>
      )}
      <div className="book-list-main">
        <div className="book-list-title">
          {!showCover && selectionMode && <SelectionMark selected={selected} />}
          <h3>{work.title}</h3>
          {!selectionMode && !work.deletedAt && (
            <LibraryWorkMenu
              title={work.title}
              disabled={Boolean(busy || (importTask && importTaskIsActive(importTask)))}
              remove={() => actions.books.removeExternal(work.id)}
              rename={actions.books.renameExternal ? () => actions.books.renameExternal!(work.id) : undefined}
              move={actions.books.moveExternalToShelf ? () => actions.books.moveExternalToShelf!(work.id) : undefined}
              download={actions.books.downloadExternal ? () => actions.books.downloadExternal!(work.id) : undefined}
            />
          )}
        </div>
        <p>{externalWorkListMeta(work)}</p>
        {!work.deletedAt && (
          <LibraryReadingProgress
            novel={{ title: work.title }}
            progress={progress}
            positionLabel={externalWorkReleaseLabel(work)}
            className="card-progress"
          />
        )}
      </div>
      <div className="book-list-progress">
        <strong>
          {work.deletedAt ? '휴지통' : importTask ? importTaskLabel(importTask) : formatProgress(progress)}
        </strong>
        <span>{work.newReleaseCount > 0 ? `새 회차 ${work.newReleaseCount}개` : workLastReadLabel(work)}</span>
      </div>
      {!selectionMode && importTask?.phase === 'failed' ? (
        <LibraryImportTaskActions task={importTask} actions={actions} />
      ) : (
        <ExternalWorkActions work={work} actions={actions} importTask={importTask} selectionMode={selectionMode} />
      )}
    </article>
  );
}
