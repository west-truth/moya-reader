import type { ReaderAddonIconName } from '@noveldesk/extension-contracts';
import { BarChart3, FileText, Headphones, List, StickyNote, Wand2, X, type LucideIcon } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { useDismissibleLayer, useMediaQuery } from '../../shared/ui/use-dismissible-layer';
import type { ReaderAddonTab } from './reader-screen-contract';

export interface ReaderAddonTabDescriptor {
  readonly id: ReaderAddonTab;
  readonly label: string;
  readonly icon: ReaderAddonIconName;
  readonly order?: number;
}

export const CORE_READER_ADDON_TABS: readonly ReaderAddonTabDescriptor[] = [
  { id: 'outline', label: '목차', icon: 'list', order: 20 },
  { id: 'tts', label: '듣기', icon: 'headphones', order: 30 },
  { id: 'notes', label: '주석', icon: 'notes', order: 40 },
  { id: 'stats', label: '통계', icon: 'chart', order: 50 },
];

const icons: Record<ReaderAddonIconName, LucideIcon> = {
  chart: BarChart3,
  'file-text': FileText,
  headphones: Headphones,
  list: List,
  notes: StickyNote,
  wand: Wand2,
};

export interface ReaderAddonShellProps {
  readonly activeTab: ReaderAddonTab;
  readonly tabs: readonly ReaderAddonTabDescriptor[];
  readonly children: ReactNode;
  setActiveTab(tab: ReaderAddonTab): void;
  close(): void;
}

export function ReaderAddonShell({ activeTab, tabs, children, setActiveTab, close }: ReaderAddonShellProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const modal = useMediaQuery('(max-width: 699px)');
  useDismissibleLayer({
    open: true,
    modal,
    containerRef: panelRef,
    initialFocusRef: closeRef,
    onClose: close,
  });

  return (
    <aside
      ref={panelRef}
      className="addon-panel"
      role="dialog"
      aria-modal={modal || undefined}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="panel-header">
        <div>
          <span id={titleId}>읽기 도구</span>
          <strong>{tabs.find((tab) => tab.id === activeTab)?.label}</strong>
        </div>
        <button ref={closeRef} className="icon-btn" type="button" onClick={close} aria-label="읽기 도구 닫기">
          <X size={18} />
        </button>
      </header>
      <nav className="panel-tabs" role="tablist" aria-label="읽기 도구 분류">
        {tabs.map((tab) => {
          const Icon = icons[tab.icon];
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={activeTab === tab.id ? 'active' : ''}
              onClick={() => setActiveTab(tab.id)}
              aria-selected={activeTab === tab.id}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="addon-panel-content" role="tabpanel">
        {children}
      </div>
    </aside>
  );
}
