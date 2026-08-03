import { lazy, Suspense } from 'react';
import { RefreshCw, RotateCcw, Users, Wand2 } from 'lucide-react';
import type { AIAddonPanelActions, AIAnalysisPanelData } from './ai-addon-panel-contract';
import type { ProviderSettingsPanelController } from '../providers/ProviderSettingsPanel';

const ProviderSettingsPanel = lazy(() => import('../providers/ProviderSettingsPanel'));

export function AIAnalysisControls({
  data,
  actions,
  providerController,
  showPrimaryAction,
}: {
  readonly data: AIAnalysisPanelData;
  readonly actions: AIAddonPanelActions['analysis'];
  readonly providerController: ProviderSettingsPanelController;
  readonly showPrimaryAction: boolean;
}) {
  const recommendedAction =
    data.desktopProviderMode && !data.desktopAnalysisDisabled
      ? { label: '이 화를 기기에서 분석', run: actions.runDesktop }
      : !data.remoteAnalysisDisabled
        ? { label: '이 화를 서버에서 분석', run: actions.runRemote }
        : undefined;

  return (
    <>
      <div className="addon-status ai-analysis-summary">
        <span>현재 화</span>
        <strong>{data.segmentCount ? '라벨 준비됨' : '분석 안 함'}</strong>
      </div>
      {showPrimaryAction && recommendedAction && (
        <button className="primary-btn wide ai-recommended-action" onClick={() => void recommendedAction.run()}>
          <Wand2 size={18} /> {recommendedAction.label}
        </button>
      )}
      {showPrimaryAction && !recommendedAction && (
        <p className="muted">분석을 실행하려면 아래 연결 설정에서 사용할 provider를 준비하세요.</p>
      )}
      <details className="ai-advanced-disclosure">
        <summary>화 단위 작업 및 연결 설정</summary>
        <div className="ai-advanced-content">
          <div className="ai-action-grid">
            {data.showDeveloperTools && (
              <button className="ghost-btn" onClick={() => void actions.runMock()} disabled={data.mockDisabled}>
                <Wand2 size={18} /> 로컬 Mock
              </button>
            )}
            {data.desktopProviderMode && (
              <button
                className="ghost-btn"
                onClick={() => void actions.runDesktop()}
                disabled={data.desktopAnalysisDisabled}
              >
                <Wand2 size={18} /> 기기 분석
              </button>
            )}
            <button
              className="ghost-btn"
              onClick={() => void actions.runRemote()}
              disabled={data.remoteAnalysisDisabled}
            >
              <Wand2 size={18} /> 서버 분석
            </button>
            <button
              className="ghost-btn"
              onClick={() => void actions.repairLabels()}
              disabled={data.labelRepairDisabled}
            >
              <RotateCcw size={18} /> 라벨 복구
            </button>
            <button
              className="ghost-btn"
              onClick={() => void actions.analyzeBundle()}
              disabled={data.bundleAnalysisDisabled}
            >
              <Users size={18} /> 묶음 인물 분석
            </button>
            <button className="ghost-btn" onClick={() => void actions.mergeGraph()} disabled={data.graphMergeDisabled}>
              <RefreshCw size={18} /> 후보 병합
            </button>
          </div>
          <dl className="ai-diagnostic-list">
            <div>
              <dt>묶음 분석</dt>
              <dd>{data.bundleStatusLabel}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{data.providerStatusLabel}</dd>
            </div>
          </dl>
          {data.remoteJob && (
            <div className="provider-job-card">
              <strong>
                {data.remoteJob.providerId}
                {data.remoteJob.modelId ? ` · ${data.remoteJob.modelId}` : ''}
              </strong>
              <span>
                {data.remoteJob.status}
                {data.remoteJob.stage ? ` · ${data.remoteJob.stage}` : ''}
              </span>
              {data.remoteJob.errorMessage && <small>{data.remoteJob.errorMessage}</small>}
            </div>
          )}
          <Suspense fallback={<div className="provider-settings-card" aria-busy="true" />}>
            <ProviderSettingsPanel
              scope="llm_labeling"
              title="분석 provider"
              providers={data.providers}
              draft={data.providerDraft}
              controller={providerController}
            />
          </Suspense>
        </div>
      </details>
    </>
  );
}
