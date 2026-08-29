import type { TrustedAnalysisWorkflowHostContext } from './analysis-workflow-host-context';
import type { BookAITTSPreparationRunner } from '../features/ai/book-ai-tts-preparation-runner';
import { WebNovelMetadataCollectorBroker } from '../services/webnovel-metadata-collector-broker';
import { bookAITTSRunnerRegistration } from './builtin/book-ai-tts-workflow-extension';
import { moyaAITrustedExtension } from './builtin/moya-ai-extension';
import { readerInfoTrustedExtension } from './builtin/reader-info-extension';
import { createWebNovelMetadataEnrichmentTrustedExtension } from './builtin/webnovel-metadata-enrichment-extension';
import type { TrustedReaderAddonHostContext } from './reader-addon-host-context';
import { AppExtensionManager, type AppExtensionRegistration } from './app-extension-manager';
import { ExtensionEnablementStore } from './extension-enablement-store';
import { TrustedExtensionRegistry, type TrustedExtensionDefinition } from './trusted-extension-registry';
import {
  TrustedWorkflowRunnerRegistry,
  type TrustedWorkflowRunnerRegistration,
} from './trusted-workflow-runner-registry';

export interface AppExtensionRuntime {
  readonly trustedExtensions: TrustedExtensionRegistry<
    TrustedReaderAddonHostContext,
    TrustedAnalysisWorkflowHostContext
  >;
  readonly manager: AppExtensionManager<TrustedReaderAddonHostContext, TrustedAnalysisWorkflowHostContext>;
  readonly bookAITTSRunners: TrustedWorkflowRunnerRegistry<BookAITTSPreparationRunner>;
  readonly webNovelMetadataCollector: WebNovelMetadataCollectorBroker;
}

export interface AppExtensionRuntimeDependencies {
  readonly trustedDefinitions?: readonly TrustedExtensionDefinition<
    TrustedReaderAddonHostContext,
    TrustedAnalysisWorkflowHostContext
  >[];
  readonly trustedRegistrations?: readonly AppExtensionRegistration<
    TrustedReaderAddonHostContext,
    TrustedAnalysisWorkflowHostContext
  >[];
  readonly enablementStore?: ExtensionEnablementStore;
  readonly bookAITTSRunnerRegistrations?: readonly TrustedWorkflowRunnerRegistration<BookAITTSPreparationRunner>[];
  readonly webNovelMetadataCollector?: WebNovelMetadataCollectorBroker;
  /** Source-owned fixtures supplied by an explicit development bootstrap. */
  readonly additionalTrustedRegistrations?: readonly AppExtensionRegistration<
    TrustedReaderAddonHostContext,
    TrustedAnalysisWorkflowHostContext
  >[];
}

export function createAppExtensionRuntime(dependencies: AppExtensionRuntimeDependencies = {}): AppExtensionRuntime {
  const webNovelMetadataCollector = dependencies.webNovelMetadataCollector ?? new WebNovelMetadataCollectorBroker();
  const trustedExtensions = new TrustedExtensionRegistry<
    TrustedReaderAddonHostContext,
    TrustedAnalysisWorkflowHostContext
  >();
  const registrations =
    dependencies.trustedRegistrations ??
    (dependencies.trustedDefinitions
      ? dependencies.trustedDefinitions.map((definition) => ({
          definition,
          origin: 'bundled' as const,
          trustLevel: 'trusted' as const,
          defaultEnabled: true,
          canDisable: true,
        }))
      : [
          {
            definition: readerInfoTrustedExtension,
            origin: 'bundled' as const,
            trustLevel: 'trusted' as const,
            defaultEnabled: true,
            canDisable: true,
            description: '현재 작품과 읽기 상태를 Reader 보조 패널에서 확인합니다.',
          },
          {
            definition: moyaAITrustedExtension,
            origin: 'bundled' as const,
            trustLevel: 'trusted' as const,
            defaultEnabled: true,
            canDisable: true,
            beta: true,
            description: 'AI 분석과 화자·캐릭터 음성 준비 기능을 제공합니다.',
          },
          {
            definition: createWebNovelMetadataEnrichmentTrustedExtension(webNovelMetadataCollector),
            origin: 'bundled' as const,
            trustLevel: 'trusted' as const,
            defaultEnabled: false,
            canDisable: true,
            beta: true,
            description: '내장 수집기에서 웹소설 표지와 작품 정보를 찾아 검토 후보로 만듭니다.',
          },
          ...(dependencies.additionalTrustedRegistrations ?? []),
        ]);
  const manager = new AppExtensionManager(trustedExtensions, registrations, dependencies.enablementStore);
  const bookAITTSRunners = new TrustedWorkflowRunnerRegistry<BookAITTSPreparationRunner>();
  const runnerRegistrations =
    dependencies.bookAITTSRunnerRegistrations ??
    (dependencies.trustedDefinitions || dependencies.trustedRegistrations ? [] : [bookAITTSRunnerRegistration]);
  for (const registration of runnerRegistrations) {
    if (!manager.hasDeclaredManagedWorkflow(registration.workflowId)) {
      throw new Error(`Trusted book AI/TTS runner has no declared managed workflow: ${registration.workflowId}`);
    }
    bookAITTSRunners.register(registration);
  }
  return { trustedExtensions, manager, bookAITTSRunners, webNovelMetadataCollector };
}
