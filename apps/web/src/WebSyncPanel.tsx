import { Dialog } from '../../../src/shared/ui/Dialog';
import type { SyncPanelProps } from '../../../src/features/sync/sync-panel-contract';
import { CloudVaultSection } from '../../../src/features/cloud-vault/CloudVaultSection';
import { WebDataSettings } from './WebDataSettings';

export default function WebSyncPanel({ data, actions }: SyncPanelProps) {
  return (
    <Dialog
      open
      title="저장과 동기화"
      onClose={actions.close}
      className="settings-panel sync-panel"
      closeLabel="동기화 패널 닫기"
    >
      <WebDataSettings />
      <CloudVaultSection controller={data.cloudVault} />
      {!data.cloudVault.connected && !data.cloudVault.dropboxAvailable && (
        <p className="cloud-vault-notice">
          이 배포에서는 Dropbox 연결이 아직 준비되지 않았습니다. 책장의 백업 메뉴에서 파일로 저장하거나, 지원되는
          브라우저에서는 로컬 동기화 폴더를 선택할 수 있습니다.
        </p>
      )}
    </Dialog>
  );
}
