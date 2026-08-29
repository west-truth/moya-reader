import {
  MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import { AIWorkflowPanel } from '../../features/ai/AIWorkflowPanel';
import {
  ConfiguredBookAITTSPreparationRunner,
  type BookAITTSPreparationRunner,
} from '../../features/ai/book-ai-tts-preparation-runner';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';
import type { TrustedWorkflowRunnerRegistration } from '../trusted-workflow-runner-registry';

export const DETAILED_SPEAKER_AI_TTS_EXTENSION_ID = 'moya.ai.tts.detailed' as const;
export const DETAILED_SPEAKER_AI_TTS_WORKFLOW_ID = 'moya.ai.tts.detailed.speaker-preparation' as const;
export const DETAILED_SPEAKER_AI_TTS_WORKFLOW_VERSION = '1.0.0' as const;

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: DETAILED_SPEAKER_AI_TTS_EXTENSION_ID,
  name: 'Moya Detailed Speaker AI TTS',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['analysis.workflow.execute'],
  contributes: {
    analysisWorkflows: [
      {
        id: DETAILED_SPEAKER_AI_TTS_WORKFLOW_ID,
        schemaVersion: MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: '세밀한 화자 분리',
        description: '더 작은 라벨링 창으로 작품을 분석해 화자와 음성 연결을 준비합니다.',
        target: 'book',
        kind: 'managed',
        order: 110,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

export const detailedSpeakerAITTSTrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    return context.analysisWorkflows.register(DETAILED_SPEAKER_AI_TTS_WORKFLOW_ID, {
      isEnabled: ({ bookAITTS }) => Boolean(bookAITTS?.enabled),
      render: ({ bookAITTS }) =>
        bookAITTS ? <AIWorkflowPanel data={bookAITTS.data} actions={bookAITTS.actions} /> : null,
    });
  },
};

export const detailedSpeakerAITTSRunnerRegistration: TrustedWorkflowRunnerRegistration<BookAITTSPreparationRunner> = {
  workflowId: DETAILED_SPEAKER_AI_TTS_WORKFLOW_ID,
  workflowVersion: DETAILED_SPEAKER_AI_TTS_WORKFLOW_VERSION,
  create: (baseRunner) =>
    new ConfiguredBookAITTSPreparationRunner(
      DETAILED_SPEAKER_AI_TTS_WORKFLOW_ID,
      DETAILED_SPEAKER_AI_TTS_WORKFLOW_VERSION,
      baseRunner,
      {
        maxLabelingParagraphs: 2,
      },
    ),
};
