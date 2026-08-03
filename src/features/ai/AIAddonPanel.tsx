import { AIAnalysisControls } from './AIAnalysisControls';
import { AILabelCorrectionPanel } from './AILabelCorrectionPanel';
import { AIWorkflowPanel } from './AIWorkflowPanel';
import { CharacterGraphReviewPanel } from './CharacterGraphReviewPanel';
import type { AIAddonPanelProps } from './ai-addon-panel-contract';

export type {
  AIAddonPanelActions,
  AIAddonPanelController,
  AIAddonPanelData,
  AIAddonPanelProps,
} from './ai-addon-panel-contract';

export default function AIAddonPanel({ data, actions, controller }: AIAddonPanelProps) {
  return (
    <div className="panel-body ai-addon-body">
      <header className="addon-intro">
        <h3>AI 분석</h3>
        <p className="muted">현재 작품의 화자와 감정 라벨을 준비하고 필요한 항목만 검토합니다.</p>
      </header>
      <section className="ai-workspace-section ai-workspace-primary">
        <AIWorkflowPanel data={data.workflow} actions={actions.workflow} />
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
