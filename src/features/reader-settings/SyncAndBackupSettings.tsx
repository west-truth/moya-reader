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
            <p>서버 연결과 동기화 상태를 확인합니다.</p>
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
            <p>책장과 독서 기록을 백업하거나 복원합니다.</p>
          </div>
        </div>
        <button type="button" className="ghost-btn" onClick={openBackup}>
          백업과 복원 열기
        </button>
      </section>
      <p className="reader-settings-scope-note">리더 설정은 기기별로 유지됩니다.</p>
    </div>
  );
}
