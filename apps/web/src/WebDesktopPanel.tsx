import { ExternalLink, Laptop } from 'lucide-react';
import './web.css';

const releasesUrl = 'https://github.com/west-truth/moya-reader/releases';

function desktopDownloadUrl(): string | undefined {
  try {
    const url = new URL(import.meta.env.VITE_DESKTOP_DOWNLOAD_URL);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function WebDesktopPanel() {
  const downloadUrl = desktopDownloadUrl();
  return (
    <section className="web-storage-panel web-desktop-panel" aria-label="데스크톱 앱으로 이어가기">
      <h3>
        <Laptop size={18} aria-hidden="true" /> 데스크톱 앱으로 이어가기
      </h3>
      <p>웹에서는 파일을 가져와 읽고, 독서 기록을 이 브라우저에 보관할 수 있습니다.</p>
      <p>
        메타데이터·표지 수집과 네이티브 파일 연동은 데스크톱 앱에서 사용할 수 있습니다. AI 분석·외부 음성 합성은 제공자
        설정이 필요하며, 지원 범위는 앱 버전에 따라 다릅니다.
      </p>
      <div className="web-storage-actions">
        <a className="primary-btn" href={downloadUrl ?? releasesUrl} target="_blank" rel="noreferrer">
          {downloadUrl ? '데스크톱 앱 다운로드' : '데스크톱 출시 확인'} <ExternalLink size={15} aria-hidden="true" />
        </a>
      </div>
      {!downloadUrl && <p className="field-help">설치 파일이 공개되면 릴리스 페이지에서 받을 수 있습니다.</p>}
      <details>
        <summary>웹에서 읽던 책 옮기기</summary>
        <ol>
          <li>책장의 ‘백업’ 또는 ‘더보기 → 백업 및 복원’에서 ‘백업 만들기’를 선택합니다.</li>
          <li>데스크톱 앱의 ‘백업 및 복원’에서 저장한 ZIP을 ‘백업 파일 선택’으로 엽니다.</li>
          <li>기존 책과 겹치는 항목을 확인하고 복원합니다. 원본, 읽던 위치와 주석을 함께 옮깁니다.</li>
        </ol>
        <p>
          양쪽에서 Dropbox를 연결하면 Cloud Vault로 동기화할 수도 있습니다. 원본까지 옮기려면 ‘작품 파일과 표지’를 켜
          주세요.
        </p>
        <p className="field-help">
          설치만으로 서재가 자동 이동하지는 않습니다. 복원이 끝나고 책과 기록을 확인할 때까지 웹 서재와 백업 파일을
          보관하세요.
        </p>
      </details>
    </section>
  );
}
