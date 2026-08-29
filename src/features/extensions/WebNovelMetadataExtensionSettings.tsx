import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS,
  type WebNovelMetadataCollectorAuthPlatform,
} from '../../services/webnovel-metadata-collector-client';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';
import type { BookEnrichmentAutomationController } from '../book-enrichment/useBookEnrichmentAutomation';
import { RemoteCollectorAuthBrowser } from './RemoteCollectorAuthBrowser';

const platformLabels: Record<WebNovelMetadataCollectorAuthPlatform, string> = {
  naver_series: '네이버 시리즈',
  kakao_page: '카카오페이지',
  novelpia: '노벨피아',
  ridi: '리디',
};

function connectionLabel(state: ReturnType<WebNovelMetadataCollectorBroker['getSnapshot']>['connectionState']) {
  if (state === 'connected') return '연결됨';
  if (state === 'checking') return '확인 중';
  if (state === 'unavailable') return '연결할 수 없음';
  return '연결 안 됨';
}

function isRemoteEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export interface WebNovelMetadataExtensionSettingsProps {
  readonly broker: WebNovelMetadataCollectorBroker;
  readonly automation: BookEnrichmentAutomationController;
  readonly extensionEnabled: boolean;
  readonly libraryCount: number;
  confirm(message: string): boolean;
}

