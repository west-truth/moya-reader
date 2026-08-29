import type { AIAddonPanelActions, AIWorkflowPanelData } from '../features/ai/ai-addon-panel-contract';

export interface TrustedAnalysisWorkflowHostContext {
  readonly target?: {
    readonly bookId: string;
    readonly contentRevisionId?: string;
    readonly chapterId?: string;
  };
  readonly bookAITTS?: {
    readonly enabled: boolean;
    readonly data: AIWorkflowPanelData;
    readonly actions: AIAddonPanelActions['workflow'];
  };
  readonly characterBundleAnalysis: {
    readonly enabled: boolean;
    run(): unknown | Promise<unknown>;
  };
}
