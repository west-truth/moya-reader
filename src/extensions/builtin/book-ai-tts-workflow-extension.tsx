import {
  MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import { AIWorkflowPanel } from '../../features/ai/AIWorkflowPanel';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  DEFAULT_BOOK_AI_WORKFLOW_VERSION,
} from '../../providers/book-ai-workflow-definition';
import {
  ConfiguredBookAITTSPreparationRunner,
  type BookAITTSPreparationRunner,
} from '../../features/ai/book-ai-tts-preparation-runner';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';
import type { TrustedWorkflowRunnerRegistration } from '../trusted-workflow-runner-registry';

export const BOOK_AI_TTS_EXTENSION_ID = 'moya.ai.tts' as const;
export const BOOK_AI_TTS_WORKFLOW_ID = DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID;
export const BOOK_AI_TTS_WORKFLOW_VERSION = DEFAULT_BOOK_AI_WORKFLOW_VERSION;

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: BOOK_AI_TTS_EXTENSION_ID,
  name: 'Moya AI-assisted TTS',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['analysis.workflow.execute'],
  contributes: {
    analysisWorkflows: [
      {
        id: BOOK_AI_TTS_WORKFLOW_ID,
        schemaVersion: MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: '기본 AI 보조 TTS',
        description: '작품을 분석해 화자 라벨과 캐릭터 음성 연결을 준비합니다.',
        target: 'book',
        kind: 'managed',
        order: 100,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

export const bookAITTSTrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    return context.analysisWorkflows.register(BOOK_AI_TTS_WORKFLOW_ID, {
      isEnabled: ({ bookAITTS }) => Boolean(bookAITTS?.enabled),
      render: ({ bookAITTS }) =>
        bookAITTS ? <AIWorkflowPanel data={bookAITTS.data} actions={bookAITTS.actions} /> : null,
    });
  },
};

export const bookAITTSRunnerRegistration: TrustedWorkflowRunnerRegistration<BookAITTSPreparationRunner> = {
  workflowId: BOOK_AI_TTS_WORKFLOW_ID,
  workflowVersion: BOOK_AI_TTS_WORKFLOW_VERSION,
  create: (baseRunner) =>
    new ConfiguredBookAITTSPreparationRunner(
      BOOK_AI_TTS_WORKFLOW_ID,
      BOOK_AI_TTS_WORKFLOW_VERSION,
      baseRunner,
      {},
      {
        discoverActiveWorkflow: true,
        restoresLegacyWorkflowIds: true,
      },
    ),
};
