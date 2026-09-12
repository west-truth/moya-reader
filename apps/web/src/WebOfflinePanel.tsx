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
    <section className="web-storage-panel" aria-label="앱과 오프라인">
      <h3>
        <WifiOff size={18} aria-hidden="true" /> 앱과 오프라인
      </h3>
      <p>
        {complete
          ? '모든 형식의 오프라인 준비가 끝났습니다. 이 기기에 가져온 책을 인터넷 없이 읽을 수 있습니다.'
          : '앱은 필요한 화면부터 받습니다. 인터넷 없이 처음 여는 책이나 PDF·만화를 사용하려면 모든 형식을 미리 준비하세요.'}
      </p>
      <dl>
        <div>
          <dt>인터넷</dt>
          <dd>{state.online ? '연결됨' : '오프라인'}</dd>
        </div>
        <div>
          <dt>오프라인 준비</dt>
          <dd>
            {state.phase === 'unsupported'
              ? '이 환경에서 지원하지 않음'
              : state.phase === 'error'
                ? '준비 실패'
                : state.phase === 'starting'
                  ? '앱 준비 중'
                  : complete
                    ? '모든 형식 준비됨'
                    : '열어 본 화면 저장됨'}
          </dd>
        </div>
        {remaining !== undefined && !complete && (
          <div>
            <dt>추가 다운로드</dt>
            <dd>약 {formatBytes(remaining)} · 전송 시 압축</dd>
          </div>
        )}
      </dl>
      {state.preparing && (
        <div role="status">
          <progress
            aria-label="오프라인 다운로드"
            max={state.offline?.total ?? 1}
            value={state.offline?.completed ?? 0}
          />
          <p>
            오프라인 준비 중 · {state.offline?.completed ?? 0}/{state.offline?.total ?? '…'}
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
            {state.preparing ? '준비 중…' : '모든 형식 오프라인 준비'}
          </button>
        )}
        <button
          className="ghost-btn"
          disabled={!state.online || state.preparing || state.phase === 'unsupported'}
          onClick={() => void checkWebUpdate()}
        >
          업데이트·상태 확인
        </button>
        {state.waiting && (
          <button className="primary-btn" disabled={state.busy || state.preparing} onClick={applyWebUpdate}>
            새 버전 적용
          </button>
        )}
        {state.installPrompt && (
          <button className="ghost-btn" onClick={() => void installWebApp()}>
            앱 설치
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
      {!state.installed && !state.installPrompt && (
        <p className="field-help">브라우저 메뉴의 ‘앱 설치’ 또는 ‘홈 화면에 추가’로 앱처럼 열 수 있습니다.</p>
      )}
      <p className="field-help">
        앱 파일 준비는 책장 백업과 다릅니다. 클라우드 연결·OCR 언어팩·일부 시스템 음성은 인터넷이 필요합니다. 새 버전
        적용 후 준비 상태를 다시 확인하세요.
      </p>
      {state.offline && <p className="field-help">현재 앱 버전 {state.offline.version.slice(0, 10)}</p>}
    </section>
  );
}
