import { BookOpen, Check, RefreshCw, SlidersHorizontal, Square, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDismissibleLayer } from '../../shared/ui/use-dismissible-layer';
import { aiTtsFieldDiffKey, aiTtsRemoteSnapshotApplyAvailable } from '../../sync/ai-tts-sync-apply';
import { buildAiTtsSyncSnapshotPreview, type AiTtsSyncRemoteSnapshot } from '../../sync/ai-tts-sync-diff';
import { aiTtsRemoteSnapshotAvailable } from '../../sync/ai-tts-remote-snapshot';
import {
  aiTtsSyncConflictDescription,
  canRunSyncAction,
  summarizeAiTtsSyncConflicts,
  summarizeAiTtsSyncConflictGroups,
  summarizeSyncOutbox,
  syncActionLabel,
  syncConflictResolutionDescription,
  syncOutboxRevisionLabel,
  syncOutboxTargetLabel,
  syncStatusDescription,
  syncStatusLabel,
  syncStatusTitle,
  syncStatusTone,
} from '../../sync/sync-ui';
import { formatCount, formatDateTime, formatProgress } from '../../utils/format';
import { outboxStatusLabel, runSyncMergeAction, syncEventTypeLabel, syncLastSyncedLabel } from './sync-panel-model';
import type { SyncPanelProps } from './sync-panel-contract';
import { CloudVaultSection } from '../cloud-vault/CloudVaultSection';

