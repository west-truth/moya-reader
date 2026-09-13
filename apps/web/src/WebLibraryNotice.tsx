import { Archive, X } from 'lucide-react';
import type { ProductLibraryNoticeProps } from '../../../src/app/runtime/app-runtime';
import { dismissWebIntroduction, useWebDataSafety } from './web-data-safety';
import { requestWebStoragePanel } from './web-settings-navigation';

export function WebLibraryNotice({ openStorage }: ProductLibraryNoticeProps) {
  const safety = useWebDataSafety();
  if (safety.introductionDismissed) return null;
  return (
    <aside className="web-library-notice" aria-label="브라우저 서재 안내">
      <div className="web-library-notice-copy">
        <strong>파일을 가져오면 바로 읽을 수 있어요</strong>
        <p>책과 읽던 위치는 자동 저장됩니다.</p>
        <div className="web-storage-actions">
          <button
            className="ghost-btn"
            onClick={() => {
              requestWebStoragePanel();
              openStorage();
            }}
          >
            인터넷 없이 읽기
          </button>
        </div>
      </div>
      <button
        className="icon-btn"
        aria-label="서재 안내 닫기"
        title="다시 표시하지 않기"
        onClick={dismissWebIntroduction}
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
      <p>백업은 선택 사항입니다. 책장의 백업 메뉴에서 책과 독서 기록을 ZIP 파일로 따로 보관할 수 있습니다.</p>
      <details className="web-settings-details">
        <summary>백업 안내</summary>
        <p className="field-help">
          사이트 데이터 삭제나 기기 분실에 대비해 중요한 기록은 백업해 두세요. ZIP 다운로드 완료를 확인해 주세요. 전체
          백업은 압축 전 256MiB·500개 항목까지 지원하므로 큰 원본 파일은 별도로 보관하세요.
        </p>
      </details>
    </section>
  );
}
