import { useEffect } from 'react';
import { Download, WifiOff } from 'lucide-react';
import { formatBytes } from '../../../src/utils/format';
import {
  applyWebUpdate,
  checkWebUpdate,
  installWebApp,
  prepareWebOffline,
  refreshOfflineStatus,
  useWebPwa,
} from './web-pwa';

export function WebOfflinePanel() {
  const state = useWebPwa();
  useEffect(() => {
    void refreshOfflineStatus();
  }, []);
  const complete = Boolean(state.offline && state.offline.completed === state.offline.total);
  const remaining = state.offline ? Math.max(0, state.offline.totalBytes - state.offline.cachedBytes) : undefined;
  return (
    <section className="web-storage-panel" aria-label="인터넷 없이 읽기">
      <h3>
        <WifiOff size={18} aria-hidden="true" /> 인터넷 없이 읽기
      </h3>
      <p>
        {complete
          ? '이 브라우저에 저장한 책은 인터넷이 끊겨도 읽을 수 있어요.'
          : '선택 사항이에요. 인터넷이 없을 때도 읽고 싶다면, 연결된 지금 필요한 읽기 기능을 미리 받아 두세요.'}
      </p>
      <dl>
        <div>
          <dt>인터넷</dt>
          <dd>{state.online ? '연결됨' : '오프라인'}</dd>
        </div>
        <div>
          <dt>인터넷 없이 읽기</dt>
          <dd>
            {state.phase === 'unsupported'
              ? '이 환경에서 지원하지 않음'
              : state.phase === 'error'
                ? '설정하지 못함'
                : state.phase === 'starting'
                  ? '확인 중'
                  : state.preparing
                    ? '받는 중'
                    : complete
                      ? '사용 가능'
                      : '설정 전'}
          </dd>
        </div>
        {remaining !== undefined && !complete && (
          <div>
            <dt>추가 다운로드</dt>
            <dd>약 {formatBytes(remaining)}</dd>
          </div>
        )}
      </dl>
      {state.preparing && (
        <div role="status">
          <progress
            aria-label="읽기 기능 다운로드"
            max={state.offline?.total ?? 1}
            value={state.offline?.completed ?? 0}
          />
          <p>
            읽기 기능 받는 중 · {state.offline?.completed ?? 0}/{state.offline?.total ?? '…'}
          </p>
        </div>
      )}
      <div className="web-storage-actions">
        {!complete && (
          <button
            className="primary-btn"
            disabled={state.phase !== 'ready' || !state.online || state.preparing}
            onClick={() => void prepareWebOffline()}
          >
            <Download size={15} />
            {state.preparing ? '받는 중…' : '인터넷 없이 읽기 켜기'}
          </button>
        )}
        <button
          className="ghost-btn"
          disabled={!state.online || state.preparing || state.phase === 'unsupported'}
          onClick={() => void checkWebUpdate()}
        >
          업데이트 확인
        </button>
        {state.waiting && (
          <button className="primary-btn" disabled={state.busy || state.preparing} onClick={applyWebUpdate}>
            새 버전 적용
          </button>
        )}
        {state.installPrompt && (
          <button className="ghost-btn" onClick={() => void installWebApp()}>
            모야 설치 (선택)
          </button>
        )}
      </div>
      {state.waiting && (
        <p role="status">
          {state.busy
            ? '진행 중인 작업이 끝난 뒤 업데이트할 수 있습니다.'
            : '새 버전이 준비되었습니다. 적용하면 앱을 다시 엽니다.'}
        </p>
      )}
      {state.error && <p role="status">{state.error}</p>}
      {!state.online && !complete && <p className="field-help">이 기능을 켜려면 먼저 인터넷에 연결해 주세요.</p>}
      <details className="web-settings-details">
        <summary>사용 안내</summary>
        <p className="field-help">
          TXT·EPUB·PDF·만화를 읽는 데 필요한 기능을 이 브라우저에 저장합니다. 책은 직접 가져와 주세요. 인터넷이 연결돼
          있다면 이 설정 없이 바로 읽을 수 있습니다.
        </p>
        {!state.installed && (
          <p className="field-help">
            브라우저 메뉴의 ‘앱 설치’ 또는 ‘홈 화면에 추가’는 실행 아이콘을 만드는 선택 기능입니다. 설치하지 않아도
            인터넷 없이 읽을 수 있습니다.
          </p>
        )}
        <p className="field-help">
          클라우드 동기화·OCR 언어팩·일부 음성은 인터넷이 필요합니다. 이 설정은 책장 백업을 대신하지 않습니다.
        </p>
        {state.offline && <p className="field-help">현재 버전 {state.offline.version.slice(0, 10)}</p>}
      </details>
    </section>
  );
}
