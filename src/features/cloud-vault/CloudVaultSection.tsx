import { Cloud, FolderOpen, LockKeyhole, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import { formatBytes, formatDateTime } from '../../utils/format';
import type { CloudVaultController } from './useCloudVaultController';

const scopeRows = [
  { key: 'library', label: '서재와 작품 정보', description: '제목, 즐겨찾기, 컬렉션' },
  { key: 'annotations', label: '메모와 표시', description: '북마크, 하이라이트, 메모' },
  { key: 'statistics', label: '독서 통계', description: '독서 시간과 세션 기록' },
  { key: 'aiTtsArtifacts', label: 'AI · TTS 작업 결과', description: '등장인물, 화자 보정, 음성 배정' },
  { key: 'readerSettings', label: '읽기 화면 설정', description: '기기마다 다를 수 있어 기본 제외' },
] as const;

function activityLabel(activity: CloudVaultController['activity']): string | undefined {
  if (activity === 'loading') return '연결 정보를 확인하는 중…';
  if (activity === 'connecting') return '저장 위치를 연결하는 중…';
  if (activity === 'syncing') return '암호화하고 동기화하는 중…';
  if (activity === 'disconnecting') return '연결을 해제하는 중…';
  return undefined;
}

export function CloudVaultSection({ controller }: { readonly controller: CloudVaultController }) {
  const busy = controller.activity !== 'idle';
  const scope = controller.config?.scope;
  const activity = activityLabel(controller.activity);
  const waitingTitles = controller.config?.waitingBookTitles ?? [];

  return (
    <section className="cloud-vault-section" aria-busy={busy}>
      <div className="cloud-vault-heading">
        <div>
          <span className="cloud-vault-heading-icon" aria-hidden="true">
            <Cloud size={17} />
          </span>
          <div>
            <h3>Cloud Vault</h3>
            <p>서버 없이 독서 기록을 암호화해 보관합니다.</p>
          </div>
        </div>
        <span className={controller.connected ? 'cloud-vault-state connected' : 'cloud-vault-state'}>
          {controller.connected ? '연결됨' : '연결 안 됨'}
        </span>
      </div>

      {!controller.available ? (
        <p className="cloud-vault-notice">{controller.unavailableReason}</p>
      ) : (
        <>
          <div className="cloud-vault-privacy-note">
            <ShieldCheck size={17} aria-hidden="true" />
            <p>
              <strong>소설 원문은 업로드하지 않습니다.</strong>
              <span>진행도, 메모, 통계와 선택한 AI · TTS 결과만 종단간 암호화합니다.</span>
            </p>
          </div>

          <label className="cloud-vault-passphrase">
            <span>
              <LockKeyhole size={15} aria-hidden="true" /> Vault 암호
            </span>
            <input
              type="password"
              value={controller.passphrase}
              onChange={(event) => controller.setPassphrase(event.target.value)}
              placeholder="12자 이상"
              autoComplete="current-password"
              disabled={busy}
            />
            <small>암호는 이 세션에서만 유지되며, 분실하면 Vault를 복구할 수 없습니다.</small>
          </label>

          {controller.connected ? (
            <div className="cloud-vault-provider-card">
              <div>
                <span>{controller.providerKind === 'dropbox' ? 'Dropbox App Folder' : '동기화 폴더'}</span>
                <strong>{controller.providerLabel}</strong>
              </div>
              <button className="ghost-btn" type="button" onClick={() => void controller.disconnect()} disabled={busy}>
                <Unlink size={15} /> 연결 해제
              </button>
            </div>
          ) : (
            <div className="cloud-vault-provider-options">
              <button
                className="ghost-btn"
                type="button"
                onClick={() => void controller.selectDirectory()}
                disabled={busy || !controller.directoryAvailable}
              >
                <FolderOpen size={17} /> 동기화 폴더 선택
              </button>
              <button
                className="ghost-btn"
                type="button"
                onClick={() => void controller.connectDropbox()}
                disabled={busy || !controller.dropboxAvailable}
              >
                <Cloud size={17} /> Dropbox 연결
              </button>
              {!controller.directoryAvailable && <small>현재 브라우저에서는 폴더 연결을 지원하지 않습니다.</small>}
              {controller.dropboxSetupHint && <small>{controller.dropboxSetupHint}</small>}
            </div>
          )}

          <fieldset className="cloud-vault-scope" disabled={busy || !controller.config}>
            <legend>동기화 항목</legend>
            {scopeRows.map((row) => (
              <label key={row.key}>
                <input
                  type="checkbox"
                  checked={scope?.[row.key] ?? false}
                  onChange={(event) => void controller.setScope(row.key, event.target.checked)}
                />
                <span>
                  <strong>{row.label}</strong>
                  <small>{row.description}</small>
                </span>
              </label>
            ))}
            <div className="cloud-vault-scope-disabled" aria-disabled="true">
              <span aria-hidden="true" />
              <p>
                <strong>TTS 오디오</strong>
                <small>파일 용량과 수명 주기 정책이 필요한 후속 기능</small>
              </p>
              <em>제외</em>
            </div>
          </fieldset>

          {controller.backupOnly && (
            <p className="cloud-vault-notice">
              서버 동기화가 연결되어 있어 Cloud Vault는 충돌 없는 암호화 백업으로만 사용됩니다.
            </p>
          )}

          {waitingTitles.length > 0 && (
            <div className="cloud-vault-waiting">
              <strong>원문 연결 대기 {waitingTitles.length}개</strong>
              <span>{waitingTitles.slice(0, 3).join(', ')}</span>
              <small>이 기기에 같은 원문 파일을 가져온 뒤 다시 동기화하세요.</small>
            </div>
          )}

          {controller.config?.lastError && <p className="cloud-vault-error">{controller.config.lastError}</p>}

          <div className="cloud-vault-sync-row">
            <button
              className="primary-btn"
              type="button"
              onClick={() => void controller.syncNow()}
              disabled={busy || !controller.connected || controller.passphrase.length < 12}
              aria-label={controller.backupOnly ? 'Cloud Vault 백업 갱신' : 'Cloud Vault 지금 동기화'}
            >
              <RefreshCw size={17} /> {controller.backupOnly ? '백업 갱신' : 'Vault 동기화'}
            </button>
            <div>
              {activity ? (
                <span>{activity}</span>
              ) : controller.config?.lastSyncAt ? (
                <>
                  <span>마지막 동기화 {formatDateTime(controller.config.lastSyncAt)}</span>
                  {controller.config.lastUploadedBytes !== undefined && (
                    <small>암호화 파일 {formatBytes(controller.config.lastUploadedBytes)}</small>
                  )}
                </>
              ) : (
                <span>아직 동기화하지 않았습니다.</span>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
