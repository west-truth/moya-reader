import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
export function CollapsibleNavigation({
  name,
  scope,
  active,
  action,
  children,
}: {
  name: string;
  scope: string;
  active?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const key = `moya.navigation.collapsed:${scope}:${name}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => {
      try {
        setCollapsed(localStorage.getItem(key) === 'true');
      } catch {
        /* Keep session state. */
      }
    };
    window.addEventListener('moya-navigation-changed', read);
    return () => window.removeEventListener('moya-navigation-changed', read);
  }, [key]);
  return (
    <section>
      <div className="library-sidebar-section-head">
        <button
          type="button"
          className="library-collapse-toggle library-sidebar-label"
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={() => {
            setCollapsed(!collapsed);
            try {
              localStorage.setItem(key, String(!collapsed));
              window.dispatchEvent(new Event('moya-navigation-changed'));
            } catch {
              /* This session still works. */
            }
          }}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          <span>{name}</span>
          {collapsed && active && <small>{active}</small>}
        </button>
        {action}
      </div>
      <div id={id} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
