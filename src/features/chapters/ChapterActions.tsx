import { useState } from 'react';
import { MoreHorizontal, Check, ListChecks, Pencil } from 'lucide-react';
import type { Chapter } from '../../domain/types';
import { Dialog } from '../../shared/ui/Dialog';
import type { ChaptersScreenActions } from './chapters-screen-contract';

export function ChapterActions({
  chapter,
  read,
  actions,
}: {
  chapter: Chapter;
  read: boolean;
  actions: ChaptersScreenActions['chapterList'];
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chapter.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void> | undefined) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  if (!actions.markRead && !actions.rename) return null;
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={`${chapter.title} 작업`}
        onClick={() => {
          setTitle(chapter.title);
          setEditing(false);
          setError('');
          setOpen(true);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      <Dialog
        open={open}
        title={editing ? '회차 제목 수정' : chapter.title}
        onClose={() => setOpen(false)}
        closeDisabled={busy}
        className="chapter-actions-dialog"
      >
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => actions.rename?.(chapter, title));
            }}
          >
            <label>
              제목
              <input
                aria-label="회차 제목"
                value={title}
                maxLength={200}
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="chapter-actions-buttons">
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => setEditing(false)}>
                취소
              </button>
              <button type="submit" className="primary-btn" disabled={busy || !title.trim()}>
                저장
              </button>
            </div>
          </form>
        ) : (
          <div className="chapter-actions-list">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || read || !actions.markRead}
              onClick={() => void run(() => actions.markRead?.(chapter, false))}
            >
              <Check size={16} />
              {read ? '읽음' : '읽음으로 변경'}
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !actions.markRead}
              onClick={() => void run(() => actions.markRead?.(chapter, true))}
            >
              <ListChecks size={16} />
              이전 회차 모두 읽음
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !actions.rename}
              onClick={() => setEditing(true)}
            >
              <Pencil size={16} />
              제목 수정
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