type RemoteSnapshotState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: AiTtsSyncRemoteSnapshot }
  | { readonly status: 'failed'; readonly error: string };

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export default function SyncPanel({ data, actions }: SyncPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [remoteSnapshots, setRemoteSnapshots] = useState<Record<string, RemoteSnapshotState>>({});
  useDismissibleLayer({
    open: true,
    modal: true,
    containerRef: panelRef,
    initialFocusRef: closeRef,
    onClose: actions.close,
  });
  const outboxSummary = useMemo(() => summarizeSyncOutbox([...data.syncOutbox]), [data.syncOutbox]);
  const aiTtsSummary = useMemo(() => summarizeAiTtsSyncConflicts([...data.syncOutbox]), [data.syncOutbox]);
  const groups = useMemo(() => summarizeAiTtsSyncConflictGroups([...data.syncOutbox]), [data.syncOutbox]);
  const groupsWithSnapshots = groups.map((group) => {
    const snapshotState = remoteSnapshots[group.key];
    if (snapshotState?.status !== 'ready') return group;
    return {
      ...group,
      snapshotPreview: buildAiTtsSyncSnapshotPreview({
        eventType: group.eventType,
        entityId: group.entityId,
        novelId: group.novelId,
        items: group.items,
        remoteSnapshot: snapshotState.snapshot,
      }),
    };
  });
  const visibleGroups = groupsWithSnapshots.slice(0, 3);
  const remoteSnapshotGroups = useMemo(() => groups.slice(0, 3).filter(aiTtsRemoteSnapshotAvailable), [groups]);
  const loadRemoteSnapshot = actions.loadRemoteSnapshot;

  useEffect(() => {
    if (!loadRemoteSnapshot || remoteSnapshotGroups.length === 0) {
      setRemoteSnapshots({});
      return;
    }
    let cancelled = false;
    setRemoteSnapshots(
      Object.fromEntries(remoteSnapshotGroups.map((group) => [group.key, { status: 'loading' as const }])),
    );
    for (const group of remoteSnapshotGroups) {
      void loadRemoteSnapshot(group)
        .then((snapshot) => {
          if (!cancelled) setRemoteSnapshots((current) => ({ ...current, [group.key]: { status: 'ready', snapshot } }));
        })
        .catch((error) => {
          if (!cancelled) {
            setRemoteSnapshots((current) => ({
              ...current,
              [group.key]: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
            }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [loadRemoteSnapshot, remoteSnapshotGroups]);

  const syncConfigured = data.mode === 'remote' || data.syncServiceConnected;
  const syncCanRetry = canRunSyncAction({
    backendMode: data.mode,
    hasSyncService: data.syncServiceConnected,
    syncFlushing: data.syncFlushing || data.serverAttachBusy,
    state: data.syncState,
  });
  const activeOutbox = data.syncOutbox.filter((item) => item.status !== 'sent').slice(0, 8);
  const visibleItems = aiTtsSummary.items.slice(0, 4);
  const conflictDescription = syncConflictResolutionDescription(data.syncState, outboxSummary);
  const aiTtsDescription = aiTtsSyncConflictDescription(aiTtsSummary);

  return (
    <div className="settings-layer">
      <button className="panel-scrim" onClick={actions.close} aria-label="동기화 패널 배경 닫기" />
      <aside
        ref={panelRef}
        className="settings-panel sync-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>동기화 상태</h2>
          <button ref={closeRef} className="icon-btn" onClick={actions.close} aria-label="동기화 패널 닫기">
            <X size={18} />
          </button>
        </header>
        <CloudVaultSection controller={data.cloudVault} />
        <section>
          <div className={classNames('sync-detail-card', syncStatusTone(data.syncState))}>
            <strong>{syncStatusTitle(data.syncState)}</strong>
            <span>{syncStatusDescription(data.syncState, syncConfigured, data.mode)}</span>
          </div>
          <dl className="sync-detail-grid">
            <div>
              <dt>현재 상태</dt>
              <dd>{syncStatusLabel(data.syncState)}</dd>
            </div>
            <div>
              <dt>마지막 동기화</dt>
              <dd>{syncLastSyncedLabel(data.syncState, formatDateTime)}</dd>
            </div>
            <div>
              <dt>{syncConfigured ? '대기 항목' : '로컬 변경 기록'}</dt>
              <dd>{formatCount(data.syncState?.pendingCount ?? 0)}개</dd>
            </div>
            <div>
              <dt>서버 모드</dt>
              <dd>{data.mode === 'remote' ? '호스팅 서버' : data.syncServiceConnected ? '로컬+서버' : '로컬 전용'}</dd>
            </div>
          </dl>
          {data.syncState?.lastError && <p className="sync-error">{data.syncState.lastError}</p>}
          {conflictDescription && (
            <div className="sync-conflict-card">
              <strong>충돌 대기열</strong>
              <span>{conflictDescription}</span>
              {outboxSummary.latestError && <small>최근 사유: {outboxSummary.latestError}</small>}
            </div>
          )}
          {aiTtsDescription && (
            <div className="sync-ai-conflict-card">
              <div className="sync-ai-conflict-heading">
                <strong>AI/TTS 변경 대기</strong>
                <span>{formatCount(aiTtsSummary.unsentCount)}개</span>
              </div>
              <p>{aiTtsDescription}</p>
              {aiTtsSummary.latestError && <small>최근 사유: {aiTtsSummary.latestError}</small>}
              <div className="sync-ai-merge-list">
                {visibleGroups.map((group) => {
                  const snapshotState = remoteSnapshots[group.key];
                  const selectedKeys = group.snapshotPreview.fieldDiffs
                    .map(aiTtsFieldDiffKey)
                    .filter((key) => data.mergeSelections[group.key]?.[key]);
                  return (
                    <div key={group.key} className="sync-ai-merge-row">
                      <div>
                        <strong>{group.title}</strong>
                        <span>
                          {group.policyLabel} · {formatCount(group.unsentCount)}개 ·{' '}
                          {syncOutboxTargetLabel(group.items[0]!)}
                        </span>
                        <small>{group.snapshotPreview.summary}</small>
                        {snapshotState?.status === 'loading' && <small>서버 AI/TTS snapshot 확인 중...</small>}
                        {snapshotState?.status === 'failed' && (
                          <small>서버 snapshot 확인 실패: {snapshotState.error}</small>
                        )}
                        {group.snapshotPreview.fieldDiffs.slice(0, 3).map((diff) => {
                          const key = aiTtsFieldDiffKey(diff);
                          return (
                            <label key={`${group.key}-${diff.itemId}-${diff.field}`} className="sync-ai-field-choice">
                              <input
                                type="checkbox"
                                checked={Boolean(data.mergeSelections[group.key]?.[key])}
                                onChange={(event) => actions.setMergeSelection(group.key, key, event.target.checked)}
                                disabled={
                                  data.syncFlushing ||
                                  snapshotState?.status !== 'ready' ||
                                  !aiTtsRemoteSnapshotApplyAvailable(group)
                                }
                              />
                              <span>
                                {diff.itemLabel} · {diff.field}: {diff.remoteValue ?? '없음'} →{' '}
                                {diff.localValue ?? '없음'}
                              </span>
                            </label>
                          );
                        })}
                        <p>{group.policyDescription}</p>
                        <small>{group.recommendedAction}</small>
                        {group.latestError && <small>최근 사유: {group.latestError}</small>}
                      </div>
                      <div className="sync-event-actions">
                        <em>
                          {group.failedCount > 0
                            ? `실패 ${formatCount(group.failedCount)}개`
                            : outboxStatusLabel(group.items[0]!.status)}
                        </em>
                        {snapshotState?.status === 'ready' &&
                          aiTtsRemoteSnapshotApplyAvailable(group) &&
                          group.canDiscard && (
                            <button
                              className="mini-icon-btn"
                              type="button"
                              onClick={() =>
                                void runSyncMergeAction(
                                  group.key,
                                  () => actions.applySelectedLocalFields(group, snapshotState.snapshot, selectedKeys),
                                  actions.clearMergeSelection,
                                )
                              }
                              disabled={data.syncFlushing || selectedKeys.length === 0}
                              title="선택한 로컬 필드 유지"
                              aria-label="선택한 로컬 필드 유지"
                            >
                              <SlidersHorizontal size={14} />
                            </button>
                          )}
                        {snapshotState?.status === 'ready' &&
                          aiTtsRemoteSnapshotApplyAvailable(group) &&
                          group.canDiscard && (
                            <button
                              className="mini-icon-btn"
                              type="button"
                              onClick={() =>
                                void runSyncMergeAction(
                                  group.key,
                                  () => actions.applyRemoteSnapshot(group, snapshotState.snapshot),
                                  actions.clearMergeSelection,
                                )
                              }
                              disabled={data.syncFlushing}
                              title="서버 snapshot 적용"
                              aria-label="서버 snapshot 적용"
                            >
                              <Check size={14} />
                            </button>
                          )}
                        {group.canDiscard && (
                          <button
                            className="mini-icon-btn"
                            type="button"
                            onClick={() => void actions.discardOutboxGroup(group.items, group.title)}
                            disabled={data.syncFlushing}
                            title="이 AI/TTS 묶음 폐기"
                            aria-label="이 AI/TTS 묶음 폐기"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {groupsWithSnapshots.length > visibleGroups.length && (
                  <small>
                    외 {formatCount(groupsWithSnapshots.length - visibleGroups.length)}개 AI/TTS 묶음이 더 있습니다.
                  </small>
                )}
              </div>
              <div className="sync-ai-conflict-list">
                {visibleItems.map((item) => (
                  <div key={`ai-sync-${item.id}`} className="sync-ai-conflict-row">
                    <div>
                      <strong>{syncEventTypeLabel(item.event.type)}</strong>
                      <span>
                        {syncOutboxRevisionLabel(item)} · {syncOutboxTargetLabel(item)}
                      </span>
                      {item.lastError && <small>{item.lastError}</small>}
                    </div>
                    <div className="sync-event-actions">
                      <em>{outboxStatusLabel(item.status)}</em>
                      {item.status !== 'sending' && (
                        <button
                          className="mini-icon-btn"
                          type="button"
                          onClick={() => void actions.discardOutboxItem(item)}
                          disabled={data.syncFlushing}
                          title="이 AI/TTS 변경 폐기"
                          aria-label="이 AI/TTS 변경 폐기"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {aiTtsSummary.items.length > visibleItems.length && (
                  <small>
                    외 {formatCount(aiTtsSummary.items.length - visibleItems.length)}개 AI/TTS 변경이 더 있습니다.
                  </small>
                )}
              </div>
            </div>
          )}
          <button className="primary-btn wide" onClick={() => void actions.retry()} disabled={!syncCanRetry}>
            <RefreshCw size={18} />{' '}
            {syncActionLabel({
              backendMode: data.mode,
              syncFlushing: data.syncFlushing || data.serverAttachBusy,
              state: data.syncState,
            })}
          </button>
          {data.syncServiceConnected && data.syncState?.status === 'conflict' && (
            <button
              className="ghost-btn wide"
              onClick={() => void actions.acceptRemoteState()}
              disabled={data.syncFlushing}
            >
              <Check size={17} /> 서버 상태로 정리
            </button>
          )}
          {data.remoteReadingPosition && (
            <div className="remote-position-card">
              <div>
                <strong>{data.remoteReadingPositionChapterTitle ?? '서버 읽은 위치'}</strong>
                <span>
                  {formatProgress(data.remoteReadingPosition.chapterProgress)}
                  {data.remoteReadingPosition.paragraphIndex > 0
                    ? ` · ${formatCount(data.remoteReadingPosition.paragraphIndex)}문단`
                    : ''}{' '}
                  · {formatDateTime(data.remoteReadingPosition.updatedAt)}
                </span>
              </div>
              <button className="ghost-btn wide" onClick={() => void actions.goToRemoteReadingPosition()}>
                <BookOpen size={17} /> 서버 위치로 이동
              </button>
            </div>
          )}
          {data.mode === 'local' && (
            <div className="remote-position-card server-attach-card">
              <div>
                <strong>서버 본문 연결</strong>
                <span>
                  {data.serverAttachAvailable
                    ? data.selectedNovel
                      ? `"${data.selectedNovel.title}" 본문을 서버에 업로드하고 같은 책 ID로 연결합니다.`
                      : '책을 연 뒤 서버 본문 업로드를 사용할 수 있습니다.'
                    : '아래 서버 연결에서 API URL을 저장하면 로컬 책을 서버와 연결할 수 있습니다.'}
                </span>
              </div>
              <div className="server-attach-actions">
                <button
                  className="ghost-btn wide"
                  onClick={() => void actions.uploadSelectedNovelToServer()}
                  disabled={
                    !data.serverAttachAvailable ||
                    !data.selectedNovel ||
                    data.serverAttachBusy ||
                    data.syncFlushing ||
                    data.importBusy
                  }
                >
                  <Upload size={17} /> 서버에 본문 업로드
                </button>
                {data.serverAttachBusy && (
                  <button className="ghost-btn wide" onClick={actions.cancelServerAttach}>
                    <Square size={16} /> 업로드 취소
                  </button>
                )}
              </div>
              {data.serverAttachProgress && (
                <div className="server-attach-progress">
                  <div className="progress-track">
                    <span style={{ width: `${data.serverAttachPercent}%` }} />
                  </div>
                  <div className="import-progress-stats">
                    <span>{data.serverAttachProgress.message}</span>
                    <span>{data.serverAttachPercent}%</span>
                    <span>{formatCount(data.serverAttachProgress.chaptersDetected)}개 화</span>
                    <span>{formatCount(data.serverAttachProgress.paragraphsWritten)}문단</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
        {data.mode === 'local' && (
          <section>
            <h3>서버 연결</h3>
            <div className="auth-token-row sync-url-row">
              <input
                type="url"
                value={data.syncApiBaseUrlDraft}
                onChange={(event) => actions.setSyncApiBaseUrlDraft(event.target.value)}
                placeholder="http://127.0.0.1:3000/api"
                autoComplete="off"
              />
              <button
                className="ghost-btn"
                type="button"
                onClick={() => void actions.testSyncConnection()}
                disabled={data.syncConnectionTest.status === 'testing'}
              >
                <RefreshCw size={16} /> 테스트
              </button>
              <button className="ghost-btn" type="button" onClick={actions.saveSyncApiBaseUrl}>
                <Check size={16} /> 저장
              </button>
            </div>
            <p className="muted">
              현재 런타임: {data.apiBaseUrl || '로컬 전용'}. 서버 URL 저장은 앱을 다시 불러온 뒤 동기화/본문 연결
              서비스에 적용됩니다.
            </p>
            {data.syncConnectionTest.status !== 'idle' && (
              <p className={classNames('connection-test-message', data.syncConnectionTest.status)}>
                {data.syncConnectionTest.status === 'testing'
                  ? `${data.syncConnectionTest.normalizedBaseUrl || '서버'} 확인 중...`
                  : `${data.syncConnectionTest.normalizedBaseUrl || '서버'}: ${data.syncConnectionTest.message}`}
              </p>
            )}
          </section>
        )}
        <section>
          <h3>{syncConfigured ? '대기 중인 변경' : '로컬 변경 기록'}</h3>
          {activeOutbox.length === 0 ? (
            <p className="empty-panel">
              {data.mode === 'remote'
                ? '호스팅 서버 모드에서는 변경이 즉시 API에 저장됩니다.'
                : syncConfigured
                  ? '전송 대기 중인 로컬 변경이 없습니다.'
                  : '서버에 연결하지 않아도 독서 기록은 이 기기에 저장됩니다.'}
            </p>
          ) : (
            <div className="sync-event-list">
              {activeOutbox.map((item) => (
                <div key={item.id} className={classNames('sync-event-row', item.status)}>
                  <div>
                    <strong>{syncEventTypeLabel(item.event.type)}</strong>
                    <span>
                      {formatDateTime(item.updatedAt)} · 시도 {formatCount(item.attempts)}회
                    </span>
                    <span>{syncOutboxRevisionLabel(item)}</span>
                    <span>{syncOutboxTargetLabel(item)}</span>
                    {item.lastError && <small>{item.lastError}</small>}
                  </div>
                  <div className="sync-event-actions">
                    <em>{outboxStatusLabel(item.status)}</em>
                    {syncConfigured && item.status !== 'sending' && (
                      <button
                        className="mini-icon-btn"
                        type="button"
                        onClick={() => void actions.discardOutboxItem(item)}
                        disabled={data.syncFlushing}
                        title="이 로컬 변경 폐기"
                        aria-label="이 로컬 변경 폐기"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {outboxSummary.unsentCount > activeOutbox.length && (
                <p className="sync-event-overflow">
                  그 외 대기열 {formatCount(outboxSummary.unsentCount - activeOutbox.length)}개는 동기화 시 순서대로
                  처리됩니다.
                </p>
              )}
            </div>
          )}
        </section>
        {(data.mode === 'local' || syncConfigured) && (
          <section>
            <h3>서버 인증</h3>
            <div className="auth-token-row">
              <input
                type="password"
                value={data.apiAuthTokenDraft}
                onChange={(event) => actions.setApiAuthTokenDraft(event.target.value)}
                placeholder={data.apiAuthTokenConfigured ? '저장됨 · 새 토큰 입력 시 교체' : 'Bearer token'}
                autoComplete="off"
                aria-label="서버 인증 Bearer token"
              />
              <button className="ghost-btn" onClick={actions.saveApiAuthToken}>
                {data.apiAuthTokenConfigured && !data.apiAuthTokenDraft.trim() ? '지우기' : '저장'}
              </button>
            </div>
            <p className="muted">
              {data.apiAuthTokenStorage === 'android_keystore'
                ? '보호된 self-host 서버에 연결할 때 사용합니다. 값은 Android Keystore로 암호화되며 화면에 다시 표시되지 않습니다.'
                : '보호된 self-host 서버에 연결할 때 사용합니다. 값은 현재 브라우저 저장소에 보관되며 provider API key와 별개입니다.'}
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}
