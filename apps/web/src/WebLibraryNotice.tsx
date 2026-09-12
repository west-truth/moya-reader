import { useState } from 'react';
import { Archive, ShieldCheck, X } from 'lucide-react';
import type { ProductLibraryNoticeProps } from '../../../src/app/runtime/app-runtime';
import { requestBrowserPersistence } from './browser-storage';
import { backupReminderDue, dismissWebBackupReminder, useWebDataSafety } from './web-data-safety';

export function WebLibraryNotice({ bookCount, busy, openBackup, openStorage }: ProductLibraryNoticeProps) {
  const safety = useWebDataSafety();
  const [protecting, setProtecting] = useState(false);
  const [message, setMessage] = useState('');
  if (!backupReminderDue(safety)) return null;
  async function protect() {
    setProtecting(true);
    try {
      const granted = await requestBrowserPersistence();
      setMessage(
        granted
          ? '자동 정리 방지를 요청했습니다. 책장은 백업 파일로도 보관해 주세요.'
          : '이 브라우저가 저장 보호를 허용하지 않았습니다. 백업 파일로 책장을 보관해 주세요.',
      );
    } catch {
      setMessage('저장 보호를 확인하지 못했습니다. 저장과 동기화에서 다시 시도할 수 있습니다.');
    } finally {
      setProtecting(false);
    }
  }
  return (
    <aside className="web-library-notice" aria-label="브라우저 서재 안내">
      <div className="web-library-notice-copy">
        <strong>{bookCount ? '읽던 기록도 함께 보관하세요' : '로그인 없이, 이 기기에 저장하는 서재'}</strong>
        <p>
          {bookCount
            ? safety.lastExportedAt
              ? '마지막 백업 생성 후 일주일이 지났습니다. 새 백업을 저장해 주세요.'
              : '책과 독서 기록은 이 브라우저에 있습니다. 백업 파일을 만들어 다른 기기에서도 이어가세요.'
            : '파일은 서버에 업로드하지 않습니다. 사이트 데이터를 삭제하면 서재도 지워지므로 백업으로 보관해 주세요.'}
        </p>
        <div className="web-storage-actions">
          {bookCount > 0 && (
            <button className="ghost-btn" disabled={busy} onClick={openBackup}>
              <Archive size={15} /> 백업 열기
            </button>
          )}
          <button className="ghost-btn" disabled={protecting} onClick={() => void protect()}>
            <ShieldCheck size={15} /> 저장 보호 요청
          </button>
          <button className="ghost-btn" onClick={openStorage}>
            저장·오프라인 설정
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </div>
      <button
        className="icon-btn"
        aria-label="서재 안내 일주일 숨기기"
        title="일주일 뒤 다시 안내"
        onClick={dismissWebBackupReminder}
      >
        <X size={16} />
      </button>
    </aside>
  );
}

export function WebBackupStatus() {
  const safety = useWebDataSafety();
  return (
    <section className="web-storage-panel" aria-label="책장 백업 상태">
      <h3>
        <Archive size={18} aria-hidden="true" /> 책장 백업
      </h3>
      <p>
        {safety.lastExportedAt
          ? `마지막 백업 생성: ${new Date(safety.lastExportedAt).toLocaleString('ko-KR')}`
          : '이 브라우저에서 만든 백업 기록이 없습니다.'}
      </p>
      <p>책장의 백업 메뉴에서 ZIP을 저장할 수 있습니다. 백업을 만든 뒤 다운로드가 완료됐는지도 확인해 주세요.</p>
      <p className="field-help">
        대형 서재는 전체 백업 한도(압축 전 256MiB·500개 항목)에 걸릴 수 있습니다. 원본 파일을 별도로 보관하고, 설정된
        Cloud Vault의 ‘작품 파일과 표지’를 함께 사용하세요.
      </p>
    </section>
  );
}
