import { AIAnalysisControls } from './AIAnalysisControls';
import { AILabelCorrectionPanel } from './AILabelCorrectionPanel';
import { CharacterGraphReviewPanel } from './CharacterGraphReviewPanel';
import type { AIAddonPanelProps } from './ai-addon-panel-contract';

export type {
  AIAddonPanelActions,
  AIAddonPanelController,
  AIAddonPanelData,
  AIAddonPanelProps,
} from './ai-addon-panel-contract';

export default function AIAddonPanel({ data, actions, controller, managedWorkflow }: AIAddonPanelProps) {
  const activeWorkflowId = managedWorkflow.active?.id;
  return (
    <div className="panel-body ai-addon-body">
      <header className="addon-intro">
        <h3>AI 분석</h3>
        <p className="muted">현재 작품의 화자와 감정 라벨을 준비하고 필요한 항목만 검토합니다.</p>
      </header>
      <section className="ai-workspace-section ai-workspace-primary">
        {(managedWorkflow.options.length > 1 || managedWorkflow.usedFallback) && (
          <div className="ai-managed-workflow-picker">
            <label htmlFor="ai-managed-workflow">AI 분석 방식</label>
            <select
              id="ai-managed-workflow"
              value={activeWorkflowId}
              disabled={managedWorkflow.switchDisabled}
              onChange={(event) => managedWorkflow.select(event.target.value as `${string}.${string}`)}
            >
              {managedWorkflow.options.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.title}
                </option>
              ))}
            </select>
            {managedWorkflow.active?.description && <small>{managedWorkflow.active.description}</small>}
            {managedWorkflow.usedFallback && (
              <small className="field-warning">저장된 분석 방식을 사용할 수 없어 기본 방식을 사용합니다.</small>
            )}
            {managedWorkflow.switchDisabledReason && <small>{managedWorkflow.switchDisabledReason}</small>}
          </div>
        )}
        {managedWorkflow.surface ? (
          <div data-workflow-id={activeWorkflowId} data-workflow-kind="managed">
            {managedWorkflow.surface}
          </div>
        ) : (
          <div className="provider-job-card book-workflow-card" data-workflow-kind="managed-empty">
            <div className="panel-section-title">
              <h4>작품 분석</h4>
              <span>사용 불가</span>
            </div>
            <p className="ai-workflow-summary">
              AI 분석 기능을 꺼도 일반 듣기와 시스템 음성은 계속 사용할 수 있습니다.
            </p>
          </div>
        )}
      </section>
      <section className="ai-workspace-section ai-workspace-operations">
        <AIAnalysisControls
          data={data.analysis}
          actions={actions.analysis}
          providerController={controller.providerSettings}
          showPrimaryAction={!data.workflow.workflowRuntime}
        />
        {data.graphReview && (
          <details className="ai-advanced-disclosure">
            <summary>인물 후보 검토</summary>
            <CharacterGraphReviewPanel
              data={data.graphReview}
              toggleCandidate={actions.graphReview.toggleCandidate}
              confirmFact={actions.graphReview.confirmFact}
              rejectFact={actions.graphReview.rejectFact}
              mergeCandidate={actions.graphReview.mergeCandidate}
              splitFact={actions.graphReview.splitFact}
            />
          </details>
        )}
      </section>
      <section className="ai-workspace-section ai-workspace-corrections">
        <details
          className="ai-advanced-disclosure"
          open={data.correction.reviewItems.length > 0 || Boolean(data.correction.target)}
        >
          <summary>
            라벨 검토 및 수정
            {data.correction.reviewItems.length > 0 ? ` · ${data.correction.reviewItems.length}개` : ''}
          </summary>
          <AILabelCorrectionPanel data={data.correction} actions={actions.correction} />
        </details>
      </section>
    </div>
  );
}
