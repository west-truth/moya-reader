import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPopover } from '../../shared/ui/use-menu-popover';

/** Membership actions stay available even when the source itself is offline. */
export function LibraryExternalWorkMenu({
  title,
  disabled,
  remove,
}: {
  title: string;
  disabled: boolean;
  remove(): void | Promise<void>;
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
      top: rect.bottom + 60 < innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 60),
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
    <div className="library-external-work-menu" ref={menu.rootRef}>
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
            <button
              role="menuitem"
              type="button"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                menu.triggerRef.current?.focus({ preventScroll: true });
                void remove();
              }}
            >
              <Trash2 size={16} /> 휴지통으로 이동
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
