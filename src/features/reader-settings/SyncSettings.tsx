import { useContext } from 'react';
import { EmbeddedAccessContext } from '../../platform/embedded-access-context';
import { DesktopServerSelectionSettings } from '../../platform/DesktopServerChoice';
import { RefreshCw } from 'lucide-react';

export function SyncSettings({ openSync }: { readonly openSync: () => void }) {
  const embedded = useContext(EmbeddedAccessContext);
  return (
    <div className="reader-settings-destination-sections">
      {embedded && <DesktopServerSelectionSettings />}
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
      <p className="reader-settings-scope-note">리더 설정은 기기별로 유지됩니다.</p>
    </div>
  );
}
