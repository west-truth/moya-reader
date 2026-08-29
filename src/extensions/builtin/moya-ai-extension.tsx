import {
  MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import { AIWorkflowPanel } from '../../features/ai/AIWorkflowPanel';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';
import { BOOK_AI_TTS_WORKFLOW_ID } from './book-ai-tts-workflow-extension';
import { CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID } from './character-bundle-analysis-extension';

export const MOYA_AI_EXTENSION_ID = 'moya.ai' as const;
export const MOYA_AI_ADDON_ID = 'moya.ai.panel' as const;

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: MOYA_AI_EXTENSION_ID,
  name: 'Moya AI',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['reader.addon.render', 'reader.context.read', 'analysis.workflow.execute'],
  contributes: {
    readerAddonTabs: [
      {
        id: MOYA_AI_ADDON_ID,
        label: 'AI',
        icon: 'wand',
        order: 60,
      },
    ],
    analysisWorkflows: [
      {
        id: CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID,
        schemaVersion: MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: '묶음 인물 분석',
        description: '현재 화부터 이어지는 화에서 인물과 관계 후보를 준비합니다.',
        target: 'chapter-bundle',
        order: 100,
      },
      {
        id: BOOK_AI_TTS_WORKFLOW_ID,
        schemaVersion: MOYA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: 'Moya AI 분석',
        description: '작품을 분석해 화자 라벨과 캐릭터 음성 연결을 준비합니다.',
        target: 'book',
        kind: 'managed',
        order: 100,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

/** Official beta AI surfaces. System/basic TTS remains outside this extension. */
export const moyaAITrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    context.readerAddons.register(MOYA_AI_ADDON_ID, ({ aiPanel }) => aiPanel ?? null);
    context.analysisWorkflows.register(CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID, {
      isEnabled: ({ characterBundleAnalysis }) => characterBundleAnalysis.enabled,
      run: ({ characterBundleAnalysis }) => characterBundleAnalysis.run(),
    });
    context.analysisWorkflows.register(BOOK_AI_TTS_WORKFLOW_ID, {
      isEnabled: ({ bookAITTS }) => Boolean(bookAITTS?.enabled),
      render: ({ bookAITTS }) =>
        bookAITTS ? <AIWorkflowPanel data={bookAITTS.data} actions={bookAITTS.actions} /> : null,
    });
  },
};
