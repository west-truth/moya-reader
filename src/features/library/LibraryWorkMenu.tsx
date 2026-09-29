import { Download, FolderInput, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPopover } from '../../shared/ui/use-menu-popover';

/** Membership actions stay available even when the source itself is offline. */
export function LibraryWorkMenu({
  title,
  disabled,
  remove,
  rename,
  move,
  download,
  downloadDisabled = false,
}: {
  title: string;
  disabled: boolean;
  remove(): void | Promise<void>;
  rename?(): void;
  move?(): void;
  download?(): void | Promise<void>;
  downloadDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const menu = useMenuPopover(open, setOpen);
  const placeMenu = useCallback(() => {
    const rect = menu.triggerRef.current?.getBoundingClientRect();
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) {
      setOpen(false);
      return;
    }
    setPosition({
      left: Math.max(8, Math.min(rect.right - 224, innerWidth - 232)),
      top: rect.bottom + 190 < innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 190),
    });
  }, [menu.triggerRef]);
  useEffect(() => {
    if (!open) return;
    const reposition = (event: Event) => {
      if (event.target instanceof Node && menu.menuRef.current?.contains(event.target)) return;
      placeMenu();
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, menu.menuRef, placeMenu]);
  return (
    <div className="library-work-menu" ref={menu.rootRef}>
      <button
        type="button"
        className="icon-btn"
        ref={menu.triggerRef}
        disabled={disabled}
        aria-label={`${title} 더보기`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          placeMenu();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        createPortal(
          <div
            role="menu"
            aria-label={`${title} 작품 관리`}
            className="library-work-popover"
            ref={menu.menuRef}
            style={position}
            onKeyDown={menu.onMenuKeyDown}
          >
            {[
              { label: '제목 수정', icon: Pencil, run: rename },
              { label: '책장 이동', icon: FolderInput, run: move },
              { label: '다운로드', icon: Download, run: download, unavailable: downloadDisabled },
              { label: '휴지통으로 이동', icon: Trash2, run: remove, danger: true },
            ]
              .filter((action) => action.run)
              .map(({ label, icon: Icon, run, unavailable, danger }) => (
                <button
                  key={label}
                  role="menuitem"
                  type="button"
                  className={danger ? 'danger' : undefined}
                  disabled={disabled || unavailable}
                  title={unavailable ? '보관된 원본 파일이 없습니다.' : undefined}
                  onClick={() => {
                    setOpen(false);
                    menu.triggerRef.current?.focus({ preventScroll: true });
                    void run?.();
                  }}
                >
                  <Icon size={16} /> {label}
                </button>
              ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
