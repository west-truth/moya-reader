import { MoreHorizontal, Check, Circle, ListChecks, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPopover } from '../../shared/ui/use-menu-popover';
import { Dialog } from '../../shared/ui/Dialog';
import type { ExternalSourceController, ExternalSourceItemView } from './useExternalSourceController';

export function SourceReleaseMenu({
  item,
  controller,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const menu = useMenuPopover(open, setOpen);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const invoke = (action: () => Promise<void> | undefined) => {
    setOpen(false);
    menu.triggerRef.current?.focus();
    void action()?.catch(() => undefined);
  };
  const canDelete = Boolean(item.localBookId && ['imported', 'update_available'].includes(item.importState));
  return (
    <div className="source-release-menu" ref={menu.rootRef}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn source-hub-release-action"
        title="더보기"
        aria-label={`${item.title} 더보기`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={controller.busy}
        onClick={() => {
          const rect = menu.triggerRef.current!.getBoundingClientRect();
          setPosition({
            left: Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)),
            top: rect.bottom + 220 < window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 220),
          });
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          ref={menu.menuRef}
          role="menu"
          className="source-release-popover"
          style={position}
          onKeyDown={menu.onMenuKeyDown}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => invoke(() => controller.setReleasesRead?.([item], item.readingState !== 'read'))}
          >
            {item.readingState === 'read' ? <Circle size={16} /> : <Check size={16} />}
            {item.readingState === 'read' ? '안 읽음으로 변경' : '읽음으로 변경'}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => invoke(() => controller.markPreviousReleasesRead?.(item))}
          >
            <ListChecks size={16} />
            이전 회차 모두 읽음
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setTitle(item.title);
              setError('');
              setEditing(true);
            }}
          >
            <Pencil size={16} />
            제목 수정
          </button>
          {canDelete && (
            <>
              <hr />
              <button
                role="menuitem"
                type="button"
                aria-label={`${item.title} 다운로드 삭제`}
                onClick={() => invoke(() => controller.deleteDownloads([item]))}
              >
                <Trash2 size={16} />
                다운로드 삭제
              </button>
            </>
          )}
        </div>
      )}
      {editing &&
        createPortal(
          <Dialog
            open
            title="회차 제목 수정"
            onClose={() => setEditing(false)}
            closeDisabled={controller.busy}
            className="source-release-title-dialog"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setError('');
                void controller
                  .renameRelease?.(item, title)
                  .then(() => setEditing(false))
                  .catch((reason) => setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'));
              }}
            >
              <label>
                제목
                <input
                  aria-label="회차 제목"
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  autoFocus
                />
              </label>
              <p className="muted">원문의 제목과 내용은 변경하지 않습니다.</p>
              {error && <p role="alert">{error}</p>}
              <div className="source-release-title-actions">
                <button
                  className="ghost-btn"
                  type="button"
                  disabled={controller.busy}
                  onClick={() => setTitle(item.originalTitle ?? item.title)}
                >
                  원래 제목
                </button>
                <button
                  className="ghost-btn"
                  type="button"
                  disabled={controller.busy}
                  onClick={() => setEditing(false)}
                >
                  취소
                </button>
                <button className="primary-btn" type="submit" disabled={controller.busy || !title.trim()}>
                  저장
                </button>
              </div>
            </form>
          </Dialog>,
          document.body,
        )}
    </div>
  );
}
