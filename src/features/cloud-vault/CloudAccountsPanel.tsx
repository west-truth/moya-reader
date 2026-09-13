import { Cloud, FolderOpen } from 'lucide-react';
import { WebGoogleAccountPanel } from '../../cloud-vault/google/WebGoogleAccountPanel';
import { desktopGoogleSession } from '../../platform/desktop-google-session';
import { detectPlatformRuntime } from '../../platform/runtime';
import type { CloudVaultController } from './useCloudVaultController';
import { CloudVaultSection } from './CloudVaultSection';
import './cloud-accounts.css';

export function CloudAccountsPanel({ controller }: { readonly controller: CloudVaultController }) {
  const native = detectPlatformRuntime();
  const busy = controller.activity !== 'idle';
  const dropbox = controller.providerKind === 'dropbox';
  const other = controller.connected && !dropbox;
  if (!controller.available) return <CloudVaultSection controller={controller} showConnectionOptions={false} />;
  return (
    <>
      {native.kind !== 'tauri-mobile' && (
        <WebGoogleAccountPanel
          controller={controller}
          session={native.kind === 'tauri-desktop' ? desktopGoogleSession : undefined}
        />
      )}
      <section className="cloud-account-card" aria-label="Dropbox 계정과 동기화" aria-busy={busy}>
        <div className="cloud-account-heading">
          <h3>
            <Cloud size={18} aria-hidden="true" /> Dropbox
          </h3>
          <span>{dropbox ? '연결됨' : '연결 안 됨'}</span>
        </div>
        {dropbox ? (
          <>
            <strong className="cloud-account-label">{controller.providerLabel}</strong>
            <p>Dropbox에 연결됐어요. 아래에서 동기화할 항목과 자동 동기화를 설정할 수 있어요.</p>
          </>
        ) : other ? (
          <p>
            현재 {controller.providerLabel}에 동기화하고 있어요. Dropbox로 바꾸려면 아래에서 기존 연결을 해제하세요.
          </p>
        ) : (
          <>
            <p>Dropbox로 로그인하고 내 저장 공간에 책장과 독서 기록을 동기화하세요.</p>
            <label className="web-google-files">
              <input
                type="checkbox"
                checked={controller.config?.scope.sourceFiles ?? false}
                disabled={busy || !controller.config}
                onChange={(event) => void controller.setScope('sourceFiles', event.target.checked)}
              />
              <span>
                책 파일과 표지도 동기화<small>내 Dropbox 공간을 사용합니다.</small>
              </span>
            </label>
            {controller.dropboxAvailable ? (
              <button
                type="button"
                className="primary-btn"
                disabled={busy}
                onClick={() => void controller.connectDropbox()}
              >
                {controller.activity === 'connecting' ? '연결 중…' : 'Dropbox로 연결'}
              </button>
            ) : (
              <p className="field-help">
                {controller.dropboxSetupHint ?? '이 버전에는 Dropbox 연결이 구성되지 않았습니다.'}
              </p>
            )}
          </>
        )}
        <details>
          <summary>연결 안내</summary>
          <p>
            Dropbox에서 권한을 허용하면 선택한 동기화 항목을 내 Dropbox에 저장합니다. 별도 모야 비밀번호는 필요하지
            않습니다.
          </p>
        </details>
      </section>
      {!controller.connected && controller.directoryAvailable && (
        <details className="cloud-account-card">
          <summary>로컬 폴더에 동기화</summary>
          <button className="ghost-btn" type="button" disabled={busy} onClick={() => void controller.selectDirectory()}>
            <FolderOpen size={17} /> 폴더 선택
          </button>
        </details>
      )}
      <CloudVaultSection controller={controller} showConnectionOptions={false} />
    </>
  );
}
