import { ArchiveRestore, RefreshCw } from 'lucide-react';

export function SyncAndBackupSettings({
  openSync,
  openBackup,
}: {
  readonly openSync: () => void;
  readonly openBackup: () => void;
}) {
  return (
    <div className="reader-settings-destination-sections">
      <section className="settings-section-card reader-settings-destination-card">
        <div className="settings-section-heading">
          <RefreshCw size={18} aria-hidden="true" />
          <div>
            <h3>동기화</h3>
            <p>self-host 연결, 대기 중인 변경, 충돌과 마지막 동기화 상태를 확인합니다.</p>
          </div>
        </div>
        <button type="button" className="primary-btn" onClick={openSync}>
          동기화 상태 열기
        </button>
      </section>
      <section className="settings-section-card reader-settings-destination-card">
        <div className="settings-section-heading">
          <ArchiveRestore size={18} aria-hidden="true" />
          <div>
            <h3>백업과 복원</h3>
            <p>책장과 읽기 데이터를 백업 파일로 만들거나 기존 백업을 검토한 뒤 복원합니다.</p>
          </div>
        </div>
        <button type="button" className="ghost-btn" onClick={openBackup}>
          백업과 복원 열기
        </button>
      </section>
      <p className="reader-settings-scope-note">
        리더 모양과 조작은 현재 기기에 저장됩니다. 소스 로그인과 책장 동기화는 서로 다른 연결입니다.
      </p>
    </div>
  );
}
