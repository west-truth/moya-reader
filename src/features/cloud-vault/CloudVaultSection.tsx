import { Cloud, FolderOpen, LockKeyhole, RefreshCw, Unlink } from 'lucide-react';
import { CLOUD_VAULT_MIN_PASSPHRASE_LENGTH } from '../../cloud-vault/crypto';
import { formatBytes, formatDateTime } from '../../utils/format';
import type { CloudVaultController } from './useCloudVaultController';

const scopeRows = [
  { key: 'library', label: '서재와 작품 정보', description: '제목, 즐겨찾기, 컬렉션' },
  { key: 'annotations', label: '메모와 표시', description: '북마크, 하이라이트, 메모' },
  { key: 'statistics', label: '독서 통계', description: '독서 시간과 세션 기록' },
  { key: 'aiTtsArtifacts', label: 'AI · TTS 작업 결과', description: '등장인물, 화자 보정, 음성 배정' },
  { key: 'readerSettings', label: '읽기 화면 설정', description: '기기마다 다를 수 있어 기본 제외' },
  {
    key: 'sourceFiles',
    label: '작품 파일과 표지',
    description: '원본 · 표지 · 암호화 제외',
  },
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
  const config = controller.config;
  const scope = config?.scope;
  const activity = activityLabel(controller.activity);
  const waitingTitles = config?.waitingBookTitles ?? [];
  const enabledScopeCount = scopeRows.filter((row) => scope?.[row.key]).length;
  const currentProviderSyncAt =
    config?.lastSyncProviderKind === controller.providerKind ? config?.lastSyncAt : undefined;

  return (
    <section className="cloud-vault-section" aria-busy={busy}>
      <div className="cloud-vault-heading">
        <div>
          <span className="cloud-vault-heading-icon" aria-hidden="true">
            <Cloud size={17} />
          </span>
          <div>
            <h3>기기 간 동기화</h3>
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
          {controller.unlocked ? (
            <div className="cloud-vault-unlocked">
              <LockKeyhole size={15} aria-hidden="true" />
              <span>이 기기에서 잠금 해제됨</span>
            </div>
          ) : (
            <label className="cloud-vault-passphrase">
              <span>
                <LockKeyhole size={15} aria-hidden="true" /> 동기화 암호
              </span>
              <input
                type="password"
                value={controller.passphrase}
                onChange={(event) => controller.setPassphrase(event.target.value)}
                placeholder={`${CLOUD_VAULT_MIN_PASSPHRASE_LENGTH}자 이상`}
                autoComplete="current-password"
                disabled={busy}
              />
            </label>
          )}

          {controller.connected ? (
            <div className="cloud-vault-provider-card">
              <div>
                <span>{controller.providerKind === 'dropbox' ? 'Dropbox' : '로컬 폴더'}</span>
                <strong>{controller.providerLabel}</strong>
              </div>
              <button className="ghost-btn" type="button" onClick={() => void controller.disconnect()} disabled={busy}>
                <Unlink size={15} /> 연결 해제
              </button>
            </div>
          ) : (
            <div className="cloud-vault-provider-options">
              <button
                className="primary-btn cloud-vault-dropbox-connect"
                type="button"
                onClick={() => void controller.connectDropbox()}
                disabled={busy || !controller.dropboxAvailable}
              >
                <Cloud size={17} /> Dropbox 연결
              </button>
              {controller.directoryAvailable && (
                <details className="cloud-vault-provider-more">
                  <summary>다른 저장 위치</summary>
                  <button
                    className="ghost-btn"
                    type="button"
                    onClick={() => void controller.selectDirectory()}
                    disabled={busy}
                  >
                    <FolderOpen size={17} /> 로컬 폴더
                  </button>
                </details>
              )}
            </div>
          )}

          <div className="cloud-vault-preferences">
            <label>
              <input
                type="checkbox"
                checked={config?.rememberPassphrase ?? true}
                onChange={(event) => void controller.setRememberPassphrase(event.target.checked)}
                disabled={busy || !config}
              />
              <span>이 기기에서 기억</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={config?.autoSync ?? true}
                onChange={(event) => void controller.setAutoSync(event.target.checked)}
                disabled={busy || !config || !controller.connected}
              />
              <span>자동 동기화</span>
            </label>
          </div>

          <details className="cloud-vault-scope-details">
            <summary>
              <span>동기화 항목</span>
              <small>{enabledScopeCount}개 선택</small>
            </summary>
            <fieldset className="cloud-vault-scope" disabled={busy || !controller.config}>
              <legend className="sr-only">동기화 항목</legend>
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
          </details>

          {controller.backupOnly && (
            <p className="cloud-vault-notice">
              서버 동기화가 연결되어 있어 Cloud Vault는 충돌 없는 암호화 백업으로만 사용됩니다.
            </p>
          )}

          {waitingTitles.length > 0 && (
            <div className="cloud-vault-waiting">
              <strong>원문 연결 대기 {waitingTitles.length}개</strong>
              <span>{waitingTitles.slice(0, 3).join(', ')}</span>
              <small>
                {scope?.sourceFiles
                  ? '클라우드 원본이 없는 작품입니다. 이 기기에 같은 파일을 가져온 뒤 다시 동기화하세요.'
                  : '이 기기에 같은 원문 파일을 가져온 뒤 다시 동기화하세요.'}
              </small>
            </div>
          )}

          {controller.lastReport &&
            (controller.lastReport.uploadedSourceFiles > 0 || controller.lastReport.restoredSourceFiles > 0) && (
              <p className="cloud-vault-notice">
                원본 업로드 {controller.lastReport.uploadedSourceFiles}개 · 이 기기에 복원{' '}
                {controller.lastReport.restoredSourceFiles}개
              </p>
            )}

          {controller.lastReport?.contentFailures.length ? (
            <div className="cloud-vault-waiting">
              <strong>작품 파일 처리 실패 {controller.lastReport.contentFailures.length}개</strong>
              <span>{controller.lastReport.contentFailures.slice(0, 2).join(' · ')}</span>
              <small>독서 기록 동기화는 유지됐습니다. 연결과 저장 공간을 확인한 뒤 다시 시도하세요.</small>
            </div>
          ) : null}

          {controller.config?.lastError && <p className="cloud-vault-error">{controller.config.lastError}</p>}

          <div className="cloud-vault-sync-row">
            <button
              className="primary-btn"
              type="button"
              onClick={() => void controller.syncNow()}
              disabled={
                busy ||
                !controller.connected ||
                (!controller.unlocked && controller.passphrase.length < CLOUD_VAULT_MIN_PASSPHRASE_LENGTH)
              }
              aria-label={controller.backupOnly ? '기기 간 백업 갱신' : '기기 간 지금 동기화'}
            >
              <RefreshCw size={17} /> {controller.backupOnly ? '백업 갱신' : '지금 동기화'}
            </button>
            <div>
              {activity ? (
                <span>{activity}</span>
              ) : currentProviderSyncAt ? (
                <>
                  <span>마지막 동기화 {formatDateTime(currentProviderSyncAt)}</span>
                  {config?.lastUploadedBytes !== undefined && (
                    <small>
                      암호화 기록 {formatBytes(config.lastUploadedBytes)}
                      {controller.lastReport?.uploadedContentBytes
                        ? ` · 작품 ${formatBytes(controller.lastReport.uploadedContentBytes)}`
                        : ''}
                    </small>
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
