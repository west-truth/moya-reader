import { RefreshCw, RotateCcw, Square, Users } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { formatCount } from '../../utils/format';
import type { AIAddonPanelActions, AIWorkflowPanelData } from './ai-addon-panel-contract';
import { AnalysisReviewWorkspace } from './AnalysisReviewWorkspace';

function workflowStatusDescription(data: AIWorkflowPanelData): string {
  if (!data.workflowRuntime) return '전체 작품 분석은 서버 연결 또는 데스크톱 앱에서 사용할 수 있습니다.';
  if (data.reviewItems.length > 0) return `검토가 필요한 항목 ${formatCount(data.reviewItems.length)}개가 있습니다.`;
  if (data.pendingJobCount > 0)
    return `분석 작업 ${formatCount(data.pendingJobCount)}개가 진행 중이거나 대기 중입니다.`;
  if (data.labelVoiceReady && !data.cacheReady)
    return '라벨과 음성 연결이 끝났습니다. 듣기용 음성을 준비할 수 있습니다.';
  if (data.cacheReady) return '분석과 듣기용 음성 준비가 완료되었습니다.';
  return '전체 분석을 시작하면 인물 관계와 화자 라벨을 순서대로 준비합니다.';
}

export function AIWorkflowPanel({
  data,
  actions,
}: {
  readonly data: AIWorkflowPanelData;
  readonly actions: AIAddonPanelActions['workflow'];
}) {
  const refreshCacheReadinessRef = useRef(actions.refreshCacheReadiness);
  refreshCacheReadinessRef.current = actions.refreshCacheReadiness;
  useEffect(() => {
    if (data.workflowRuntime === 'native' && data.labelVoiceReady) {
      void refreshCacheReadinessRef.current(true);
    }
  }, [data.labelVoiceReady, data.workflowRuntime]);
  const primaryAction = !data.workflowRuntime
    ? undefined
    : data.failedJobCount > 0 && !data.retryDisabled
      ? { label: '분석 다시 시도', icon: RotateCcw, run: actions.retry }
      : data.labelVoiceReady && !data.cacheReady && !data.warmupDisabled
        ? { label: '듣기용 음성 준비', icon: RefreshCw, run: actions.warmupBookCache }
        : !data.startDisabled
          ? { label: '작품 전체 분석 시작', icon: Users, run: actions.start }
          : !data.refreshDisabled
            ? { label: '분석 상태 새로고침', icon: RefreshCw, run: actions.refresh }
            : undefined;
  const PrimaryIcon = primaryAction?.icon;

  return (
    <div className="provider-job-card book-workflow-card">
      <div className="panel-section-title">
        <h4>작품 분석</h4>
        <span>{data.stageLabel}</span>
      </div>
      <p className="ai-workflow-summary">{workflowStatusDescription(data)}</p>
      {primaryAction && PrimaryIcon && (
        <button className="primary-btn wide ai-recommended-action" onClick={() => void primaryAction.run()}>
          <PrimaryIcon size={18} /> {primaryAction.label}
        </button>
      )}
      <details className="ai-advanced-disclosure">
        <summary>고급 정보</summary>
        <div className="ai-advanced-content">
          <div className="workflow-metrics">
            <span>
              <strong>{formatCount(data.graphBundleCount)}</strong> Graph bundles
            </span>
            <span>
              <strong>{formatCount(data.labelingWindowCount)}</strong> Label windows
            </span>
            <span>
              <strong>{formatCount(data.succeededJobCount)}</strong> Done jobs
            </span>
            <span>
              <strong>{formatCount(data.pendingJobCount)}</strong> Queued/running jobs
            </span>
          </div>
          {data.labelingBudget && (
            <div className="workflow-status-row">
              <span>Model-aware labeling budget</span>
              <small>
                window {formatCount(data.labelingBudget.targetCharacters)} chars · context{' '}
                {formatCount(data.labelingBudget.contextWindowTokens)} tokens · output reserve{' '}
                {formatCount(data.labelingBudget.reservedOutputTokens)}
                {data.labelingBudget.estimated ? ' · estimated' : ''}
              </small>
            </div>
          )}
          <div className="ai-action-grid">
            <button className="ghost-btn" onClick={() => void actions.retry()} disabled={data.retryDisabled}>
              <RotateCcw size={18} /> Retry workflow
            </button>
            <button className="ghost-btn" onClick={() => void actions.cancel()} disabled={data.cancelDisabled}>
              <Square size={18} /> Request cancel
            </button>
            <button className="primary-btn" onClick={() => void actions.start()} disabled={data.startDisabled}>
              <Users size={18} /> 전체 분석 시작
            </button>
            <button className="ghost-btn" onClick={() => void actions.refresh()} disabled={data.refreshDisabled}>
              <RefreshCw size={18} /> 계획/상태 새로고침
            </button>
          </div>
          {data.workflow && (
            <div className="workflow-status-row">
              <span>
                {data.workflow.status} · {data.workflow.stage}
              </span>
              <small>
                jobs {formatCount(data.workflow.jobCount)}
                {data.failedJobCount > 0 ? ` · failed ${formatCount(data.failedJobCount)}` : ''}
                {data.workflow.modelId ? ` · ${data.workflow.modelId}` : ''}
              </small>
            </div>
          )}
          {data.compactSpeaker && (
            <section className="compact-speaker-workflow" aria-label="화자 분리 workflow 상태">
              <div className="compact-speaker-workflow-heading">
                <strong>화자 분리 · {data.compactSpeaker.stageLabel}</strong>
                <small>
                  계약 {data.compactSpeaker.contractId}
                  {data.compactSpeaker.requestProfileId ? ` · 프로필 ${data.compactSpeaker.requestProfileId}` : ''}
                </small>
              </div>
              <div className="compact-speaker-workflow-facts">
                {data.compactSpeaker.targetSpanCount !== undefined && (
                  <span>대상 구간 {formatCount(data.compactSpeaker.targetSpanCount)}</span>
                )}
                {data.compactSpeaker.sceneRequestCount !== undefined && (
                  <span>장면 요청 {formatCount(data.compactSpeaker.sceneRequestCount)}</span>
                )}
                {data.compactSpeaker.escalationCapLabel && (
                  <span>재판별 한도 {data.compactSpeaker.escalationCapLabel}</span>
                )}
              </div>
              {data.compactSpeaker.riskSummaries.length > 0 && (
                <div className="compact-speaker-workflow-risks" aria-label="화자 분리 검토 사유">
                  <span>검토 사유</span>
                  <div>
                    {data.compactSpeaker.riskSummaries.map((risk) => (
                      <small key={risk.riskClass}>
                        {risk.label} {formatCount(risk.targetSpanCount)}
                      </small>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
          {data.labelVoiceReadiness && (
            <div className="workflow-status-row">
              <span>Label/voice readiness {data.labelVoiceReadiness.ok ? 'passed' : 'needs review'}</span>
              <small>
                segments {formatCount(data.labelVoiceReadiness.segmentCount)} · missing paragraphs{' '}
                {formatCount(data.labelVoiceReadiness.missingParagraphCount)} · missing voices{' '}
                {formatCount(data.labelVoiceReadiness.missingVoiceCount)} · unknown{' '}
                {data.labelVoiceReadiness.unknownPercent}%
              </small>
            </div>
          )}
          {data.cacheReadiness && (
            <div className="workflow-status-row">
              <span>Audio cache readiness {data.cacheReadiness.ok ? 'passed' : 'not complete'}</span>
              <small>
                cached {formatCount(data.cacheReadiness.cachedSegmentCount)}/
                {formatCount(data.cacheReadiness.cacheableSegmentCount)}
                {' · missing '}
                {formatCount(data.cacheReadiness.missingCachedSegmentCount)} · items{' '}
                {formatCount(data.cacheReadiness.cacheItemCount)} · {data.cacheReadiness.cachedByteSizeLabel}
              </small>
            </div>
          )}
          {data.labelVoiceReady && (
            <div className="workflow-next-action">
              <div>
                <strong>{data.cacheReady ? 'TTS cache 준비됨' : '다음 단계: TTS cache'}</strong>
                <span>
                  {data.cacheReady
                    ? '오디오 cache evidence가 workflow에 기록되었습니다.'
                    : '라벨/음성 매핑은 통과했습니다. 실제 오디오 cache는 별도로 준비해야 합니다.'}
                </span>
              </div>
              <button
                className="ghost-btn"
                onClick={() => void actions.warmupBookCache()}
                disabled={data.warmupDisabled}
              >
                <RefreshCw size={16} /> 책 전체 cache 준비
              </button>
              <button
                className="ghost-btn"
                onClick={() => void actions.refreshCacheReadiness()}
                disabled={data.cacheRefreshDisabled}
              >
                <RefreshCw size={16} /> cache 상태 확인
              </button>
            </div>
          )}
        </div>
      </details>
      <AnalysisReviewWorkspace data={data.reviewWorkspace} actions={actions} />
      {data.reviewItems.length > 0 && (
        <div className="workflow-review-list" aria-label="Workflow review items">
          <div className="workflow-review-heading">
            <span>검토 항목</span>
            <small>{formatCount(data.reviewItems.length)} items</small>
          </div>
          {data.reviewItems.slice(0, 4).map((item) => (
            <div className="workflow-review-item" data-severity={item.severity} key={item.id}>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
              <button
                type="button"
                className="text-action-btn"
                onClick={() => void actions.runReviewAction(item)}
                disabled={
                  (item.recommendedAction === 'retry_workflow' ||
                    item.recommendedAction === 'retry_same_request' ||
                    item.recommendedAction === 'resume_after_fix') &&
                  data.retryDisabled
                }
              >
                {item.actionLabel}
              </button>
            </div>
          ))}
          {data.reviewItems.length > 4 && (
            <small className="workflow-review-more">
              외 {formatCount(data.reviewItems.length - 4)}개 항목은 상태 새로고침 후 상세 로그에서 확인하세요.
            </small>
          )}
        </div>
      )}
      {data.error && <p className="field-error">{data.error}</p>}
      {data.workflow?.errorMessage && <p className="field-error">{data.workflow.errorMessage}</p>}
    </div>
  );
}
