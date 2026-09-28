import { Dialog } from '../../../src/shared/ui/Dialog';
import type { SyncPanelProps } from '../../../src/features/sync/sync-panel-contract';
import { CloudAccountsPanel } from '../../../src/features/cloud-vault/CloudAccountsPanel';
import { WebDataSettings } from './WebDataSettings';
import { useEffect, useState } from 'react';
import { resetWebSettingsPanel, takeWebSettingsPanel } from './web-settings-navigation';

export default function WebSyncPanel({ data, actions, embedded = false }: SyncPanelProps) {
  const [panel, setPanel] = useState(takeWebSettingsPanel);
  useEffect(resetWebSettingsPanel, []);
  const content = (
    <>
      <nav className="web-storage-actions" aria-label="저장과 동기화 메뉴">
        <button
          className={panel === 'sync' ? 'primary-btn' : 'ghost-btn'}
          aria-pressed={panel === 'sync'}
          onClick={() => setPanel('sync')}
        >
          계정 · 동기화
        </button>
        <button
          className={panel === 'storage' ? 'primary-btn' : 'ghost-btn'}
          aria-pressed={panel === 'storage'}
          onClick={() => setPanel('storage')}
        >
          저장 · 오프라인
        </button>
      </nav>
      {panel === 'storage' ? <WebDataSettings /> : <CloudAccountsPanel controller={data.cloudVault} />}
    </>
  );
  if (embedded) return <div className="sync-panel sync-panel-embedded">{content}</div>;
  return (
    <Dialog
      open
      title="저장과 동기화"
      onClose={actions.close}
      className="settings-panel sync-panel"
      closeLabel="동기화 패널 닫기"
    >
      {content}
    </Dialog>
  );
}