export function WebNovelMetadataExtensionSettings({
  broker,
  automation,
  extensionEnabled,
  libraryCount,
  confirm,
}: WebNovelMetadataExtensionSettingsProps) {
  const snapshot = useSyncExternalStore(broker.subscribe, broker.getSnapshot, broker.getSnapshot);
  const [endpoint, setEndpoint] = useState(snapshot.settings.endpoint);
  const [operation, setOperation] = useState<string>();
  const [error, setError] = useState<string>();
  const [remotePlatform, setRemotePlatform] = useState<WebNovelMetadataCollectorAuthPlatform>();
  const [remoteBrowserVisible, setRemoteBrowserVisible] = useState(false);
  const connected = snapshot.connectionState === 'connected';
  const managed = broker.connectionMode === 'managed';
  const remoteAuthBrowser = snapshot.health?.capabilities.adultAuth.browserPresentation === 'remote_frame';

  useEffect(() => setEndpoint(snapshot.settings.endpoint), [snapshot.settings.endpoint]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (operation) return false;
    setOperation(name);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '요청을 완료하지 못했습니다.');
      return false;
    } finally {
      setOperation(undefined);
    }
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    void run('connect', async () => {
      broker.updateSettings({ endpoint });
      await broker.connect();
    });
  };

  const openLogin = async (platform: WebNovelMetadataCollectorAuthPlatform) => {
    const opened = await run(`open-${platform}`, () => broker.openAuthBrowser(platform));
    if (opened && remoteAuthBrowser) {
      setRemotePlatform(platform);
      setRemoteBrowserVisible(true);
    }
  };
  const finishLogin = (platform: WebNovelMetadataCollectorAuthPlatform) =>
    run(`enable-${platform}`, () => broker.setAuthPlatformEnabled(platform, true));
  const disableLogin = (platform: WebNovelMetadataCollectorAuthPlatform) =>
    run(`disable-${platform}`, () => broker.setAuthPlatformEnabled(platform, false));

  const progress = automation.progress;
  const result = automation.result;

  return (
    <div className={`webnovel-metadata-extension-settings${extensionEnabled ? '' : ' is-disabled'}`}>
      {!extensionEnabled && (
        <p className="field-help">위의 익스텐션 토글을 켜면 연결과 자동화 설정을 사용할 수 있습니다.</p>
      )}

      <section className="extension-detail-section" aria-labelledby="webnovel-collector-connection">
        <div className="extension-detail-section-heading">
          <div>
            <strong id="webnovel-collector-connection">{managed ? '내장 정보 수집기' : '웹소설 정보 수집기'}</strong>
          </div>
          <span className={`extension-connection-state is-${snapshot.connectionState}`}>
            {connected ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
            {connectionLabel(snapshot.connectionState)}
          </span>
        </div>
        {managed ? (
          <div className="extension-inline-actions">
            <button
              className="ghost-btn"
              type="button"
              disabled={!extensionEnabled || Boolean(operation)}
              onClick={() => void run('connect', () => broker.connect())}
            >
              {operation === 'connect' || snapshot.connectionState === 'checking' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              다시 연결
            </button>
          </div>
        ) : (
          <form className="extension-endpoint-form" onSubmit={connect}>
            <label>
              <span>도우미 주소</span>
              <input
                type="url"
                value={endpoint}
                disabled={!extensionEnabled || Boolean(operation)}
                placeholder="http://127.0.0.1:8000"
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </label>
            <div className="extension-inline-actions">
              <button className="primary-btn" type="submit" disabled={!extensionEnabled || Boolean(operation)}>
                {operation === 'connect' || snapshot.connectionState === 'checking' ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                연결 확인
              </button>
              <button
                className="ghost-btn"
                type="button"
                disabled={!extensionEnabled || Boolean(operation)}
                onClick={() => {
                  const settings = broker.resetSettings();
                  setEndpoint(settings.endpoint);
                }}
              >
                <RotateCcw size={15} /> 기본 주소
              </button>
            </div>
          </form>
        )}
        {!managed && isRemoteEndpoint(endpoint) && (
          <p className="field-help warning">
            원격 도우미 주소에는 검색할 작품 제목과 작가명이 전송됩니다. 직접 운영하거나 신뢰하는 주소만 사용하세요.
          </p>
        )}
        {snapshot.health && (
          <p className="field-help">
            수집기 v{snapshot.health.version} · 표지 최대{' '}
            {Math.round(snapshot.health.capabilities.coverRef.maxBytes / 1024 / 1024)}MB
          </p>
        )}
        {(snapshot.connectionIssue?.message || error) && (
          <p className="field-help warning" role="alert">
            {error ?? snapshot.connectionIssue?.message}
          </p>
        )}
      </section>

      <section className="extension-detail-section" aria-labelledby="webnovel-automation-heading">
        <div className="extension-detail-section-heading">
          <div>
            <strong id="webnovel-automation-heading">자동 적용과 전체 책장</strong>
            <span>정확한 결과만 사용하며 직접 입력한 정보와 기존 표지는 보존합니다.</span>
          </div>
        </div>
        <div className="extension-option-list">
          <label className="reader-settings-toggle extension-wide-toggle">
            <input
              type="checkbox"
              checked={snapshot.settings.automaticLookup}
              disabled={!extensionEnabled}
              onChange={(event) => broker.updateSettings({ automaticLookup: event.target.checked })}
            />
            <span>
              <strong>새로 가져온 작품 자동 검색</strong>
              <small>새 작품이 책장에 추가되면 표지와 작품 정보 후보를 찾습니다.</small>
            </span>
          </label>
          <label className="reader-settings-toggle extension-wide-toggle">
            <input
              type="checkbox"
              checked={snapshot.settings.automaticApply === 'missing_fields'}
              disabled={!extensionEnabled}
              onChange={(event) =>
                broker.updateSettings({ automaticApply: event.target.checked ? 'missing_fields' : 'off' })
              }
            />
            <span>
              <strong>새 작품에도 자동 적용</strong>
              <small>자동 검색한 새 작품도 정확히 일치하면 빈 정보와 없는 표지를 바로 채웁니다.</small>
            </span>
          </label>
        </div>
        <p className="field-help">
          자동 표지는 원본 플랫폼이 제공한 이미지를 개인 서재에 표시합니다. 재배포·상업적 이용 권리는 확인되지 않으므로
          외부로 내보내기 전 사용 조건을 확인하세요.
        </p>
        <div className="extension-batch-panel">
          <div>
            <strong>전체 라이브러리 자동 채우기</strong>
            <span>정보나 표지가 부족한 작품만 검색해 정확한 결과를 빈 항목에 바로 적용합니다.</span>
          </div>
          {automation.busy ? (
            <button className="ghost-btn danger" type="button" onClick={automation.cancel}>
              <Square size={14} /> 중단
            </button>
          ) : (
            <button
              className="primary-btn"
              type="button"
              disabled={!extensionEnabled || !connected || libraryCount === 0}
              onClick={() => void automation.runLibraryBatch()}
            >
              부족한 정보 자동 채우기
            </button>
          )}
        </div>
        {progress.state === 'running' && (
          <div className="extension-batch-progress" role="status" aria-live="polite">
            <progress max={Math.max(progress.total, 1)} value={progress.completed} />
            <span>
              {progress.completed}/{progress.total} · {progress.currentTitle ?? '검색 준비 중'}
            </span>
          </div>
        )}
        {result && result.state !== 'running' && (
          <p className={`field-help${result.failed > 0 ? ' warning' : ''}`} role="status">
            {result.state === 'cancelled' ? '중단됨 · ' : ''}
            {result.completed}/{result.total}권 확인 · 기존 정보 충분 {result.skipped}권 건너뜀 · 자동 적용{' '}
            {result.applied}권
            {result.failed > 0 ? ` · 실패 ${result.failed}권 (${result.errors[0]?.message ?? '알 수 없는 오류'})` : ''}
          </p>
        )}
      </section>

      <section className="extension-detail-section" aria-labelledby="webnovel-adult-heading">
        <div className="extension-detail-section-heading">
          <div>
            <strong id="webnovel-adult-heading">19세 작품 검색</strong>
            <span>
              {remoteAuthBrowser
                ? '서버의 전용 브라우저에서 로그인하며 계정 정보는 Moya 설정에 저장하지 않습니다.'
                : '전용 브라우저에서 직접 로그인·성인 인증하고, Moya에는 계정이나 쿠키를 전달하지 않습니다.'}
            </span>
          </div>
        </div>
        <label className="reader-settings-toggle extension-wide-toggle">
          <input
            type="checkbox"
            checked={snapshot.settings.includeAdult}
            disabled={!extensionEnabled || !connected || snapshot.health?.capabilities.adultAuth.available !== true}
            onChange={(event) => broker.updateSettings({ includeAdult: event.target.checked })}
          />
          <span>
            <strong>19세 검색 결과 포함</strong>
            <small>로그인 사용을 설정한 플랫폼만 인증 세션을 사용합니다.</small>
          </span>
        </label>
        {!connected ? (
          <p className="field-help">먼저 위에서 로컬 도우미 연결을 확인해 주세요.</p>
        ) : snapshot.health?.capabilities.adultAuth.available !== true ? (
          <p className="field-help warning">현재 도우미 환경에서는 전용 로그인 브라우저를 사용할 수 없습니다.</p>
        ) : (
          <div className="extension-auth-platforms">
            {WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS.map((platform) => {
              const enabled = snapshot.auth?.enabledPlatforms.includes(platform) === true;
              return (
                <div key={platform} className="extension-auth-platform-row">
                  <div>
                    <strong>{platformLabels[platform]}</strong>
                    <span>{enabled ? '19세 검색 사용 설정됨' : '로그인 사용 안 함'}</span>
                  </div>
                  <div className="extension-inline-actions">
                    <button
                      className="ghost-btn"
                      type="button"
                      disabled={Boolean(operation)}
                      onClick={() => void openLogin(platform)}
                    >
                      <ExternalLink size={14} /> {enabled ? '다시 로그인' : '로그인'}
                    </button>
                    {enabled ? (
                      <button
                        className="ghost-btn"
                        type="button"
                        disabled={Boolean(operation)}
                        onClick={() => void disableLogin(platform)}
                      >
                        사용 중지
                      </button>
                    ) : !remoteAuthBrowser ? (
                      <button
                        className="primary-btn"
                        type="button"
                        disabled={Boolean(operation)}
                        onClick={() => void finishLogin(platform)}
                      >
                        로그인 완료·사용
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {snapshot.auth?.browserRunning && (
          <div className="extension-auth-browser-note">
            <span>전용 로그인 브라우저가 열려 있습니다.</span>
            <div className="extension-inline-actions">
              {remoteAuthBrowser && remotePlatform && (
                <button className="ghost-btn" type="button" onClick={() => setRemoteBrowserVisible(true)}>
                  로그인 화면
                </button>
              )}
              <button
                className="ghost-btn"
                type="button"
                onClick={() => void run('close-auth', () => broker.closeAuthBrowser())}
              >
                브라우저 닫기
              </button>
            </div>
          </div>
        )}
        {snapshot.authIssue?.message && (
          <p className="field-help warning" role="alert">
            {snapshot.authIssue.message}
          </p>
        )}
        {connected && snapshot.health?.capabilities.adultAuth.available === true && (
          <div className="extension-inline-actions extension-auth-footer">
            <button
              className="ghost-btn"
              type="button"
              disabled={Boolean(operation)}
              onClick={() => void run('refresh-auth', () => broker.refreshAuthStatus())}
            >
              <RefreshCw size={14} /> 상태 새로고침
            </button>
            <button
              className="ghost-btn danger"
              type="button"
              disabled={Boolean(operation)}
              onClick={() => {
                if (!confirm('전용 브라우저의 로그인 세션을 모두 지울까요? 다시 로그인해야 합니다.')) return;
                void run('clear-auth', () => broker.clearAuthSession());
              }}
            >
              <Trash2 size={14} /> 로그인 세션 삭제
            </button>
          </div>
        )}
      </section>
      {remotePlatform && remoteBrowserVisible && snapshot.auth?.browserRunning && (
        <RemoteCollectorAuthBrowser
          broker={broker}
          platformLabel={platformLabels[remotePlatform]}
          busy={Boolean(operation)}
          onDismiss={() => setRemoteBrowserVisible(false)}
          onCancel={() => {
            void run('close-auth', () => broker.closeAuthBrowser()).then((closed) => {
              if (closed) setRemotePlatform(undefined);
              if (closed) setRemoteBrowserVisible(false);
            });
          }}
          onComplete={() => {
            void run(`enable-${remotePlatform}`, () => broker.setAuthPlatformEnabled(remotePlatform, true)).then(
              (enabled) => {
                if (enabled) setRemotePlatform(undefined);
                if (enabled) setRemoteBrowserVisible(false);
              },
            );
          }}
        />
      )}
    </div>
  );
}
