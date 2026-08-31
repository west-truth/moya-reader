import { X } from 'lucide-react';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties } from 'react';
import {
  type Chapter,
  type Character,
  type LabeledSegment,
  type ListeningPosition,
  type Novel,
  type Paragraph,
  type ReaderHighlight,
  type SpokenTextRule,
  type TTSDownloadJob,
  type TTSDownloadPolicy,
  type TTSPlaybackSettingsOverride,
  type UserCorrection,
  type VoiceProfile,
} from './domain/types';
import { characterAnalysisBundleId, voiceProfileId } from './domain/identity/ai-identities';
import { persistentId128 } from './domain/id-hash-contract';
import {
  chapterSegmentsRevision,
  characterGraphRevision,
  correctionsRevision,
  voiceProfilesRevision,
} from './domain/resource-revisions';
import { labelMutationSegmentHash } from './providers/label-mutation-contract';
import { runGuardedAppBootstrap, useAppBootstrap } from './app/hooks/use-app-bootstrap';
import { useAppRuntime } from './app/runtime/RuntimeProvider';
import { useOptionalSelfHostAuth } from './features/auth/SelfHostAccountGate';
import { useAnnotationsController } from './features/annotations/useAnnotationsController';
import { BookWorkspaceScreens } from './features/book-workspace/BookWorkspaceScreens';
import { BookWorkspaceStatsPanel } from './features/book-workspace/book-workspace-lazy-panels';
import type {
  BookWorkspaceAdjacentFeaturePort,
  BookWorkspaceTransitionPort,
} from './features/book-workspace/book-workspace-contract';
import { createBookWorkspacePortProxy } from './features/book-workspace/book-workspace-port-proxy';
import { useBookWorkspaceController } from './features/book-workspace/useBookWorkspaceController';
import { useBookWorkspaceProjection } from './features/book-workspace/useBookWorkspaceProjection';
import {
  ReaderScreenHandle,
  type ReaderAddonTab,
  type ReaderLocationSnapshot,
  type ReaderMode,
  type ReaderSelection,
} from './features/reader/reader-screen-contract';
import {
  CORE_READER_ADDON_TABS,
  ReaderAddonShell,
  type ReaderAddonTabDescriptor,
} from './features/reader/ReaderAddonShell';
import type { TrustedReaderAddonHostContext } from './extensions/reader-addon-host-context';
import type { TrustedAnalysisWorkflowHostContext } from './extensions/analysis-workflow-host-context';
import { resolveTrustedBookAITTSWorkflow, selectManagedBookWorkflow } from './extensions/analysis-workflow-selection';
import { READER_INFO_ADDON_ID } from './extensions/builtin/reader-info-extension';
import { MOYA_AI_ADDON_ID, MOYA_AI_EXTENSION_ID } from './extensions/builtin/moya-ai-extension';
import { useReaderSettingsDraft } from './features/reader-settings/useReaderSettingsDraft';
import type { SettingsTab } from './features/reader-settings/ReaderSettingsPanel';
import { useReaderBasicsScreenModel } from './features/reader-settings/useReaderBasicsScreenModel';
import { useActiveReaderFont } from './features/reader-settings/useActiveReaderFont';
import { resolveReaderThemeColors } from './features/reader-settings/reader-theme-colors';
import {
  appThemeColor,
  isDarkThemeColor,
  normalizeApplicationThemeColors,
  resolveAppTheme,
} from './features/reader-settings/app-theme';
import { useListeningSession } from './features/reader/use-listening-session';
import {
  DEFAULT_READING_PROFILE,
  hasBookReadingProfile,
  readingProfileContrastWarning,
  resetBookReadingProfile,
  resolveReadingProfile,
  settingsWithResolvedReadingProfile,
  updateBookReadingProfile,
  updateGlobalReadingProfile,
} from './features/reader-settings/reading-profile';
import { useImportController } from './features/import/useImportController';
import { ImportFeatureHost } from './features/import/ImportFeatureHost';
import { useLibraryFolderController } from './features/library-folders/useLibraryFolderController';
import { useExternalSourceController } from './features/external-sources/useExternalSourceController';
import { useBackupController } from './features/backup/useBackupController';
import { useCloudVaultController } from './features/cloud-vault/useCloudVaultController';
import { initialCloudVaultMutationRevisions, type CloudVaultMutationKind } from './cloud-vault/sync-policy';
import { useChapterStructureController } from './features/chapter-structure/useChapterStructureController';
import { useLibraryManagementController } from './features/library/useLibraryManagementController';
import { BookEnrichmentService } from './features/book-enrichment/book-enrichment-service';
import { useBookEnrichmentController } from './features/book-enrichment/useBookEnrichmentController';
import { useBookEnrichmentAutomation } from './features/book-enrichment/useBookEnrichmentAutomation';
import {
  WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID,
  WEBNOVEL_METADATA_ENRICHMENT_PROVIDER_ID,
} from './extensions/builtin/webnovel-metadata-enrichment-extension';
import type { SyncConnectionTestState } from './features/sync/sync-panel-contract';
import {
  acceptRemoteSyncState as acceptRemoteSyncStateMutation,
  applyAiTtsRemoteSnapshotGroup as applyAiTtsRemoteSnapshotMutation,
  applyAiTtsSelectedLocalFields as applyAiTtsSelectedLocalFieldsMutation,
  discardSyncOutboxIds,
  type AiTtsSyncMutationResult,
} from './features/sync/sync-panel-mutations';
import { useSyncMergeSelections } from './features/sync/useSyncMergeSelections';
import { useServerAttachController } from './features/sync/useServerAttachController';
import { useProviderSettingsController } from './features/providers/useProviderSettingsController';
import { useBookAIWorkflowController } from './features/ai/useBookAIWorkflowController';
import { GatewayBookAITTSPreparationRunner } from './features/ai/book-ai-tts-preparation-runner';
import { useAnalysisReviewController } from './features/ai/useAnalysisReviewController';
import type { AIAddonPanelActions, AIWorkflowPanelData } from './features/ai/ai-addon-panel-contract';
import { useCharacterGraphKnowledgeController } from './features/ai/useCharacterGraphKnowledgeController';
import { speakerIdLabel, speakerLabel } from './features/ai/speaker-label';
import { graphCandidateDetailLabel } from './features/ai/graph-candidate-label';
import {
  useAnalysisExecutionController,
  type AnalysisExecutionToken,
} from './features/ai/useAnalysisExecutionController';
import {
  bookAIWorkflowCompactSpeakerView,
  bookAIWorkflowControlState,
  bookAIWorkflowProgress,
  bookAIWorkflowStageLabel,
  isTerminalBookAIWorkflow,
  progressNumber,
  recordValue,
} from './features/ai/book-ai-workflow-view';
import { useTTSExecutionController } from './features/tts/useTTSExecutionController';
import {
  buildFixedDocumentTtsQueue,
  fixedDocumentTtsParagraph,
  fixedDocumentTtsRangeQuads,
  fixedDocumentTtsSegment,
  fixedDocumentTtsSourceRange,
  selectFixedDocumentTtsSources,
} from './features/fixed-document/text/fixed-document-tts';
import { useVoiceProductController } from './features/tts/useVoiceProductController';
import {
  loadTTSWarmupChapterSource,
  selectTTSWarmupChapters,
  type TTSWarmupScope,
} from './features/tts/tts-warmup-plan';
import { hostedTTSCacheRequestKey } from './providers/hosted-tts-prefetch';
import type { HostedTTSWarmupChapterSource, HostedTTSWarmupRequest } from './providers/hosted-tts-warmup';
import {
  applyLabelCorrection,
  buildCorrectionEmotionOptions,
  buildLabelCorrectionReviewItems,
} from './providers/label-correction-review';
import { buildCharacterGraphReview } from './providers/character-graph-review';
import type { ProviderOptionConfig } from './providers/provider-jobs';
import { ttsRenderSpecHash } from './providers/tts-render-spec';
import {
  catalogProviderReady,
  providerOptionsContainSecretLikeValue,
  providerReadinessLabel,
  setProviderOptionInRecord,
} from './providers/provider-settings-ui';
import {
  desktopProviderCatalog,
  loadDesktopLocalProviderSettings,
  nativeLocalLLMProviderIds,
  providerCatalogForScope,
  providerSettingsForScope,
} from './providers/desktop-provider-catalog';
import type { CharacterGraph } from './providers/ai';
import type { BookAIWorkflowReviewItem } from './providers/book-ai-workflow-review';
import type { TTSStatus, TTSVoice } from './providers/tts';
import { voiceApprovalForProfile, type VoiceProductStateV1 } from './providers/voice-product';
import type { PlayableTtsSegment } from './providers/tts-playback';
import { BrowserAudioSession } from './providers/browser-audio-session';
import { BookPlaybackCoordinator, nextPlaybackChapter } from './providers/book-playback-coordinator';
import { BrowserMediaSessionAdapter } from './platform/media-session-adapter';
import { createPlatformDocumentIo } from './platform/document-io';
import { createPlatformLibraryFolderIo } from './platform/library-folder-io';
import { LibraryFolderLocalStateStore } from './library-folders/local-state';
import { ExternalSourceLocalStateStore } from './external-sources/local-state';
import { AppExternalSourceRegistry } from './external-sources/app-external-source-registry';
import { DropboxSourceAccountBroker } from './external-sources/dropbox-source-account-broker';
import { GoogleDriveSourceAccountBroker } from './external-sources/google-drive-source-account-broker';
import type { TrustedExternalSourceHostContext } from './external-sources/contracts';
import {
  DROPBOX_EXTERNAL_SOURCE_BROKER_ID,
  DROPBOX_EXTERNAL_SOURCE_ID,
  dropboxBuiltInExternalSource,
} from './external-sources/dropbox-external-source';
import {
  GOOGLE_DRIVE_EXTERNAL_SOURCE_BROKER_ID,
  GOOGLE_DRIVE_EXTERNAL_SOURCE_ID,
  googleDriveBuiltInExternalSource,
} from './external-sources/google-drive-external-source';
import { SuwayomiSourceAccountBroker } from './external-sources/suwayomi/suwayomi-source-account-broker';
import {
  SUWAYOMI_EXTERNAL_SOURCE_BROKER_ID,
  SUWAYOMI_EXTERNAL_SOURCE_ID,
  suwayomiBuiltInExternalSource,
} from './external-sources/suwayomi/suwayomi-external-source';
import { appPublicRuntimeConfig } from './config/public-runtime-config';
import {
  dispatchAndroidBackEscape,
  dismissTopAppBackLayer,
  handleAppBackNavigation,
  type AppBackLayer,
  useAndroidAppEvents,
} from './platform/android';
import { planTTSParagraphSentences } from './providers/tts-sentence-planner';
import { waitForPlaybackDelay } from './providers/tts-playback-delay';
import {
  clearTTSPlaybackResume,
  loadTTSPlaybackResume,
  saveTTSPlaybackResume,
  ttsQueueItemFingerprint,
  ttsPlaybackSettingsFingerprint,
  validTTSPlaybackResume,
  type TTSPlaybackResumeRecord,
} from './providers/tts-playback-resume';
import {
  hasBookTTSPlaybackOverride,
  resetBookTTSPlaybackOverride,
  resolveTTSPlaybackSettings,
  updateBookTTSPlaybackOverride,
  updateGlobalTTSPlaybackSettings,
} from './providers/tts-playback-settings';
import { TTS_NEUTRAL_SAMPLE_KO_V1, ttsVoiceSampleText } from './providers/tts-voice-samples';
import { createSampleNovel } from './data/sample';
import type { RemoteProviderJob } from './services/remote/remote-api-client';
import {
  defaultSettings,
  getStoredApiAuthToken,
  getOrCreateRemoteDeviceId,
  getStoredSyncApiBaseUrl,
  normalizeSyncApiBaseUrl,
  resolveApiAuthToken,
  saveStoredApiAuthToken,
  saveStoredSyncApiBaseUrl,
  testSyncApiConnection,
} from './repositories/reader-runtime';
import { apiAuthTokenUsesNativeSecureStore, storedApiAuthTokenConfigured } from './platform/secure-credentials';
import { RemoteMutationConflictError } from './repositories/remote-reader-repository';
import { type SyncOutboxItem, type SyncState } from './sync/types';
import {
  clearListeningPosition,
  getListeningPosition,
  saveListeningPosition,
} from './storage/listening-position-store';
import { IndexedDbDocumentTextRepository } from './storage/document-text-store';
import { IndexedDbHostedTTSOfflineCache, type HostedTTSOfflineCacheStatus } from './storage/hosted-tts-offline-cache';
import type { AiTtsSyncRemoteSnapshot } from './sync/ai-tts-sync-diff';
import { aiTtsRemoteSnapshotApplyAvailable } from './sync/ai-tts-sync-apply';
import { loadAiTtsRemoteSnapshot } from './sync/ai-tts-remote-snapshot';
import {
  REMOTE_AUTO_REFRESH_INTERVAL_MS,
  shouldRunRemoteAutoRefresh,
  type AiTtsSyncConflictGroup,
  summarizeAiTtsSyncConflicts,
  syncStatusLabel,
  syncStatusTone,
} from './sync/sync-ui';
import { verifyConnectedProviderServerBookAttached } from './sync/connected-provider-guard';
import { runConnectedProviderPreflight } from './sync/connected-provider-preflight';
import { connectedSyncFailureState, useConnectedReaderSync } from './sync/use-connected-reader-sync';
import { ToastHost, useToastController } from './shared/ui/ToastHost';
import { abortableDelay, isAbortError } from './utils/async';
import { clamp, formatBytes, formatCount } from './utils/format';
import { jsonValue } from './utils/json';

type AddonTab = ReaderAddonTab;
const DEFAULT_HOSTED_TTS_WARMUP_LIMIT = 32;
const DEFAULT_HOSTED_TTS_BULK_WARMUP_CHAPTER_LIMIT = 3;
const DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT = 3;
const SHOW_DEVELOPER_AI_TOOLS = import.meta.env.DEV;
const ReaderScreen = lazy(() => import('./features/reader/ReaderScreen'));
const FixedDocumentScreen = lazy(() => import('./features/fixed-document/FixedDocumentScreen'));
const AnnotationsPanel = lazy(() => import('./features/annotations/AnnotationsPanel'));
const ReaderSettingsPanel = lazy(() => import('./features/reader-settings/ReaderSettingsPanel'));
const TTSAddonPanel = lazy(() => import('./features/tts/TTSAddonPanel'));
const TTSCompactBar = lazy(() => import('./features/tts/TTSCompactBar'));
const AIAddonPanel = lazy(() => import('./features/ai/AIAddonPanel'));
const SyncPanel = lazy(() => import('./features/sync/SyncPanel'));
const BackupPanel = lazy(() => import('./features/backup/BackupPanel'));
const ChapterStructurePanel = lazy(() => import('./features/chapter-structure/ChapterStructurePanel'));
const LibraryFolderPanel = lazy(() => import('./features/library-folders/LibraryFolderPanel'));
const ReaderOutlinePanel = lazy(() =>
  import('./features/annotations/ReaderOutlinePanel').then((module) => ({ default: module.ReaderOutlinePanel })),
);

const BUNDLE_ANALYSIS_CHAPTER_LIMIT = 3;
interface BundleAnalysisJobSummary {
  readonly discoveredGraph?: Record<string, unknown>;
  readonly sourceContext?: Record<string, unknown>;
  readonly bundleId?: string;
  readonly sourceChapterIds: string[];
  readonly discoveredCharacterCount?: number;
  readonly discoveredRelationCount?: number;
  readonly bundleSummaryForNext?: string;
}

function optionalProgressNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function bundleAnalysisJobSummary(job?: RemoteProviderJob): BundleAnalysisJobSummary {
  const progress = recordValue(job?.progress);
  if (!progress) return { sourceChapterIds: [] };
  return {
    discoveredGraph: recordValue(progress.discoveredGraph),
    sourceContext: recordValue(progress.sourceContext),
    bundleId: typeof progress.bundleId === 'string' ? progress.bundleId : undefined,
    sourceChapterIds: stringArrayValue(progress.sourceChapterIds),
    discoveredCharacterCount: optionalProgressNumber(progress.discoveredCharacterCount),
    discoveredRelationCount: optionalProgressNumber(progress.discoveredRelationCount),
    bundleSummaryForNext: typeof progress.bundleSummaryForNext === 'string' ? progress.bundleSummaryForNext : undefined,
  };
}

function chaptersForBundleAnalysis(chapters: Chapter[], currentChapter: Chapter | undefined): Chapter[] {
  if (!currentChapter) return [];
  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  const currentIndex = sorted.findIndex((chapter) => chapter.id === currentChapter.id);
  if (currentIndex < 0) return [currentChapter];
  return sorted.slice(currentIndex, currentIndex + BUNDLE_ANALYSIS_CHAPTER_LIMIT);
}

export default function App() {
  const selfHostAuth = useOptionalSelfHostAuth();
  const {
    defaultAIProvider: aiProvider,
    defaultTTSProvider: systemTTS,
    bookAnalysisWorkflowGateway,
    extensionRuntime,
    ttsCacheGateway,
    platformRuntime,
    providerApiClient,
    providerControlClient,
    providerExecutionRuntime,
    readerRuntime,
  } = useAppRuntime();
  const extensionRevision = useSyncExternalStore(
    extensionRuntime.manager.subscribe,
    extensionRuntime.manager.getRevision,
    extensionRuntime.manager.getRevision,
  );
  const extensionSnapshots = useMemo(() => {
    void extensionRevision;
    return extensionRuntime.manager.list();
  }, [extensionRuntime.manager, extensionRevision]);
  const {
    importService,
    readerRepository,
    bookAssetRepository,
    libraryCatalogRepository,
    bookEnrichmentRepository,
    backupRepository,
    chapterStructureRepository,
    personalizationRepository,
    remoteApiClient,
    serverAttachService,
    syncApiClient,
    syncService,
  } = readerRuntime;
  const isDesktopProviderRuntime = providerExecutionRuntime === 'desktop';
  const localDeviceId = useMemo(() => getOrCreateRemoteDeviceId(), []);
  const documentIo = useMemo(() => createPlatformDocumentIo(platformRuntime), [platformRuntime]);
  const libraryFolderState = useMemo(() => new LibraryFolderLocalStateStore(), []);
  const externalSourceState = useMemo(() => new ExternalSourceLocalStateStore(), []);
  const libraryFolderIo = useMemo(
    () => createPlatformLibraryFolderIo(platformRuntime, libraryFolderState),
    [libraryFolderState, platformRuntime],
  );
  const dropboxExternalSourceAppKey =
    appPublicRuntimeConfig.dropbox.sourceAppKey ?? appPublicRuntimeConfig.dropbox.appKey;
  const dropboxCloudVaultAppKey = appPublicRuntimeConfig.dropbox.appKey ?? appPublicRuntimeConfig.dropbox.sourceAppKey;
  const dropboxExternalSourceBroker = useMemo(
    () => new DropboxSourceAccountBroker(DROPBOX_EXTERNAL_SOURCE_ID, dropboxExternalSourceAppKey, externalSourceState),
    [dropboxExternalSourceAppKey, externalSourceState],
  );
  const googleDriveExternalSourceConfig = appPublicRuntimeConfig.googleDrive;
  const googleDriveExternalSourceBroker = useMemo(
    () =>
      new GoogleDriveSourceAccountBroker(
        GOOGLE_DRIVE_EXTERNAL_SOURCE_ID,
        googleDriveExternalSourceConfig,
        externalSourceState,
      ),
    [externalSourceState, googleDriveExternalSourceConfig],
  );
  const suwayomiExternalSourceBroker = useMemo(
    () =>
      new SuwayomiSourceAccountBroker(SUWAYOMI_EXTERNAL_SOURCE_ID, externalSourceState, {
        defaultBaseUrl: appPublicRuntimeConfig.suwayomi.defaultBaseUrl,
      }),
    [externalSourceState],
  );
  const [externalSourceBrokerRevision, setExternalSourceBrokerRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      dropboxExternalSourceBroker.initialize(),
      googleDriveExternalSourceBroker.initialize(),
      suwayomiExternalSourceBroker.initialize(),
    ]).finally(() => {
      if (!cancelled) setExternalSourceBrokerRevision((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [dropboxExternalSourceBroker, googleDriveExternalSourceBroker, suwayomiExternalSourceBroker]);
  const externalSourceHostContext = useMemo<TrustedExternalSourceHostContext>(
    () => ({
      brokers: {
        get: (brokerId) => {
          if (brokerId === DROPBOX_EXTERNAL_SOURCE_BROKER_ID) return dropboxExternalSourceBroker;
          if (brokerId === GOOGLE_DRIVE_EXTERNAL_SOURCE_BROKER_ID) return googleDriveExternalSourceBroker;
          if (brokerId === SUWAYOMI_EXTERNAL_SOURCE_BROKER_ID) return suwayomiExternalSourceBroker;
          return undefined;
        },
      },
    }),
    [dropboxExternalSourceBroker, googleDriveExternalSourceBroker, suwayomiExternalSourceBroker],
  );
  const externalSourceRegistry = useMemo(
    () =>
      new AppExternalSourceRegistry(
        [dropboxBuiltInExternalSource, googleDriveBuiltInExternalSource, suwayomiBuiltInExternalSource],
        extensionRuntime.trustedExtensions,
      ),
    [extensionRuntime.trustedExtensions],
  );
  const desktopLocalLLMProviderIds = useMemo(
    () => new Set<string>(nativeLocalLLMProviderIds(platformRuntime.kind)),
    [platformRuntime.kind],
  );
  const [segments, setSegmentsState] = useState<LabeledSegment[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [voices, setVoices] = useState<TTSVoice[]>([]);
  const [ttsStatus, setTTSStatus] = useState<TTSStatus>();
  const [graphReviewExcludedCharacterIds, setGraphReviewExcludedCharacterIds] = useState<Set<string>>(() => new Set());
  const [addonOpen, setAddonOpen] = useState(false);
  const [addonTab, setAddonTab] = useState<AddonTab>('outline');
  const [spokenPreviewRequest, setSpokenPreviewRequest] = useState<{ id: number; text: string }>();
  const { toasts: toastList, showToast, dismissToast } = useToastController();
  const readerAddonTabs = useMemo<readonly ReaderAddonTabDescriptor[]>(() => {
    void extensionRevision;
    return [
      ...CORE_READER_ADDON_TABS,
      ...extensionRuntime.trustedExtensions.getReaderAddonTabs().map(({ descriptor }) => descriptor),
    ].sort((left, right) => (left.order ?? 500) - (right.order ?? 500) || left.id.localeCompare(right.id));
  }, [extensionRuntime, extensionRevision]);
  useEffect(() => {
    if (addonOpen && !readerAddonTabs.some((tab) => tab.id === addonTab)) setAddonTab('outline');
  }, [addonOpen, addonTab, readerAddonTabs]);
  const readerScreenHandle = useMemo(() => new ReaderScreenHandle(), []);
  const bookWorkspaceTransitionRef = useRef<BookWorkspaceTransitionPort>({
    flushReaderSession: async () => undefined,
    resetAnalysis: () => undefined,
    stopChapterTTS: () => undefined,
    stopReaderTTS: () => undefined,
    activateChapter: () => undefined,
    prepareReaderOpen: () => ({ sequence: 0 }),
  });
  const bookWorkspaceAdjacentRef = useRef<BookWorkspaceAdjacentFeaturePort>({
    loadBookAnnotations: async () => ({ bookmarks: [], highlights: [], notes: [] }),
    applyBookAnnotations: () => undefined,
    loadReaderArtifacts: async () => ({ segments: [], characters: [], voiceProfiles: [] }),
    applyReaderArtifacts: () => undefined,
    resetCorrection: () => undefined,
    resetAnnotationEditor: () => undefined,
    refreshNovels: async () => undefined,
    refreshAfterLocalMutation: async () => undefined,
    refreshSyncState: async () => undefined,
    refreshAfterLocationConflict: () => undefined,
  });
  const { controller: bookWorkspace, state: bookWorkspaceState } = useBookWorkspaceController(
    createBookWorkspacePortProxy({
      repository: readerRepository,
      catalog: libraryCatalogRepository,
      transition: bookWorkspaceTransitionRef,
      adjacent: bookWorkspaceAdjacentRef,
      environment: {
        confirm: (message) => window.confirm(message),
        notify: showToast,
        isMutationConflict: (error) => error instanceof RemoteMutationConflictError,
      },
    }),
  );
  const {
    chapters,
    currentChapter,
    localReadingPosition,
    novels,
    outlineQuery,
    readerMode,
    readerOpenRequestVersion,
    readerProgress,
    readerSessionDisplaySeconds: readerSessionSeconds,
    remoteReadingPosition,
    selectedNovel,
    view,
  } = bookWorkspaceState;
  const { replaceSelection, setNovels, setRemoteReadingPosition, setSelectedNovel } = bookWorkspace;
  const graphKnowledgeController = useCharacterGraphKnowledgeController({
    repository: readerRepository,
    novelId: selectedNovel?.id,
    characters,
    onApplied: async () => {
      if (!selectedNovel) return;
      const [nextCharacters, nextVoices, nextSegments] = await Promise.all([
        readerRepository.listCharacters(selectedNovel.id),
        readerRepository.listVoiceProfiles(selectedNovel.id),
        currentChapter ? readerRepository.listSegments(currentChapter.id) : Promise.resolve([]),
      ]);
      setCharacters(nextCharacters);
      setVoiceProfiles(nextVoices);
      if (currentChapter) setSegmentsState(nextSegments);
    },
  });
  const analysisExecutionController = useAnalysisExecutionController({
    client: providerApiClient,
    bookId: selectedNovel?.id,
    chapterId: currentChapter?.id,
  });
  const remoteAnalysisJob = analysisExecutionController.job;
  const lastBundleAnalysisJob = analysisExecutionController.lastBundleJob;
  const remoteAnalysisRunning = analysisExecutionController.running;
  const [syncState, setSyncState] = useState<SyncState>();
  const [bootstrapState, setBootstrapState] = useState<{
    status: 'loading' | 'ready' | 'failed';
    message?: string;
  }>({ status: 'loading' });
  const [syncOutbox, setSyncOutbox] = useState<SyncOutboxItem[]>([]);
  const [cloudVaultMutationRevisions, setCloudVaultMutationRevisions] = useState(initialCloudVaultMutationRevisions);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [syncFlushing, setSyncFlushing] = useState(false);
  const [syncApiBaseUrlDraft, setSyncApiBaseUrlDraft] = useState(
    () => getStoredSyncApiBaseUrl() || readerRuntime.apiBaseUrl || '',
  );
  const [syncConnectionTest, setSyncConnectionTest] = useState<SyncConnectionTestState>({ status: 'idle' });
  const [apiAuthTokenDraft, setApiAuthTokenDraft] = useState(() => getStoredApiAuthToken());
  const [apiAuthTokenConfigured, setApiAuthTokenConfigured] = useState(() => storedApiAuthTokenConfigured());
  const syncMergeSelections = useSyncMergeSelections();
  const [correctionTarget, setCorrectionTarget] = useState<LabeledSegment>();
  const [correctionSpeakerDraft, setCorrectionSpeakerDraft] = useState('unknown');
  const [correctionEmotionDraft, setCorrectionEmotionDraft] = useState('neutral');
  const [correctionScope, setCorrectionScope] = useState<UserCorrection['applyScope']>('segment');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance');

  const voiceProfilesRef = useRef<VoiceProfile[]>([]);
  const voiceProfileSaveQueueRef = useRef(Promise.resolve());
  const voiceProfileSaveVersionRef = useRef(0);
  const serverAttachCompletionRef = useRef<(novel: Novel) => Promise<SyncState | undefined>>(async () => undefined);
  const activeChapterIdRef = useRef<string>();
  const activeNovelIdRef = useRef<string>();
  const remoteAutoRefreshBusyRef = useRef(false);
  const remoteAutoRefreshGenerationRef = useRef(0);
  const providerSettingsAutoLoadKeyRef = useRef<string>();
  const readerMutationCommittedRef = useRef<(kind?: CloudVaultMutationKind) => Promise<unknown>>(async () => undefined);
  const readerPersistenceErrorRef = useRef<(error: unknown) => Promise<boolean>>(async () => false);
  const readerSettingsController = useReaderSettingsDraft({
    repository: readerRepository,
    initialSettings: defaultSettings,
    onSaved: () => readerMutationCommittedRef.current('settings'),
    onSaveError: async (error) => {
      if (!(await readerPersistenceErrorRef.current(error))) {
        showToast('읽기 설정을 저장하지 못했습니다.', 'danger');
      }
    },
    notify: showToast,
  });
  const annotationsController = useAnnotationsController({
    repository: readerRepository,
    reader: readerScreenHandle,
    novel: selectedNovel,
    chapter: currentChapter,
    chapters,
    activeParagraphId:
      localReadingPosition && currentChapter && localReadingPosition.chapterId === currentChapter.id
        ? localReadingPosition.paragraphId
        : undefined,
    readerProgress,
    openChapter: (chapter, position) =>
      bookWorkspace.openChapter(chapter, { restore: true, novel: selectedNovel, position }),
    onMutationCommitted: () => readerMutationCommittedRef.current('annotations'),
    onPersistenceError: (error) => readerPersistenceErrorRef.current(error),
    notify: showToast,
  });
  const {
    settings,
    setPersistedSettings: setReaderSettings,
    updateSettings,
    open: settingsOpen,
  } = readerSettingsController;
  const openReaderSettings = useCallback(() => {
    setSettingsInitialTab('appearance');
    readerSettingsController.openPanel();
  }, [readerSettingsController]);
  const openExternalSourceSettings = useCallback(() => {
    setSettingsInitialTab('sources');
    readerSettingsController.openPanel();
  }, [readerSettingsController]);
  const trustedAnalysisWorkflows = extensionRuntime.trustedExtensions.getAnalysisWorkflows();
  const baseBookAITTSPreparationRunner = useMemo(
    () =>
      bookAnalysisWorkflowGateway ? new GatewayBookAITTSPreparationRunner(bookAnalysisWorkflowGateway) : undefined,
    [bookAnalysisWorkflowGateway],
  );
  const managedBookWorkflow = resolveTrustedBookAITTSWorkflow({
    workflows: trustedAnalysisWorkflows,
    runnerWorkflowIds: baseBookAITTSPreparationRunner ? extensionRuntime.bookAITTSRunners.listWorkflowIds() : [],
    bookId: selectedNovel?.id,
    preferences: settings.aiWorkflows,
  });
  const bookAITTSPreparationRunner = useMemo(
    () =>
      baseBookAITTSPreparationRunner && managedBookWorkflow.active
        ? extensionRuntime.bookAITTSRunners.resolve(
            managedBookWorkflow.active.descriptor.id,
            baseBookAITTSPreparationRunner,
          )
        : undefined,
    [baseBookAITTSPreparationRunner, extensionRuntime, managedBookWorkflow.active],
  );
  const readingProfile = useMemo(
    () => resolveReadingProfile(settings, selectedNovel?.id),
    [selectedNovel?.id, settings],
  );
  const effectiveReaderSettings = useMemo(
    () => settingsWithResolvedReadingProfile(settings, selectedNovel?.id),
    [selectedNovel?.id, settings],
  );
  const readingBookOverrideEnabled = hasBookReadingProfile(settings, selectedNovel?.id);
  const activeReaderFont = useActiveReaderFont(personalizationRepository, readingProfile.fontId);
  useEffect(() => {
    if (activeReaderFont.failed) showToast('사용자 글꼴을 불러오지 못해 기본 글꼴로 표시합니다.', 'warning');
  }, [activeReaderFont.failed, showToast]);
  const changeReadingProfile = (patch: Parameters<typeof updateGlobalReadingProfile>[1]) => {
    updateSettings((previous) =>
      selectedNovel && hasBookReadingProfile(previous, selectedNovel.id)
        ? updateBookReadingProfile(previous, selectedNovel.id, patch)
        : updateGlobalReadingProfile(previous, patch),
    );
  };
  const setReadingBookOverrideEnabled = (enabled: boolean) => {
    if (!selectedNovel) return;
    updateSettings((previous) =>
      enabled
        ? updateBookReadingProfile(previous, selectedNovel.id, {})
        : resetBookReadingProfile(previous, selectedNovel.id),
    );
  };
  const ttsPlaybackSettings = useMemo(
    () => resolveTTSPlaybackSettings(settings, selectedNovel?.id),
    [selectedNovel?.id, settings],
  );
  const ttsAudioSession = useMemo(() => new BrowserAudioSession(), []);
  const fixedDocumentTextRepository = useMemo(() => new IndexedDbDocumentTextRepository(), []);
  const hostedTTSOfflineCache = useMemo(() => new IndexedDbHostedTTSOfflineCache(), []);
  const ttsControllerChapterId =
    view === 'document' && selectedNovel ? `fixed_document_${selectedNovel.id}` : currentChapter?.id;
  const ttsExecutionController = useTTSExecutionController({
    systemTTS,
    audioSession: ttsAudioSession,
    providerClient: providerApiClient,
    bookId: selectedNovel?.id,
    chapterId: ttsControllerChapterId,
    volume: ttsPlaybackSettings.volume,
    sleepTimerPreset: ttsPlaybackSettings.sleepTimerDefault,
    preserveSystemPlaybackOnUnmount: platformRuntime.kind === 'tauri-mobile',
  });
  const syncExternalTTSPlayback = ttsExecutionController.syncExternalPlayback;
  const ttsIndex = ttsExecutionController.index;
  const ttsPlaying = ttsExecutionController.playing;
  const ttsPaused = ttsExecutionController.paused;
  const activeTTSPlayback = ttsExecutionController.activePlayback;
  useListeningSession({
    repository: personalizationRepository,
    bookId: selectedNovel?.id,
    active: ttsExecutionController.itemActive && !ttsPaused,
  });
  const hostedTTSJob = ttsExecutionController.hostedJob;
  const hostedTTSBusy = ttsExecutionController.hostedBusy;
  const hostedTTSStatus = ttsExecutionController.hostedStatus;
  const bookPlaybackCoordinator = useMemo(() => new BookPlaybackCoordinator(), []);
  const mediaSession = useMemo(() => new BrowserMediaSessionAdapter(), []);
  const [ttsResumeRecord, setTTSResumeRecord] = useState<TTSPlaybackResumeRecord>();
  const [ttsListeningPosition, setTTSListeningPosition] = useState<ListeningPosition>();
  const restoredNativeUtteranceRef = useRef<string>();
  const [offlineTTSDownloadJob, setOfflineTTSDownloadJob] = useState<TTSDownloadJob>();
  const [offlineTTSDownloadError, setOfflineTTSDownloadError] = useState<string>();
  const [hostedOfflineCacheStatus, setHostedOfflineCacheStatus] = useState<HostedTTSOfflineCacheStatus>();
  const [offlineTTSRecoveryPolicy, setOfflineTTSRecoveryPolicy] = useState<
    Pick<TTSDownloadPolicy, 'network' | 'charging'>
  >(() => ({
    network: platformRuntime.kind === 'tauri-mobile' ? 'unmetered' : 'any',
    charging: 'any',
  }));
  const offlineTTSRecoveryRef = useRef<Promise<number>>();
  const hostedTtsPrefetchMetricsRef = useRef({
    targetKey: '',
    averageResolveLatencyMs: 0,
    consecutiveFailures: 0,
  });
  const refreshOfflineTTSDownloadJob = useCallback(async () => {
    if (!selectedNovel) {
      setOfflineTTSDownloadJob(undefined);
      setOfflineTTSDownloadError(undefined);
      setHostedOfflineCacheStatus(undefined);
      return;
    }
    const { IndexedDbTTSDownloadRepository } = await import('./storage/tts-download-store');
    const repository = new IndexedDbTTSDownloadRepository();
    const recovery =
      offlineTTSRecoveryRef.current ??
      (async () => {
        const renderSpecHashes = await repository.interruptedRenderSpecHashes();
        const [nativeEvidence, browserEvidence] = await Promise.all([
          renderSpecHashes.length > 0 && ttsCacheGateway?.evidence
            ? ttsCacheGateway.evidence(renderSpecHashes).catch(() => [])
            : [],
          renderSpecHashes.length > 0
            ? hostedTTSOfflineCache.evidence(selectedNovel.id, renderSpecHashes).catch(() => [])
            : [],
        ]);
        return repository.recoverInterrupted([...nativeEvidence, ...browserEvidence]);
      })();
    offlineTTSRecoveryRef.current = recovery;
    try {
      await recovery;
    } catch (error) {
      if (offlineTTSRecoveryRef.current === recovery) offlineTTSRecoveryRef.current = undefined;
      throw error;
    }
    const activeContentRevisionId = selectedNovel.activeContentRevisionId;
    const latest = activeContentRevisionId
      ? await repository.latestForBookRevision(selectedNovel.id, activeContentRevisionId)
      : undefined;
    setOfflineTTSDownloadJob(latest);
    const [items, cacheStatus] = await Promise.all([
      latest ? repository.listItems(latest.id).catch(() => []) : [],
      hostedTTSOfflineCache.status(selectedNovel.id, activeContentRevisionId).catch(() => undefined),
    ]);
    setOfflineTTSDownloadError(
      items
        .filter((item) => item.state === 'failed' || item.state === 'retry_wait')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.errorMessage,
    );
    setHostedOfflineCacheStatus(cacheStatus);
    if (platformRuntime.kind === 'tauri-mobile' && latest) {
      setOfflineTTSRecoveryPolicy({ network: latest.policy.network, charging: latest.policy.charging });
    }
  }, [hostedTTSOfflineCache, platformRuntime.kind, selectedNovel, ttsCacheGateway]);
  useEffect(() => {
    let active = true;
    void refreshOfflineTTSDownloadJob().catch(() => {
      if (active) setOfflineTTSDownloadJob(undefined);
    });
    return () => {
      active = false;
    };
  }, [refreshOfflineTTSDownloadJob]);
  const requestHostedOfflineStorage = async () => {
    const persisted = await hostedTTSOfflineCache.requestPersistence().catch(() => false);
    showToast(
      persisted
        ? '오프라인 음성 저장소가 브라우저 자동 정리에서 보호됩니다.'
        : persisted === undefined
          ? '이 브라우저는 영구 저장소 요청을 지원하지 않습니다.'
          : '브라우저가 저장소 보호 요청을 허용하지 않았습니다.',
      persisted ? 'success' : 'warning',
    );
    await refreshOfflineTTSDownloadJob().catch(() => undefined);
  };
  const removeStaleHostedOfflineAudio = async () => {
    if (!selectedNovel?.activeContentRevisionId) return;
    const result = await hostedTTSOfflineCache.removeStaleForBook(
      selectedNovel.id,
      selectedNovel.activeContentRevisionId,
    );
    showToast(
      result.removedItems > 0
        ? `이전 본문 음성 ${result.removedItems}개 · ${formatBytes(result.removedBytes)}를 정리했습니다.`
        : result.protectedItems > 0
          ? '수동 보관 중인 이전 음성만 남아 있어 자동으로 정리하지 않았습니다.'
          : '정리할 이전 본문 음성이 없습니다.',
      result.removedItems > 0 ? 'success' : 'info',
    );
    await refreshOfflineTTSDownloadJob().catch(() => undefined);
  };
  const voiceProfileStateRevision = useMemo(() => voiceProfilesRevision(voiceProfiles), [voiceProfiles]);
  const ttsResumeFingerprint = useMemo(
    () =>
      ttsPlaybackSettingsFingerprint({
        settings: ttsPlaybackSettings,
        voiceRevision: voiceProfileStateRevision,
      }),
    [ttsPlaybackSettings, voiceProfileStateRevision],
  );
  useEffect(() => {
    if (platformRuntime.kind !== 'tauri-mobile') return;
    let cancelled = false;
    const applyNativePlayback = (playback: TTSStatus['playback']) => {
      if (cancelled) return;
      setTTSStatus((current) => (current ? { ...current, playback } : current));
      syncExternalTTSPlayback(playback);
    };
    const refreshNativePlayback = async () => {
      try {
        const status = await systemTTS.getStatus();
        if (cancelled) return;
        setTTSStatus(status);
        syncExternalTTSPlayback(status.playback);
      } catch {
        // Bootstrap and the provider fallback own user-facing availability errors.
      }
    };
    const unsubscribe = systemTTS.subscribePlaybackState?.(applyNativePlayback);
    void refreshNativePlayback();
    const interval = window.setInterval(() => void refreshNativePlayback(), 5_000);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.clearInterval(interval);
    };
  }, [platformRuntime.kind, syncExternalTTSPlayback, systemTTS]);

  useEffect(() => {
    const playback = ttsStatus?.playback;
    const anchor = playback?.anchor;
    const utteranceId = playback?.utteranceId;
    if (
      !playback?.active ||
      !anchor ||
      !utteranceId ||
      restoredNativeUtteranceRef.current === utteranceId ||
      !selectedNovel?.activeContentRevisionId ||
      anchor.bookId !== selectedNovel.id
    )
      return;
    let cancelled = false;
    const restoreExactListeningAnchor = async () => {
      const common = {
        bookId: selectedNovel.id,
        chapterId: anchor.chapterId,
        contentRevisionId: selectedNovel.activeContentRevisionId!,
        queueItemFingerprint: anchor.queueItemFingerprint ?? `android:${utteranceId}`,
        settingsFingerprint: ttsResumeFingerprint,
      };
      const position =
        anchor.kind === 'reflowable_text'
          ? await saveListeningPosition({
              ...common,
              anchor: {
                kind: 'reflowable_text',
                paragraphId: anchor.blockId,
                startOffset: anchor.startOffset,
                endOffset: anchor.endOffset,
                reader: {
                  bookId: selectedNovel.id,
                  contentRevisionId: selectedNovel.activeContentRevisionId!,
                  sectionId: anchor.chapterId,
                  blockId: anchor.blockId,
                  blockIndex: anchor.blockIndex,
                  offset: anchor.startOffset,
                },
              },
            })
          : await (async () => {
              const block = (await fixedDocumentTextRepository.getBlocks(anchor.textRevisionId)).find(
                (candidate) => candidate.id === anchor.blockId,
              );
              if (!block) return undefined;
              return saveListeningPosition({
                ...common,
                anchor: {
                  kind: 'fixed_text',
                  bookId: selectedNovel.id,
                  pageIndex: anchor.pageIndex,
                  textRevisionId: anchor.textRevisionId,
                  blockId: anchor.blockId,
                  startOffset: anchor.startOffset,
                  endOffset: anchor.endOffset,
                  quads: fixedDocumentTtsRangeQuads(block, anchor.startOffset, anchor.endOffset),
                },
              });
            })();
      if (cancelled || !position) return;
      restoredNativeUtteranceRef.current = utteranceId;
      setTTSListeningPosition(position);
      await readerMutationCommittedRef.current('progress');
    };
    void restoreExactListeningAnchor().catch(() => {
      // Media playback remains controllable if a best-effort cursor write fails.
    });
    return () => {
      cancelled = true;
    };
  }, [fixedDocumentTextRepository, selectedNovel, ttsResumeFingerprint, ttsStatus?.playback]);
  useEffect(() => {
    const bookId = selectedNovel?.id;
    const contentRevisionId = selectedNovel?.activeContentRevisionId;
    if (!bookId) {
      setTTSResumeRecord(undefined);
      setTTSListeningPosition(undefined);
      return;
    }
    let cancelled = false;
    void readerRepository
      .listVoiceProfiles(bookId)
      .then(async (storedProfiles) => {
        if (cancelled) return;
        const settingsFingerprint = ttsPlaybackSettingsFingerprint({
          settings: ttsPlaybackSettings,
          voiceRevision: voiceProfilesRevision(storedProfiles),
        });
        const durable = await getListeningPosition(bookId);
        if (cancelled) return;
        if (durable && durable.contentRevisionId === contentRevisionId && durable.anchor.kind === 'reflowable_text') {
          setTTSListeningPosition(durable);
          setTTSResumeRecord({
            schemaVersion: 1,
            bookId,
            chapterId: durable.chapterId,
            paragraphIndex: durable.anchor.reader.blockIndex ?? 0,
            contentRevisionId,
            settingsFingerprint,
            updatedAt: durable.updatedAt,
          });
          return;
        }
        const loaded = loadTTSPlaybackResume(bookId);
        if (validTTSPlaybackResume(loaded, { contentRevisionId, settingsFingerprint })) {
          let paragraph: Paragraph | undefined;
          const signal = new AbortController().signal;
          for await (const page of readerRepository.iterateParagraphPages({ chapterId: loaded.chapterId, signal })) {
            paragraph = page.paragraphs.find((item) => item.index === loaded.paragraphIndex);
            if (paragraph) break;
          }
          if (cancelled) return;
          if (paragraph && contentRevisionId) {
            const migrated = await saveListeningPosition({
              bookId,
              chapterId: loaded.chapterId,
              contentRevisionId,
              queueItemFingerprint: `legacy:${paragraph.id}:0`,
              settingsFingerprint,
              updatedAt: loaded.updatedAt,
              anchor: {
                kind: 'reflowable_text',
                paragraphId: paragraph.id,
                startOffset: 0,
                endOffset: 0,
                reader: {
                  bookId,
                  contentRevisionId,
                  sectionId: loaded.chapterId,
                  blockId: paragraph.id,
                  blockIndex: loaded.paragraphIndex,
                  offset: 0,
                },
              },
            });
            if (cancelled) return;
            setTTSListeningPosition(migrated);
            await readerMutationCommittedRef.current('progress');
            clearTTSPlaybackResume(bookId);
          }
          setTTSResumeRecord(loaded);
          return;
        }
        if (loaded) clearTTSPlaybackResume(bookId);
        if (durable && durable.contentRevisionId !== contentRevisionId) {
          await clearListeningPosition(bookId);
          await readerMutationCommittedRef.current('progress');
        }
        setTTSListeningPosition(undefined);
        setTTSResumeRecord(undefined);
      })
      .catch(() => {
        if (!cancelled) setTTSResumeRecord(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [
    readerRepository,
    selectedNovel?.activeContentRevisionId,
    selectedNovel?.id,
    ttsPlaybackSettings,
    voiceProfileStateRevision,
  ]);
  const providerSettings = useProviderSettingsController({
    apiClient: providerApiClient,
    controlClient: providerControlClient,
    desktopMode: isDesktopProviderRuntime,
    platformKind: platformRuntime.kind,
    analysisRunning: remoteAnalysisRunning,
    ttsPlaybackBusy: ttsPlaying || hostedTTSBusy,
    notify: showToast,
  });
  const providerSettingsBundle = providerSettings.bundle;
  const providerCatalog = providerSettings.catalog;
  const providerSettingsDrafts = providerSettings.drafts;
  const providerSecretStatuses = providerSettings.secretStatuses;
  const hostedTTSVoicesByProvider = providerSettings.voicesByProvider;
  const hostedTTSVoicesLoadingProvider = providerSettings.voicesLoadingProvider;
  const refreshHostedTTSVoices = providerSettings.refreshVoices;
  const stopProviderSamples = providerSettings.stopSamples;
  const providerSettingsPanelController = providerSettings.panelController;
  const providerSettingsLoading = providerSettingsPanelController.loading;
  const refreshProviderSettings = providerSettings.refresh;
  const {
    bookmarks,
    highlights,
    notes,
    setBookmarks,
    setHighlights,
    setNotes,
    view: annotationView,
    toggleBookmark,
    setHighlight: addHighlight,
  } = annotationsController;
  const chapterAnnotationCounts = annotationView.chapterCounts;
  const bookWorkspaceProjection = useBookWorkspaceProjection(bookWorkspaceState, chapterAnnotationCounts);
  const connectedSyncSelection = useMemo(
    () => ({
      view,
      bookId: selectedNovel?.id,
      chapterId: currentChapter?.id,
      chapterProgress: readerProgress,
      book: selectedNovel,
      chapter: currentChapter,
    }),
    [currentChapter, readerProgress, selectedNovel, view],
  );

  const readerThemeColors = resolveReaderThemeColors(readingProfile);

  const styleVars = {
    '--reading-font-size': `${readingProfile.fontSize}px`,
    '--reading-font-weight': String(readingProfile.fontWeight),
    '--reading-line-height': String(readingProfile.lineHeight),
    '--reading-letter-spacing': `${readingProfile.letterSpacing}em`,
    '--reading-paragraph-spacing': `${readingProfile.paragraphSpacing}em`,
    '--reading-first-line-indent': `${readingProfile.firstLineIndent}em`,
    '--reading-text-align': readingProfile.textAlign,
    '--reading-margin-x': `${readingProfile.marginX}vw`,
    '--reading-margin-y': `${readingProfile.marginY}vh`,
    '--reading-width': `${readingProfile.contentWidth}px`,
    '--reading-foreground': readerThemeColors.foreground,
    '--reading-background': readerThemeColors.background,
    '--reading-brightness': String(readingProfile.brightness),
    '--reading-font-family': activeReaderFont.family,
  } as CSSProperties;

  const completeServerAttach = useCallback((novel: Novel) => serverAttachCompletionRef.current(novel), []);
  const serverAttach = useServerAttachController({
    service: serverAttachService,
    novel: selectedNovel,
    onAttached: completeServerAttach,
    notify: showToast,
  });
  const serverAttachProgress = serverAttach.progress;
  const serverAttachPercent = serverAttach.percent;
  const serverAttachBusy = serverAttach.busy;

  useEffect(() => {
    voiceProfilesRef.current = voiceProfiles;
  }, [voiceProfiles]);

  const revealChrome = useCallback(() => readerScreenHandle.revealChrome(), [readerScreenHandle]);
  const setReaderMode = useCallback((mode: ReaderMode) => readerScreenHandle.setMode(mode), [readerScreenHandle]);
  const cachedParagraphById = useCallback(
    (paragraphId: string) => readerScreenHandle.getCachedParagraphById(paragraphId),
    [readerScreenHandle],
  );
  const getParagraphAtIndex = useCallback(
    (index: number) => readerScreenHandle.getParagraphAtIndex(index),
    [readerScreenHandle],
  );
  const scrollToParagraph = useCallback(
    (paragraphId: string) => readerScreenHandle.scrollToParagraph(paragraphId),
    [readerScreenHandle],
  );

  const resetParagraphCache = useCallback(() => readerScreenHandle.resetContent(), [readerScreenHandle]);

  const {
    connectedSyncController,
    flushSyncState,
    refreshAfterLocalMutation: refreshConnectedAfterLocalMutation,
    refreshNovels,
    refreshRemoteServerState,
    refreshSyncState,
  } = useConnectedReaderSync({
    runtime: readerRuntime,
    selection: connectedSyncSelection,
    serverAttachBusy,
    resetParagraphCache,
    bindings: {
      setReaderSettings,
      setNovels,
      replaceSelection,
      setBookmarks,
      setHighlights,
      setNotes,
      setSegments: setSegmentsState,
      setCharacters,
      setVoiceProfiles,
      setSyncState,
      setSyncOutbox,
      setSyncFlushing,
      setActiveChapterId: (id) => {
        activeChapterIdRef.current = id;
      },
    },
  });
  const refreshAfterLocalMutation = useCallback(
    async (kind: CloudVaultMutationKind = 'library') => {
      const result = await refreshConnectedAfterLocalMutation(kind);
      setCloudVaultMutationRevisions((current) => ({ ...current, [kind]: current[kind] + 1 }));
      return result;
    },
    [refreshConnectedAfterLocalMutation],
  );
  const bookEnrichmentService = useMemo(
    () =>
      libraryCatalogRepository && bookAssetRepository
        ? new BookEnrichmentService({
            registry: extensionRuntime.trustedExtensions,
            repository: bookEnrichmentRepository,
            books: readerRepository,
            catalog: libraryCatalogRepository,
            assets: bookAssetRepository,
          })
        : undefined,
    [bookAssetRepository, bookEnrichmentRepository, extensionRuntime, libraryCatalogRepository, readerRepository],
  );
  const bookEnrichment = useBookEnrichmentController({
    service: bookEnrichmentService,
    refreshNovels,
    refreshAfterMutation: refreshAfterLocalMutation,
    notify: showToast,
  });
  const webNovelMetadataCollector = extensionRuntime.webNovelMetadataCollector;
  const webNovelMetadataCollectorSnapshot = useSyncExternalStore(
    webNovelMetadataCollector.subscribe,
    webNovelMetadataCollector.getSnapshot,
    webNovelMetadataCollector.getSnapshot,
  );
  const webNovelMetadataExtensionEnabled =
    extensionSnapshots.find((extension) => extension.id === WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID)?.enabled ===
    true;
  useEffect(() => {
    if (!webNovelMetadataExtensionEnabled) {
      webNovelMetadataCollector.disconnect();
      void webNovelMetadataCollector.stopManagedRuntime();
    }
  }, [webNovelMetadataCollector, webNovelMetadataExtensionEnabled]);
  useEffect(() => {
    if (webNovelMetadataExtensionEnabled && webNovelMetadataCollectorSnapshot.connectionState === 'disconnected') {
      void webNovelMetadataCollector.connect();
    }
  }, [webNovelMetadataCollector, webNovelMetadataCollectorSnapshot.connectionState, webNovelMetadataExtensionEnabled]);
  const bookEnrichmentAutomation = useBookEnrichmentAutomation({
    ready: bootstrapState.status === 'ready',
    enabled: webNovelMetadataExtensionEnabled,
    books: novels,
    runner: bookEnrichmentService,
    providerId: WEBNOVEL_METADATA_ENRICHMENT_PROVIDER_ID,
    automaticLookup: webNovelMetadataCollectorSnapshot.settings.automaticLookup,
    automaticApply: webNovelMetadataCollectorSnapshot.settings.automaticApply,
    refreshLibrary: async () => {
      await Promise.all([refreshNovels(), refreshAfterLocalMutation()]);
    },
    notify: showToast,
  });
  const libraryManagement = useLibraryManagementController({
    catalog: libraryCatalogRepository,
    assets: bookAssetRepository,
    getNovel: (bookId) => readerRepository.getNovel(bookId),
    refreshNovels,
    refreshAfterMutation: refreshAfterLocalMutation,
    notify: showToast,
    confirm: (message) => window.confirm(message),
  });
  serverAttachCompletionRef.current = async (attachedNovel) => {
    const state = syncService ? await flushSyncState() : await refreshSyncState();
    if (!state) return undefined;
    await refreshNovels();
    if (activeNovelIdRef.current !== attachedNovel.id) return state;

    const freshNovel = await readerRepository.getNovel(attachedNovel.id);
    if (!freshNovel) return state;
    const expectedChapterId = activeChapterIdRef.current;
    const [freshChapters, freshBookmarks, freshHighlights, freshNotes] = await Promise.all([
      readerRepository.listChapters(freshNovel.id),
      readerRepository.listBookmarks(freshNovel.id),
      readerRepository.listHighlights(freshNovel.id),
      readerRepository.listNotes(freshNovel.id),
    ]);
    if (activeNovelIdRef.current !== attachedNovel.id) return state;
    const shouldRefreshCurrentChapter = Boolean(expectedChapterId && activeChapterIdRef.current === expectedChapterId);
    let freshCurrentChapter: Chapter | undefined;
    if (shouldRefreshCurrentChapter && expectedChapterId) {
      freshCurrentChapter = (await readerRepository.getChapter(expectedChapterId)) ?? freshChapters[0];
      if (activeNovelIdRef.current !== attachedNovel.id) return state;
    }
    const currentChapterStillExpected = Boolean(
      shouldRefreshCurrentChapter && expectedChapterId && activeChapterIdRef.current === expectedChapterId,
    );
    replaceSelection({
      selectedNovel: freshNovel,
      chapters: freshChapters,
      ...(currentChapterStillExpected ? { currentChapter: freshCurrentChapter } : undefined),
    });
    setBookmarks(freshBookmarks);
    setHighlights(freshHighlights);
    setNotes(freshNotes);
    if (currentChapterStillExpected) resetParagraphCache();
    return state;
  };
  readerMutationCommittedRef.current = refreshAfterLocalMutation;
  readerPersistenceErrorRef.current = async (error) => {
    if (!(error instanceof RemoteMutationConflictError)) return false;
    showToast('서버에 더 최신 변경이 있어 저장하지 못했습니다. 서버 상태를 새로고침합니다.', 'warning');
    if (readerRuntime.mode === 'remote') void refreshRemoteServerState({ silent: true });
    else void refreshSyncState();
    return true;
  };

  const backupFeature = useBackupController({
    repository: backupRepository,
    documentIo,
    refreshLibrary: async () => {
      await refreshNovels();
    },
    notify: showToast,
  });
  const cloudVault = useCloudVaultController({
    repository: readerRepository,
    assets: bookAssetRepository,
    importService,
    catalog: libraryCatalogRepository,
    personalization: personalizationRepository,
    deviceId: localDeviceId,
    serverSyncConnected: Boolean(syncService),
    refreshLibrary: async () => {
      await Promise.all([refreshNovels(), libraryManagement.refresh()]);
    },
    notify: showToast,
    confirm: (message) => window.confirm(message),
    dropboxAppKey: dropboxCloudVaultAppKey,
    localMutationRevisions: cloudVaultMutationRevisions,
  });

  const chapterStructureFeature = useChapterStructureController({
    repository: chapterStructureRepository,
    onApplied: async (bookId) => {
      await refreshNovels();
      await refreshAfterLocalMutation();
      const fresh = await readerRepository.getNovel(bookId);
      if (fresh) await bookWorkspace.openNovel(fresh);
    },
    notify: showToast,
  });

  const openImportedSeriesRef = useRef<(novel: Novel) => Promise<void>>();
  const importFeature = useImportController({
    importService,
    documentIo,
    assets: bookAssetRepository,
    getNovel: (id) => readerRepository.getNovel(id),
    listNovels: () => readerRepository.listNovels(),
    listChapters: (novelId) => readerRepository.listChapters(novelId),
    onImportCommitted: async (novel) => {
      await refreshNovels();
      await refreshAfterLocalMutation();
      if (novel) {
        const fresh = (await readerRepository.getNovel(novel.id)) ?? novel;
        if (fresh.format === 'image_archive' && (fresh.documentSectionCount ?? 0) > 0) {
          await openImportedSeriesRef.current?.(fresh);
        } else {
          await bookWorkspace.openNovel(fresh);
        }
      }
    },
    notify: showToast,
  });
  const libraryFolderFeature = useLibraryFolderController({
    io: libraryFolderIo,
    state: libraryFolderState,
    importService,
    getNovel: (id) => readerRepository.getNovel(id),
    listNovels: () => readerRepository.listNovels(),
    onLibraryChanged: async () => {
      await refreshNovels();
      await refreshAfterLocalMutation();
    },
    notify: showToast,
  });
  const externalSourceFeature = useExternalSourceController({
    registry: externalSourceRegistry,
    hostContext: externalSourceHostContext,
    state: externalSourceState,
    importService,
    assets: bookAssetRepository,
    extensionRevision: extensionRevision + externalSourceBrokerRevision,
    libraryRevision: cloudVaultMutationRevisions.library,
    getNovel: (id) => readerRepository.getNovel(id),
    listChapters: (novelId) => readerRepository.listChapters(novelId),
    openNovel: (novel, target) =>
      target?.documentSectionId
        ? bookWorkspace.openDocumentSection(novel, target.documentSectionId, target.documentSectionTitle)
        : bookWorkspace.openNovel(novel),
    listNovels: (options) => readerRepository.listNovels(options),
    onLibraryChanged: async () => {
      await refreshNovels();
      await refreshAfterLocalMutation();
    },
    notify: showToast,
    confirm: (message) => window.confirm(message),
  });
  openImportedSeriesRef.current = externalSourceFeature.showLocalSeries;
  const importBusy = importFeature.busy;

  const latestRemoteRefreshRef = useRef(refreshRemoteServerState);

  useEffect(() => {
    latestRemoteRefreshRef.current = refreshRemoteServerState;
  }, [refreshRemoteServerState]);

  useEffect(() => {
    remoteAutoRefreshGenerationRef.current += 1;
    remoteAutoRefreshBusyRef.current = false;
    return () => {
      remoteAutoRefreshGenerationRef.current += 1;
      remoteAutoRefreshBusyRef.current = false;
    };
  }, [connectedSyncController]);

  useLayoutEffect(() => {
    bookWorkspaceTransitionRef.current = {
      flushReaderSession: () => readerScreenHandle.flushSession(),
      resetAnalysis: analysisExecutionController.reset,
      stopChapterTTS: ttsExecutionController.stopAll,
      stopReaderTTS: () => {
        ttsExecutionController.stopAll();
        stopProviderSamples();
      },
      activateChapter: (chapterId) => {
        activeChapterIdRef.current = chapterId;
      },
      prepareReaderOpen: (chapterId, options) => readerScreenHandle.prepareOpen(chapterId, options),
    };
    bookWorkspaceAdjacentRef.current = {
      loadBookAnnotations: async (novelId) => {
        const [bookmarks, highlights, notes] = await Promise.all([
          readerRepository.listBookmarks(novelId),
          readerRepository.listHighlights(novelId),
          readerRepository.listNotes(novelId),
        ]);
        return { bookmarks, highlights, notes };
      },
      applyBookAnnotations: ({ bookmarks, highlights, notes }) => {
        setBookmarks(bookmarks);
        setHighlights(highlights);
        setNotes(notes);
      },
      loadReaderArtifacts: async (chapterId, novelId) => {
        const segments = await readerRepository.listSegments(chapterId);
        const [characters, voiceProfiles] = novelId
          ? await Promise.all([readerRepository.listCharacters(novelId), readerRepository.listVoiceProfiles(novelId)])
          : [[], []];
        return { segments, characters, voiceProfiles };
      },
      applyReaderArtifacts: ({ segments, characters, voiceProfiles }) => {
        setSegmentsState(segments);
        setCharacters(characters);
        setVoiceProfiles(voiceProfiles);
      },
      resetCorrection: () => setCorrectionTarget(undefined),
      resetAnnotationEditor: annotationsController.resetEditor,
      refreshNovels,
      refreshAfterLocalMutation,
      refreshSyncState,
      refreshAfterLocationConflict: () => void latestRemoteRefreshRef.current({ silent: true }),
    };
  });

  const syncConnectedProviderState = useCallback(
    async (phase: 'before_job' | 'after_job') => {
      if (!syncService) return true;
      const state = await flushSyncState();
      if (state?.status === 'idle') return true;

      const label = state ? syncStatusLabel(state) : '동기화 상태 없음';
      showToast(
        phase === 'before_job'
          ? `서버 provider 작업 전에 로컬 변경을 동기화하지 못했습니다: ${label}`
          : `서버 provider 결과를 로컬에 반영하지 못했습니다: ${label}`,
        phase === 'before_job' ? 'warning' : 'danger',
      );
      return false;
    },
    [flushSyncState, showToast, syncService],
  );

  const connectedProviderTargetStillActive = useCallback(
    (bookId: string, chapterId?: string) => {
      const bookStillActive = activeNovelIdRef.current === bookId;
      const chapterStillActive = !chapterId || activeChapterIdRef.current === chapterId;
      if (bookStillActive && chapterStillActive) return true;
      showToast('동기화 후 현재 선택이 바뀌어 서버 provider 작업을 중단했습니다.', 'warning');
      return false;
    },
    [showToast],
  );

  const ensureConnectedProviderServerBookAttached = useCallback(
    async (bookId: string, chapterIds: string[] = [], options: { silent?: boolean } = {}) => {
      if (!syncApiClient || remoteApiClient) return true;
      const localBook = selectedNovel?.id === bookId ? selectedNovel : novels.find((novel) => novel.id === bookId);
      const chapterTextHashById = Object.fromEntries(
        chapters
          .filter((chapter) => chapter.novelId === bookId && chapterIds.includes(chapter.id))
          .map((chapter) => [chapter.id, chapter.textHash]),
      );
      const check = await verifyConnectedProviderServerBookAttached(syncApiClient, bookId, chapterIds, {
        normalizedTextHash: localBook?.normalizedTextHash,
        chapterTextHashById,
      });
      if (check.ok) return true;
      if (!options.silent) {
        setSyncPanelOpen(true);
        showToast(
          check.reason === 'missing_chapter' || check.reason === 'stale_chapter' || check.reason === 'stale_book'
            ? '서버 provider 작업 전에 이 책의 최신 본문을 self-host 서버에 다시 연결해야 합니다. 동기화 패널에서 "서버 본문 연결"을 실행하세요.'
            : '서버 provider 작업 전에 이 책의 본문을 self-host 서버에 먼저 연결해야 합니다. 동기화 패널에서 "서버 본문 연결"을 실행하세요.',
          'warning',
        );
      }
      return false;
    },
    [chapters, novels, remoteApiClient, selectedNovel, showToast, syncApiClient],
  );

  const refreshBookAIWorkflowArtifacts = useCallback(
    async (bookId: string) => {
      if (bookAITTSPreparationRunner?.runtime === 'hosted' && !(await syncConnectedProviderState('after_job'))) {
        return false;
      }
      const chapterId = activeChapterIdRef.current;
      const [freshNovel, loadedCharacters, loadedVoiceProfiles, loadedSegments] = await Promise.all([
        readerRepository.getNovel(bookId),
        readerRepository.listCharacters(bookId),
        readerRepository.listVoiceProfiles(bookId),
        chapterId ? readerRepository.listSegments(chapterId) : Promise.resolve(undefined),
      ]);
      if (activeNovelIdRef.current !== bookId) return false;
      if (freshNovel) {
        setSelectedNovel(freshNovel);
        setNovels((previous) => previous.map((novel) => (novel.id === freshNovel.id ? freshNovel : novel)));
      }
      setCharacters(loadedCharacters);
      setVoiceProfiles(loadedVoiceProfiles);
      if (chapterId && activeChapterIdRef.current === chapterId && loadedSegments) setSegmentsState(loadedSegments);
      return true;
    },
    [bookAITTSPreparationRunner?.runtime, readerRepository, setNovels, setSelectedNovel, syncConnectedProviderState],
  );

  const refreshCancelledBookAIWorkflowNovel = useCallback(
    async (bookId: string) => {
      const freshNovel = await readerRepository.getNovel(bookId);
      if (!freshNovel || activeNovelIdRef.current !== bookId) return;
      setSelectedNovel(freshNovel);
      setNovels((previous) => previous.map((novel) => (novel.id === freshNovel.id ? freshNovel : novel)));
    },
    [readerRepository, setNovels, setSelectedNovel],
  );

  const bookAIWorkflowChapterIds = useMemo(
    () => chapters.filter((chapter) => chapter.novelId === selectedNovel?.id).map((chapter) => chapter.id),
    [chapters, selectedNovel?.id],
  );
  const bookAIWorkflowController = useBookAIWorkflowController({
    runner: bookAITTSPreparationRunner,
    bookId: selectedNovel?.id,
    chapterIds: bookAIWorkflowChapterIds,
    beforeRun: (bookId, chapterIds) => {
      if (bookAITTSPreparationRunner?.runtime === 'native') {
        return Promise.resolve(connectedProviderTargetStillActive(bookId));
      }
      return runConnectedProviderPreflight({
        syncBeforeJob: () => syncConnectedProviderState('before_job'),
        targetStillActive: () => connectedProviderTargetStillActive(bookId),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(bookId, [...chapterIds]),
      });
    },
    onTerminal: refreshBookAIWorkflowArtifacts,
    onCancelled: refreshCancelledBookAIWorkflowNovel,
    openAIAddon: () => {
      setAddonOpen(true);
      setAddonTab(MOYA_AI_ADDON_ID);
    },
    notify: showToast,
  });
  const bookAIWorkflow = bookAIWorkflowController.workflow;
  const bookAIWorkflowPlan = bookAIWorkflowController.plan;
  const bookAIWorkflowLoading = bookAIWorkflowController.loading;
  const bookAIWorkflowRunning = bookAIWorkflowController.running;
  const bookAIWorkflowError = bookAIWorkflowController.error;
  const analysisReviewController = useAnalysisReviewController({
    gateway: bookAnalysisWorkflowGateway,
    workflow: bookAIWorkflow,
    bookId: selectedNovel?.id,
    resumeWorkflow: bookAIWorkflowController.resumeMonitoring,
    onReviewPromoted: async (workflow) => {
      await refreshBookAIWorkflowArtifacts(workflow.novelId);
    },
    notify: showToast,
  });

  const retrySyncNow = useCallback(async () => {
    if (readerRuntime.mode === 'remote') {
      const state = await refreshRemoteServerState();
      if (!state) return;
      if (state.status === 'idle') {
        showToast('서버 상태를 새로고침했습니다.', 'success');
      } else {
        showToast('서버 상태를 새로고침하지 못했습니다.', 'danger');
      }
      return;
    }
    if (!syncService) {
      await refreshSyncState();
      showToast('현재 빌드는 로컬 전용입니다. 서버 동기화 주소가 설정되지 않았습니다.', 'info');
      return;
    }
    const state = await flushSyncState();
    if (!state) return;
    if (state.status === 'idle') {
      showToast('서버와 동기화했습니다.', 'success');
    } else if (state.status === 'offline' || state.status === 'conflict' || state.status === 'failed') {
      showToast(syncStatusLabel(state), state.status === 'offline' ? 'warning' : 'danger');
    }
  }, [flushSyncState, readerRuntime.mode, refreshRemoteServerState, refreshSyncState, showToast, syncService]);

  const acceptRemoteSyncState = useCallback(async () => {
    if (!syncService) return;
    const expectedNovelId = activeNovelIdRef.current;
    const expectedChapterId = activeChapterIdRef.current;
    setSyncFlushing(true);
    try {
      const result = await acceptRemoteSyncStateMutation({
        repository: readerRepository,
        remoteState: syncService,
        selectedNovelId: expectedNovelId,
        currentChapterId: expectedChapterId,
      });
      setSyncState(result.state);
      setSyncOutbox(result.outbox);
      setNovels(result.novels);
      const selectionStillCurrent =
        activeNovelIdRef.current === expectedNovelId && activeChapterIdRef.current === expectedChapterId;
      if (selectionStillCurrent && result.selection.status === 'missing') {
        replaceSelection({
          selectedNovel: undefined,
          currentChapter: undefined,
          chapters: [],
          localReadingPosition: undefined,
          remoteReadingPosition: undefined,
          view: 'library',
        });
        resetParagraphCache();
        setBookmarks([]);
        setHighlights([]);
        setNotes([]);
      } else if (selectionStillCurrent && result.selection.status === 'loaded') {
        replaceSelection({
          selectedNovel: result.selection.novel,
          chapters: result.selection.chapters,
          currentChapter: result.selection.currentChapter,
          localReadingPosition: result.selection.readingPosition,
        });
        setBookmarks(result.selection.bookmarks);
        setHighlights(result.selection.highlights);
        setNotes(result.selection.notes);
        setCharacters(result.selection.characters);
        setVoiceProfiles(result.selection.voiceProfiles);
        setSegmentsState(result.selection.segments);
        if (expectedChapterId && !result.selection.currentChapter) resetParagraphCache();
      }
      const settled = result.state.status === 'idle';
      showToast(
        settled
          ? '서버 상태를 기준으로 동기화 대기열을 정리했습니다.'
          : `서버 상태를 적용했지만 동기화가 완료되지 않았습니다. ${syncStatusLabel(result.state)}`,
        settled ? 'success' : result.state.status === 'offline' ? 'warning' : 'danger',
      );
    } finally {
      setSyncFlushing(false);
    }
  }, [
    readerRepository,
    replaceSelection,
    resetParagraphCache,
    setBookmarks,
    setHighlights,
    setNotes,
    setNovels,
    showToast,
    syncService,
  ]);

  const discardSyncOutboxItem = useCallback(
    async (item: SyncOutboxItem) => {
      if (item.status === 'sending') return;
      const confirmed = window.confirm(
        '이 로컬 변경을 서버로 보내지 않고 대기열에서 폐기할까요?\n\n본문/메모 자체를 되돌리지는 않고, 해당 동기화 요청만 완료 처리합니다.',
      );
      if (!confirmed) return;

      const result = await discardSyncOutboxIds({ repository: readerRepository, ids: [item.id] });
      setSyncState(result.state);
      setSyncOutbox(result.outbox);
      showToast('로컬 동기화 변경 1개를 폐기했습니다.', 'info');
    },
    [readerRepository, showToast],
  );

  const discardSyncOutboxGroup = useCallback(
    async (items: SyncOutboxItem[], label: string) => {
      const discardableItems = items.filter((item) => item.status !== 'sending');
      if (!discardableItems.length) return;
      const confirmed = window.confirm(
        `${label} 동기화 변경 ${formatCount(discardableItems.length)}개를 서버로 보내지 않고 대기열에서 지울까요?\n\n원본 AI/TTS 데이터 자체를 되돌리지는 않고, 해당 동기화 요청만 완료 처리합니다.`,
      );
      if (!confirmed) return;

      const result = await discardSyncOutboxIds({
        repository: readerRepository,
        ids: discardableItems.map((item) => item.id),
      });
      setSyncState(result.state);
      setSyncOutbox(result.outbox);
      showToast(`${label} 동기화 변경 ${formatCount(discardableItems.length)}개를 지웠습니다.`, 'info');
    },
    [readerRepository, showToast],
  );

  const commitAiTtsSyncMutation = useCallback(
    (result: AiTtsSyncMutationResult, expectedNovelId: string | undefined, expectedChapterId: string | undefined) => {
      setSyncState(result.state);
      setSyncOutbox(result.outbox);
      if (result.artifactReload.status === 'loaded' && activeNovelIdRef.current === expectedNovelId) {
        setCharacters(result.artifactReload.characters);
        setVoiceProfiles(result.artifactReload.voiceProfiles);
        if (activeChapterIdRef.current === expectedChapterId) setSegmentsState(result.artifactReload.segments);
      }
      return result.artifactReload.status === 'failed' ? result.artifactReload.error : undefined;
    },
    [],
  );

  const applyAiTtsSelectedLocalFields = useCallback(
    async (group: AiTtsSyncConflictGroup, remoteSnapshot: AiTtsSyncRemoteSnapshot, selectedKeys: readonly string[]) => {
      if (syncFlushing || !aiTtsRemoteSnapshotApplyAvailable(group)) return false;
      if (!group.novelId) {
        showToast('AI/TTS 동기화 묶음에 책 ID가 없습니다.', 'danger');
        return false;
      }
      if (!selectedKeys.length) {
        showToast('유지할 로컬 AI/TTS 필드를 먼저 선택하세요.', 'warning');
        return false;
      }
      const discardableItems = group.items.filter((item) => item.status !== 'sending');
      if (!discardableItems.length) return false;
      const confirmed = window.confirm(
        `${group.title} 서버 snapshot을 기준으로 적용하되 선택한 로컬 필드 ${formatCount(selectedKeys.length)}개만 유지할까요?\n\n적용 후 기존 충돌 대기열은 완료 처리되고, 병합된 결과가 새 로컬 변경으로 다시 동기화 대기열에 올라갑니다.`,
      );
      if (!confirmed) return false;
      const expectedNovelId = activeNovelIdRef.current;
      const expectedChapterId = activeChapterIdRef.current;

      setSyncFlushing(true);
      try {
        const result = await applyAiTtsSelectedLocalFieldsMutation({
          repository: readerRepository,
          group,
          remoteSnapshot,
          selectedKeys,
          artifactSelection: {
            selectedNovelId: expectedNovelId,
            currentChapterId: expectedChapterId,
            currentSegments: segments,
          },
        });
        const reloadError = commitAiTtsSyncMutation(result, expectedNovelId, expectedChapterId);
        await refreshAfterLocalMutation('aiTts');
        if (reloadError) showToast(`변경은 저장했지만 화면을 새로고치지 못했습니다: ${reloadError}`, 'warning');
        showToast(`${group.title} 선택 병합을 적용했습니다.`, 'success');
        return true;
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'danger');
        return false;
      } finally {
        setSyncFlushing(false);
      }
    },
    [commitAiTtsSyncMutation, readerRepository, refreshAfterLocalMutation, segments, showToast, syncFlushing],
  );

  const applyAiTtsRemoteSnapshotGroup = useCallback(
    async (group: AiTtsSyncConflictGroup, remoteSnapshot: AiTtsSyncRemoteSnapshot) => {
      if (syncFlushing || !aiTtsRemoteSnapshotApplyAvailable(group)) return false;
      const discardableItems = group.items.filter((item) => item.status !== 'sending');
      if (!discardableItems.length) return false;
      const confirmed = window.confirm(
        `${group.title} 서버 snapshot을 이 기기 상태에 적용하고 로컬 대기열 ${formatCount(discardableItems.length)}개를 완료 처리할까요?\n\n로컬 AI/TTS 원본 요청은 되돌리지 않고, 현재 기기의 voice/graph/segment 저장 상태만 서버 기준으로 맞춥니다.`,
      );
      if (!confirmed) return false;
      const expectedNovelId = activeNovelIdRef.current;
      const expectedChapterId = activeChapterIdRef.current;

      setSyncFlushing(true);
      try {
        const result = await applyAiTtsRemoteSnapshotMutation({
          repository: readerRepository,
          group,
          remoteSnapshot,
          artifactSelection: {
            selectedNovelId: expectedNovelId,
            currentChapterId: expectedChapterId,
            currentSegments: segments,
          },
        });
        const reloadError = commitAiTtsSyncMutation(result, expectedNovelId, expectedChapterId);
        if (reloadError) showToast(`변경은 저장했지만 화면을 새로고치지 못했습니다: ${reloadError}`, 'warning');
        showToast(`${group.title} 서버 snapshot을 적용했습니다.`, 'success');
        return true;
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'danger');
        return false;
      } finally {
        setSyncFlushing(false);
      }
    },
    [commitAiTtsSyncMutation, readerRepository, segments, showToast, syncFlushing],
  );

  const saveSyncApiBaseUrl = useCallback(() => {
    const normalized = saveStoredSyncApiBaseUrl(syncApiBaseUrlDraft);
    setSyncApiBaseUrlDraft(normalized);
    setSyncConnectionTest({ status: 'idle', normalizedBaseUrl: normalized });
    showToast(
      normalized
        ? '서버 API URL을 저장했습니다. 연결 서비스를 다시 구성합니다.'
        : '서버 API URL을 지웠습니다. 로컬 전용으로 다시 구성합니다.',
      'success',
    );
    window.setTimeout(() => {
      window.location.reload();
    }, 250);
  }, [showToast, syncApiBaseUrlDraft]);

  const testSyncConnection = useCallback(async () => {
    const candidateBaseUrl = syncApiBaseUrlDraft || readerRuntime.apiBaseUrl || '';
    const normalizedBaseUrl = normalizeSyncApiBaseUrl(candidateBaseUrl);
    setSyncConnectionTest({ status: 'testing', normalizedBaseUrl });
    const result = await testSyncApiConnection(candidateBaseUrl, apiAuthTokenDraft || resolveApiAuthToken());
    setSyncConnectionTest({
      status: result.ok ? 'ok' : 'failed',
      message: result.message,
      normalizedBaseUrl: result.normalizedBaseUrl,
    });
    showToast(
      result.ok ? '서버 연결 테스트에 성공했습니다.' : `서버 연결 테스트 실패: ${result.message}`,
      result.ok ? 'success' : 'danger',
    );
  }, [apiAuthTokenDraft, readerRuntime.apiBaseUrl, showToast, syncApiBaseUrlDraft]);

  const refreshTTSState = useCallback(async () => {
    const result = await connectedSyncController.runRuntimeTask('system-tts-refresh', {
      load: async () => {
        const [status, voiceList] = await Promise.all([systemTTS.getStatus(), systemTTS.listVoices()]);
        return { status, voiceList };
      },
      commit: ({ status, voiceList }) => {
        setTTSStatus(status);
        setVoices(voiceList);
      },
    });
    return result?.status;
  }, [connectedSyncController, systemTTS]);

  const retryAppBootstrap = useAppBootstrap(connectedSyncController, async (context) => {
    if (context.isCurrent()) setBootstrapState({ status: 'loading' });
    try {
      await runGuardedAppBootstrap(context, {
        load: async () => {
          const [settings, activeNovels, trashNovels, state, outbox, ttsStatus, voiceList] = await Promise.all([
            readerRepository.getSettings(),
            readerRepository.listNovels(),
            libraryCatalogRepository?.listTrash() ?? Promise.resolve([]),
            readerRepository.getSyncState(),
            readerRepository.listSyncOutbox(),
            systemTTS.getStatus(),
            systemTTS.listVoices(),
          ]);
          return { settings, novels: [...activeNovels, ...trashNovels], state, outbox, ttsStatus, voiceList };
        },
        commit: ({ settings, novels, state, outbox, ttsStatus, voiceList }) => {
          setReaderSettings(settings);
          setNovels(novels);
          setSyncState(state);
          setSyncOutbox(outbox);
          setTTSStatus(ttsStatus);
          setVoices(voiceList);
        },
        afterCommit: async ({ state }, activeContext) => {
          if (state.status !== 'conflict') await flushSyncState();
          if (!activeContext.isCurrent()) return;
        },
      });
      if (context.isCurrent()) setBootstrapState({ status: 'ready' });
    } catch (error) {
      if (!context.isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (readerRuntime.mode === 'remote') {
        const failedState = connectedSyncFailureState(message);
        setSyncState(failedState);
        setSyncOutbox([]);
        showToast('서버 인증 또는 연결 상태를 확인하세요.', 'warning');
      } else {
        showToast('초기 데이터를 불러오지 못했습니다.', 'danger');
      }
      setBootstrapState({
        status: 'failed',
        message:
          readerRuntime.mode === 'remote'
            ? '서버에서 책장을 불러오지 못했습니다. 연결과 인증 정보를 확인한 뒤 다시 시도하세요.'
            : '이 기기에 저장된 책장을 불러오지 못했습니다. 잠시 후 다시 시도하세요.',
      });
    }
  });

  const saveApiAuthToken = useCallback(async () => {
    const normalized = apiAuthTokenDraft.trim();
    try {
      await saveStoredApiAuthToken(normalized);
      setApiAuthTokenConfigured(Boolean(normalized));
      if (apiAuthTokenUsesNativeSecureStore()) setApiAuthTokenDraft('');
      showToast(normalized ? '서버 인증 토큰을 저장했습니다.' : '서버 인증 토큰을 지웠습니다.', 'success');
      if (readerRuntime.mode === 'remote') {
        retryAppBootstrap();
      } else {
        void retrySyncNow();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '서버 인증 토큰을 안전하게 저장하지 못했습니다.', 'danger');
    }
  }, [apiAuthTokenDraft, readerRuntime.mode, retryAppBootstrap, retrySyncNow, showToast]);

  useEffect(() => {
    if (!providerApiClient && !isDesktopProviderRuntime) return;
    if (!addonOpen || (addonTab !== MOYA_AI_ADDON_ID && addonTab !== 'tts')) return;
    if (providerSettingsLoading) return;
    if (providerSettingsBundle && !(isDesktopProviderRuntime && providerSecretStatuses.length === 0)) return;
    const autoLoadKey = `${providerExecutionRuntime}:${platformRuntime.kind}`;
    if (providerSettingsAutoLoadKeyRef.current === autoLoadKey) return;
    providerSettingsAutoLoadKeyRef.current = autoLoadKey;
    void refreshProviderSettings({ silent: true });
  }, [
    addonOpen,
    addonTab,
    isDesktopProviderRuntime,
    providerApiClient,
    providerExecutionRuntime,
    providerSecretStatuses.length,
    providerSettingsBundle,
    providerSettingsLoading,
    platformRuntime.kind,
    refreshProviderSettings,
  ]);

  const remoteAutoRefreshEnabled = shouldRunRemoteAutoRefresh({
    backendMode: readerRuntime.mode,
    syncFlushing,
    importBusy,
    state: syncState,
  });

  useEffect(() => {
    if (!remoteAutoRefreshEnabled) return;

    const runSilentRefresh = () => {
      if (document.visibilityState === 'hidden') return;
      if (remoteAutoRefreshBusyRef.current) return;
      remoteAutoRefreshBusyRef.current = true;
      const refreshGeneration = remoteAutoRefreshGenerationRef.current + 1;
      remoteAutoRefreshGenerationRef.current = refreshGeneration;
      void latestRemoteRefreshRef.current({ silent: true }).finally(() => {
        if (remoteAutoRefreshGenerationRef.current === refreshGeneration) {
          remoteAutoRefreshBusyRef.current = false;
        }
      });
    };

    const timer = window.setInterval(runSilentRefresh, REMOTE_AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [remoteAutoRefreshEnabled]);

  useEffect(() => {
    const root = document.documentElement;
    const appTheme = resolveAppTheme(settings.applicationTheme ?? readingProfile.theme);
    const customColors = normalizeApplicationThemeColors(settings.applicationThemeColors);
    root.dataset.theme = appTheme;
    root.style.setProperty('--app-custom-background', customColors.background);
    root.style.setProperty('--app-custom-surface', customColors.surface);
    root.style.setProperty('--app-custom-text', customColors.text);
    root.style.setProperty('--app-custom-accent', customColors.accent);
    root.style.setProperty(
      '--app-custom-accent-contrast',
      isDarkThemeColor(customColors.accent) ? '#ffffff' : '#111315',
    );
    root.style.colorScheme = appTheme === 'custom' && !isDarkThemeColor(customColors.background) ? 'light' : 'dark';
    if (appTheme === 'light' || appTheme === 'sepia') root.style.colorScheme = 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', appThemeColor(appTheme, customColors));
  }, [readingProfile.theme, settings.applicationTheme, settings.applicationThemeColors]);

  useEffect(() => {
    activeNovelIdRef.current = selectedNovel?.id;
  }, [selectedNovel?.id]);

  const addSample = async () => {
    const parsed = await createSampleNovel();
    await readerRepository.saveImportedNovel(parsed);
    await refreshNovels();
    await refreshAfterLocalMutation();
    await bookWorkspace.openNovel((await readerRepository.getNovel(parsed.novel.id)) ?? parsed.novel);
    showToast('샘플 책을 추가했습니다.', 'success');
  };

  const exportBookSource = useCallback(
    async (novel: Novel) => {
      if (!bookAssetRepository) {
        showToast('이 실행 환경에서는 원본 다운로드를 지원하지 않습니다.', 'warning');
        return;
      }
      try {
        const source = await bookAssetRepository.exportSource(novel.id);
        if (!source) {
          showToast('보관된 원본 파일이 없습니다. 원본을 다시 가져와 보강하세요.', 'warning');
          return;
        }
        const result = await documentIo.saveDocument({
          suggestedName: source.metadata.fileName || novel.sourceFileName || `${novel.title}.txt`,
          mimeType: source.metadata.contentType || 'application/octet-stream',
          blob: source.blob,
        });
        if (result === 'cancelled') {
          showToast('원본 파일 저장을 취소했습니다.', 'info');
          return;
        }
        showToast(`원본 ${formatBytes(source.metadata.byteLength)}을(를) 다운로드했습니다.`, 'success');
      } catch {
        showToast('원본 파일을 다운로드하지 못했습니다.', 'danger');
      }
    },
    [bookAssetRepository, documentIo, showToast],
  );

  const reselectBookSource = useCallback(
    async (novel: Novel, file: File) => {
      if (!bookAssetRepository) {
        showToast('이 실행 환경에서는 원본 다시 선택을 지원하지 않습니다.', 'warning');
        return;
      }
      try {
        await bookAssetRepository.reselectOriginalSource(novel.id, {
          fileName: file.name,
          contentType: file.type || 'text/plain',
          blob: file,
        });
        await refreshNovels();
        const updated = await readerRepository.getNovel(novel.id);
        if (updated) await bookWorkspace.openNovel(updated);
        showToast(`원본 ${formatBytes(file.size)}을(를) 연결했습니다.`, 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : '원본 파일을 연결하지 못했습니다.', 'danger');
      }
    },
    [bookAssetRepository, bookWorkspace, readerRepository, refreshNovels, showToast],
  );

  const reconstructBookSource = useCallback(
    async (novel: Novel) => {
      if (!bookAssetRepository?.reconstructCanonicalSource) {
        showToast('이 실행 환경에서는 source 재구성을 지원하지 않습니다.', 'warning');
        return;
      }
      try {
        const source = await bookAssetRepository.reconstructCanonicalSource(novel.id);
        await refreshNovels();
        const updated = await readerRepository.getNovel(novel.id);
        if (updated) await bookWorkspace.openNovel(updated);
        showToast(`재구성 source ${formatBytes(source.byteLength)}을(를) 만들었습니다.`, 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'source를 재구성하지 못했습니다.', 'danger');
      }
    },
    [bookAssetRepository, bookWorkspace, readerRepository, refreshNovels, showToast],
  );

  const correctionReviewItems = useMemo(() => buildLabelCorrectionReviewItems({ segments }), [segments]);
  const correctionReviewSegmentIds = useMemo(
    () => new Set(correctionReviewItems.map((item) => item.segment.id)),
    [correctionReviewItems],
  );
  const correctionSpeakerOptions = useMemo(() => {
    const options = [
      { id: 'narrator', label: '내레이터' },
      { id: 'system', label: '시스템' },
      { id: 'unknown', label: '화자 미정' },
      ...characters.map((character) => ({ id: character.id, label: character.canonicalName })),
    ];
    const extraSpeakerIds = correctionTarget ? [correctionTarget.speakerId, ...correctionTarget.candidateSpeakers] : [];
    for (const speakerId of extraSpeakerIds) {
      if (!options.some((option) => option.id === speakerId)) {
        options.push({ id: speakerId, label: speakerIdLabel(speakerId, characters) });
      }
    }
    return options;
  }, [characters, correctionTarget]);
  const correctionEmotionOptions = useMemo(
    () => buildCorrectionEmotionOptions(correctionTarget?.emotion, correctionEmotionDraft),
    [correctionEmotionDraft, correctionTarget],
  );

  const selectedTTSVoiceMissing = Boolean(
    settings.ttsVoiceURI && voices.length > 0 && !voices.some((voice) => voice.id === settings.ttsVoiceURI),
  );
  const ttsUnavailable = ttsStatus?.canSpeak === false;
  const ttsStatusTone = ttsUnavailable
    ? 'danger'
    : !ttsStatus || !ttsStatus.voicesAvailable || selectedTTSVoiceMissing
      ? 'warning'
      : 'ready';
  const activeSystemVoiceProfiles = voiceProfiles.filter((profile) => profile.providerId === 'system');
  const hostedProviderMode = Boolean(providerApiClient);
  const desktopProviderMode = isDesktopProviderRuntime && Boolean(providerControlClient);
  const providerSettingsMode = hostedProviderMode || desktopProviderMode;
  const llmDraft = providerSettingsDrafts.llm_labeling;
  const ttsSynthesisDraft = providerSettingsDrafts.tts_synthesis;
  const llmProviders = providerCatalogForScope(providerCatalog, 'llm_labeling');
  const ttsSynthesisProviders = providerCatalogForScope(providerCatalog, 'tts_synthesis');
  const savedLLMSettings = providerSettingsForScope(providerSettingsBundle, 'llm_labeling');
  const savedTTSSettings = providerSettingsForScope(providerSettingsBundle, 'tts_synthesis');
  const selectedLLMProvider = llmProviders.find(
    (provider) => provider.providerId === savedLLMSettings?.defaultProviderId,
  );
  const selectedHostedTTSProvider = ttsSynthesisProviders.find(
    (provider) =>
      provider.providerId === savedTTSSettings?.defaultProviderId &&
      provider.providerId !== 'system' &&
      catalogProviderReady(provider),
  );
  const selectedLLMLabel = selectedLLMProvider?.displayName ?? savedLLMSettings?.defaultProviderId ?? '서버 기본값';
  const selectedHostedTTSLabel =
    selectedHostedTTSProvider?.displayName ?? savedTTSSettings?.defaultProviderId ?? '서버 기본값';
  const selectedHostedTTSVoices = selectedHostedTTSProvider
    ? (hostedTTSVoicesByProvider[selectedHostedTTSProvider.providerId] ?? [])
    : [];
  const selectedHostedTTSModel = selectedHostedTTSProvider
    ? (selectedHostedTTSProvider.models.find(
        (model) => model.modelId === savedTTSSettings?.modelByProvider[selectedHostedTTSProvider.providerId],
      ) ?? selectedHostedTTSProvider.models.find((model) => model.enabled))
    : undefined;
  const selectedHostedTTSCapability =
    selectedHostedTTSModel?.capabilitySnapshot?.kind === 'tts' ? selectedHostedTTSModel.capabilitySnapshot : undefined;
  const selectedTTSPitchSupported = selectedHostedTTSProvider
    ? Boolean(selectedHostedTTSCapability?.supportedControls.includes('pitch'))
    : true;
  const ttsBookOverrideEnabled = hasBookTTSPlaybackOverride(settings, selectedNovel?.id);
  const changeTTSPlaybackSettings = (patch: TTSPlaybackSettingsOverride) => {
    updateSettings((previous) =>
      selectedNovel && hasBookTTSPlaybackOverride(previous, selectedNovel.id)
        ? updateBookTTSPlaybackOverride(
            previous,
            selectedNovel.id,
            Object.prototype.hasOwnProperty.call(patch, 'sleepTimerDefault') && patch.sleepTimerDefault === undefined
              ? { ...patch, sleepTimerDefault: null }
              : patch,
          )
        : updateGlobalTTSPlaybackSettings(previous, patch),
    );
  };
  const setTTSBookOverrideEnabled = (enabled: boolean) => {
    if (!selectedNovel) return;
    updateSettings((previous) =>
      enabled
        ? updateBookTTSPlaybackOverride(previous, selectedNovel.id, {})
        : resetBookTTSPlaybackOverride(previous, selectedNovel.id),
    );
  };
  const llmProviderBlocked = Boolean(selectedLLMProvider && !catalogProviderReady(selectedLLMProvider));
  const remoteAnalysisProviderBlocked = Boolean(hostedProviderMode && llmProviderBlocked);
  const desktopAnalysisProviderBlocked = Boolean(desktopProviderMode && llmProviderBlocked);
  const remoteAnalysisDisabled =
    !hostedProviderMode || remoteAnalysisRunning || !selectedNovel || !currentChapter || remoteAnalysisProviderBlocked;
  const desktopAnalysisDisabled =
    !desktopProviderMode ||
    remoteAnalysisRunning ||
    !selectedNovel ||
    !currentChapter ||
    desktopAnalysisProviderBlocked;
  const providerAnalysisDisabled =
    !providerSettingsMode ||
    remoteAnalysisRunning ||
    !selectedNovel ||
    !currentChapter ||
    (hostedProviderMode ? remoteAnalysisProviderBlocked : desktopAnalysisProviderBlocked);
  const bundleAnalysisChapters = useMemo(
    () => chaptersForBundleAnalysis(chapters, currentChapter),
    [chapters, currentChapter],
  );
  const lastBundleAnalysisSummary = useMemo<BundleAnalysisJobSummary>(
    () =>
      lastBundleAnalysisJob?.novelId === selectedNovel?.id
        ? bundleAnalysisJobSummary(lastBundleAnalysisJob)
        : { sourceChapterIds: [] },
    [lastBundleAnalysisJob, selectedNovel?.id],
  );
  const graphReview = useMemo(
    () =>
      selectedNovel && lastBundleAnalysisSummary.discoveredGraph
        ? buildCharacterGraphReview({
            novelId: selectedNovel.id,
            discoveredGraph: lastBundleAnalysisSummary.discoveredGraph,
            existingCharacters: characters,
            excludedCharacterIds: graphReviewExcludedCharacterIds,
          })
        : undefined,
    [characters, graphReviewExcludedCharacterIds, lastBundleAnalysisSummary.discoveredGraph, selectedNovel],
  );
  const graphReviewCandidates = graphReview?.candidates ?? [];
  const graphKnowledgeData = useMemo(() => {
    const knowledge = graphKnowledgeController.knowledge;
    if (!knowledge) return undefined;
    const names = new Map(characters.map((character) => [character.id, character.canonicalName]));
    const validityLabel = (validity: { fromChapterIndex: number; toChapterIndex?: number; sceneId?: string }) => {
      const chapterRange = validity.toChapterIndex
        ? `${validity.fromChapterIndex}~${validity.toChapterIndex}화`
        : `${validity.fromChapterIndex}화부터`;
      return validity.sceneId ? `${chapterRange} · ${validity.sceneId}` : chapterRange;
    };
    return {
      factCount: knowledge.facts.length,
      genericMentionCount: knowledge.mentions.filter((mention) => mention.kind === 'generic_reference').length,
      addressTermCount: knowledge.addressTerms.length,
      evidenceCount: knowledge.evidence.length,
      busy: graphKnowledgeController.busy,
      error: graphKnowledgeController.error,
      facts: knowledge.facts
        .filter((fact) => fact.status !== 'rejected' || fact.lockedByUser)
        .slice(0, 50)
        .map((fact) => ({
          id: fact.id,
          characterName: names.get(fact.characterId) ?? fact.characterId,
          field: fact.field,
          value: fact.value,
          status: fact.status,
          locked: fact.lockedByUser,
          evidenceCount: fact.evidenceIds.length,
          validityLabel: validityLabel(fact.validity),
        })),
      mergeCandidates: knowledge.mergeCandidates
        .filter((candidate) => candidate.status === 'open')
        .slice(0, 20)
        .map((candidate) => ({
          id: candidate.id,
          sourceName: names.get(candidate.sourceCharacterId) ?? candidate.sourceCharacterId,
          targetName: names.get(candidate.targetCharacterId) ?? candidate.targetCharacterId,
          positiveReasons: candidate.positiveReasons,
          negativeReasons: candidate.negativeReasons,
          confidence: candidate.confidence,
          applicable: names.has(candidate.sourceCharacterId) && names.has(candidate.targetCharacterId),
        })),
    };
  }, [characters, graphKnowledgeController.busy, graphKnowledgeController.error, graphKnowledgeController.knowledge]);
  const bundleAnalysisDisabled = providerAnalysisDisabled || bundleAnalysisChapters.length === 0;
  const labelRepairDisabled = providerAnalysisDisabled || segments.length === 0;
  const graphMergeDisabled =
    !providerSettingsMode ||
    remoteAnalysisRunning ||
    !selectedNovel ||
    (hostedProviderMode ? remoteAnalysisProviderBlocked : desktopAnalysisProviderBlocked) ||
    !graphReview ||
    Boolean(graphReview.parseError) ||
    graphReview.reviewedGraph.characters.length === 0;
  const activeBookAIWorkflow = bookAIWorkflow?.novelId === selectedNovel?.id ? bookAIWorkflow : undefined;
  const activeBookAIWorkflowPlan = activeBookAIWorkflow?.plan ?? bookAIWorkflowPlan;
  const activeBookAIWorkflowProgress = bookAIWorkflowProgress(activeBookAIWorkflow);
  const activeBookAIWorkflowProgressBody = recordValue(activeBookAIWorkflow?.progress);
  const activeBookAIWorkflowTtsReadiness = recordValue(activeBookAIWorkflowProgressBody?.ttsReadiness);
  const activeBookAIWorkflowTtsReadinessMetrics = recordValue(activeBookAIWorkflowTtsReadiness?.metrics);
  const activeBookAIWorkflowTtsCacheReadiness = recordValue(activeBookAIWorkflowProgressBody?.ttsCacheReadiness);
  const activeBookAIWorkflowTtsCacheReadinessMetrics = recordValue(activeBookAIWorkflowTtsCacheReadiness?.metrics);
  const bookAIWorkflowAvailable = Boolean(bookAITTSPreparationRunner);
  const {
    reviewItems: activeBookAIWorkflowReviewItems,
    busy: bookAIWorkflowBusy,
    retryDisabled: bookAIWorkflowRetryDisabled,
    cancelDisabled: bookAIWorkflowCancelDisabled,
    startDisabled: bookAIWorkflowDisabled,
    labelVoiceReady: bookAIWorkflowLabelVoiceReady,
  } = bookAIWorkflowControlState({
    workflow: activeBookAIWorkflow,
    available: bookAIWorkflowAvailable,
    hasNovel: Boolean(selectedNovel),
    loading: bookAIWorkflowLoading,
    running: bookAIWorkflowRunning,
    anotherAnalysisRunning: remoteAnalysisRunning,
    providerBlocked:
      bookAITTSPreparationRunner?.runtime === 'native' ? desktopAnalysisProviderBlocked : remoteAnalysisProviderBlocked,
  });
  useEffect(() => {
    setGraphReviewExcludedCharacterIds(new Set());
  }, [lastBundleAnalysisJob?.id, selectedNovel?.id]);
  const hostedVoiceProfiles = selectedHostedTTSProvider
    ? voiceProfiles.filter((profile) => profile.providerId === selectedHostedTTSProvider.providerId)
    : [];
  const voiceSampleAudioSession = useMemo(() => new BrowserAudioSession(), []);
  const voiceProductStateRef = useRef<VoiceProductStateV1 | undefined>(undefined);
  const playVoiceProductSample = useCallback(
    async (profile: VoiceProfile, text: string, kind: 'neutral' | 'in_context'): Promise<boolean> => {
      stopProviderSamples();
      voiceSampleAudioSession.stop(true);
      if (profile.providerId === 'system') {
        return new Promise((resolve) => {
          void systemTTS.speak({
            text,
            rate: profile.speed,
            voiceURI: profile.providerVoiceId,
            onEnd: () => resolve(true),
            onError: () => resolve(false),
          });
        });
      }
      if (desktopProviderMode && selectedHostedTTSProvider?.providerId === profile.providerId && ttsSynthesisDraft) {
        return providerSettings.playDesktopVoiceSample(
          selectedHostedTTSProvider,
          ttsSynthesisDraft,
          text,
          profile.providerVoiceId,
        );
      }
      if (
        hostedProviderMode &&
        providerApiClient &&
        selectedNovel &&
        currentChapter &&
        selectedHostedTTSProvider?.providerId === profile.providerId &&
        kind === 'neutral' &&
        text === ttsVoiceSampleText(TTS_NEUTRAL_SAMPLE_KO_V1)
      ) {
        try {
          const { buildHostedNeutralVoiceSampleRequest } = await import('./providers/hosted-tts-playback');
          const sample = buildHostedNeutralVoiceSampleRequest({
            novelId: selectedNovel.id,
            chapterId: currentChapter.id,
            voiceProfile: profile,
            providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
            modelByProvider: savedTTSSettings?.modelByProvider,
            pronunciationRevisionId: voiceProductStateRef.current?.pronunciationProfile.revisionId,
            capability: selectedHostedTTSCapability,
            voiceEntryFingerprint: voiceProductStateRef.current?.catalogSnapshots
              .flatMap((snapshot) => snapshot.entries)
              .find(
                (entry) =>
                  entry.providerId === profile.providerId &&
                  entry.voiceId === profile.providerVoiceId &&
                  entry.available,
              )?.fingerprint,
          });
          if (!sample) return false;
          const controller = new AbortController();
          const resolved = await providerApiClient.resolveTTSCache(
            currentChapter.id,
            sample.request,
            controller.signal,
          );
          if (resolved.job)
            await ttsExecutionController.pollHostedJob(resolved.job.id, controller.signal, { silent: true });
          const audio = await providerApiClient.fetchTTSCacheAudio(
            currentChapter.id,
            resolved.cacheKey,
            controller.signal,
          );
          return voiceSampleAudioSession.playBlob(audio);
        } catch (error) {
          showToast(error instanceof Error ? error.message : 'Hosted 음성 샘플을 재생하지 못했습니다.', 'warning');
          return false;
        }
      }
      showToast('Hosted 문맥 샘플은 현재 문단 재생으로 확인하세요.', 'info');
      return false;
    },
    [
      desktopProviderMode,
      hostedProviderMode,
      currentChapter,
      providerApiClient,
      providerSettings,
      savedTTSSettings?.modelByProvider,
      savedTTSSettings?.providerOptionsByProvider,
      selectedHostedTTSCapability,
      selectedHostedTTSProvider,
      selectedNovel,
      showToast,
      stopProviderSamples,
      systemTTS,
      ttsExecutionController,
      ttsSynthesisDraft,
      voiceSampleAudioSession,
    ],
  );
  const voiceProductController = useVoiceProductController({
    repository: readerRepository,
    novelId: selectedNovel?.id,
    contentRevisionId: selectedNovel?.activeContentRevisionId,
    characters,
    voiceProfiles,
    systemProvider: { providerId: 'system', voices, source: 'system_discovery' },
    hostedProvider: selectedHostedTTSProvider
      ? {
          providerId: selectedHostedTTSProvider.providerId,
          modelId: selectedHostedTTSModel?.modelId,
          voices: selectedHostedTTSVoices,
          source: 'live_discovery',
          capability: selectedHostedTTSCapability,
        }
      : undefined,
    playSample: playVoiceProductSample,
    onProfilesChanged: (nextProfiles) => {
      voiceProfilesRef.current = nextProfiles;
      setVoiceProfiles(nextProfiles);
      bookAIWorkflowController.invalidateTTSReadiness();
      void refreshAfterLocalMutation('aiTts');
    },
    notify: showToast,
  });
  const pronunciationSpokenTextRules = useMemo<SpokenTextRule[]>(
    () =>
      (voiceProductController.state?.pronunciationProfile.rules ?? [])
        .filter((rule) => rule.enabled && rule.mode === 'literal')
        .map((rule, index) => ({
          id: rule.id,
          scope: 'book',
          bookId: selectedNovel?.id,
          kind: 'replace_literal',
          pattern: rule.sourceTerm,
          replacement: rule.replacement,
          enabled: true,
          priority: index,
          updatedAt: voiceProductController.state?.pronunciationProfile.updatedAt ?? '',
        })),
    [selectedNovel?.id, voiceProductController.state?.pronunciationProfile],
  );
  const [customSpokenTextRules, setCustomSpokenTextRules] = useState<SpokenTextRule[]>([]);
  useEffect(() => {
    let active = true;
    void import('./storage/spoken-text-rule-store')
      .then((store) => store.listSpokenTextRules(selectedNovel?.id))
      .then((rules) => {
        if (active) setCustomSpokenTextRules(rules);
      })
      .catch(() => {
        if (active) setCustomSpokenTextRules([]);
      });
    return () => {
      active = false;
    };
  }, [selectedNovel?.id]);
  const spokenTextRules = useMemo(
    () => [...pronunciationSpokenTextRules, ...customSpokenTextRules],
    [customSpokenTextRules, pronunciationSpokenTextRules],
  );
  const saveSpokenTextSkipRule = async (
    pattern: string,
    kind: Extract<SpokenTextRule['kind'], 'skip_line' | 'skip_prefix' | 'skip_suffix'>,
  ) => {
    const store = await import('./storage/spoken-text-rule-store');
    const rule = await store.saveSpokenTextRule({
      scope: selectedNovel ? 'book' : 'global',
      bookId: selectedNovel?.id,
      kind,
      pattern,
      enabled: true,
      priority: customSpokenTextRules.length,
    });
    setCustomSpokenTextRules((current) => [...current.filter((item) => item.id !== rule.id), rule]);
  };
  const removeSpokenTextSkipRule = async (id: string) => {
    const store = await import('./storage/spoken-text-rule-store');
    await store.deleteSpokenTextRule(id);
    setCustomSpokenTextRules((current) => current.filter((item) => item.id !== id));
  };
  const previewSpokenTextRuleImpact = useCallback(
    async (signal: AbortSignal) => {
      if (!selectedNovel) throw new Error('책을 먼저 열어주세요.');
      const { inspectSpokenTextRuleImpact } = await import('./features/tts/spoken-text-rule-impact');
      return inspectSpokenTextRuleImpact({
        chapters,
        language: selectedNovel.language,
        rules: spokenTextRules,
        signal,
        iterateParagraphPages: (chapterId, requestSignal) =>
          readerRepository.iterateParagraphPages({ chapterId, signal: requestSignal, batchSize: 20 }),
      });
    },
    [chapters, readerRepository, selectedNovel, spokenTextRules],
  );
  useEffect(() => {
    voiceProductStateRef.current = voiceProductController.state;
  }, [voiceProductController.state]);
  const voiceProductWholeBookReady = useMemo(() => {
    const state = voiceProductController.state;
    if (!state || !selectedHostedTTSProvider) return false;
    const majorSuggestions = state.suggestions.filter(
      (item) => item.providerId === selectedHostedTTSProvider.providerId && item.major,
    );
    return (
      !voiceProductController.castingSummary.stale &&
      voiceProductController.castingSummary.reviews === 0 &&
      majorSuggestions.length > 0 &&
      majorSuggestions.every((suggestion) => {
        const profile = voiceProfiles.find((item) => item.id === suggestion.voiceProfileId);
        if (!profile) return false;
        const approval = voiceApprovalForProfile(state, profile);
        return approval?.decision === 'approved' && !approval.staleReason;
      })
    );
  }, [
    selectedHostedTTSProvider,
    voiceProductController.castingSummary.reviews,
    voiceProductController.castingSummary.stale,
    voiceProductController.state,
    voiceProfiles,
  ]);
  const selectedVoiceEntryFingerprintByVoiceId = useMemo(
    () =>
      Object.fromEntries(
        (voiceProductController.state?.catalogSnapshots ?? [])
          .filter((snapshot) => snapshot.providerId === selectedHostedTTSProvider?.providerId)
          .flatMap((snapshot) => snapshot.entries.map((entry) => [entry.voiceId, entry.fingerprint])),
      ),
    [selectedHostedTTSProvider?.providerId, voiceProductController.state?.catalogSnapshots],
  );
  const hostedTTSPlaybackReady =
    (hostedProviderMode || desktopProviderMode) && Boolean(selectedHostedTTSProvider) && hostedVoiceProfiles.length > 0;
  const hostedTTSWarmupDisabled =
    !(hostedProviderMode || (desktopProviderMode && ttsCacheGateway && selectedNovel?.activeContentRevisionId)) ||
    !hostedTTSPlaybackReady ||
    hostedTTSBusy ||
    !currentChapter;
  const bookAIWorkflowWarmupDisabled = !bookAIWorkflowLabelVoiceReady || hostedTTSWarmupDisabled;
  const bookAIWorkflowCacheReady = activeBookAIWorkflowTtsCacheReadiness?.ok === true;
  const nativeTTSCacheAvailable = Boolean(
    desktopProviderMode && ttsCacheGateway && activeBookAIWorkflow && selectedNovel?.activeContentRevisionId,
  );
  const loadNativeTTSCacheContext = async () => {
    const module = await import('./features/tts/native-tts-cache-controller');
    return {
      module,
      input: module.createNativeTTSCacheControllerInput(
        [desktopProviderMode, ttsCacheGateway],
        [selectedNovel, chapters, currentChapter, segments, characters, readerRepository, cachedParagraphById],
        [
          hostedVoiceProfiles,
          settings.ttsVoiceURI,
          ttsPlaybackSettings.rate,
          savedTTSSettings?.providerOptionsByProvider,
          savedTTSSettings?.modelByProvider,
          voiceProductController.state?.pronunciationProfile.revisionId,
          selectedHostedTTSCapability,
          selectedVoiceEntryFingerprintByVoiceId,
          (chapterId: string) =>
            voiceProductController.loadVoiceBindings(chapterId, selectedHostedTTSProvider?.providerId),
          spokenTextRules,
        ],
        [activeBookAIWorkflow, bookAIWorkflowLabelVoiceReady, bookAIWorkflowController.adoptWorkflow, showToast],
      ),
    };
  };
  const bookAIWorkflowCacheRefreshDisabled =
    !(bookAITTSPreparationRunner?.supportsTTSCacheReadiness || nativeTTSCacheAvailable) ||
    !activeBookAIWorkflow ||
    !bookAIWorkflowLabelVoiceReady ||
    bookAIWorkflowLoading;
  const aiTtsSyncSummary = summarizeAiTtsSyncConflicts(syncOutbox);
  const connectedProviderLocalMetadataPending = Boolean(syncService && aiTtsSyncSummary.unsentCount > 0);
  const syncUiState = readerRuntime.mode === 'remote' || syncService ? syncState : undefined;
  const cloudVaultProviderName = cloudVault.providerKind === 'dropbox' ? 'Dropbox' : '로컬 폴더';
  const syncLabel =
    cloudVault.activity === 'syncing'
      ? '동기화 중'
      : cloudVault.activity !== 'idle'
        ? '확인 중'
        : cloudVault.connected && cloudVault.config?.lastError
          ? `${cloudVaultProviderName} 확인 필요`
          : cloudVault.connected
            ? `${cloudVaultProviderName} · ${cloudVault.config?.autoSync === false ? '수동' : '자동'}`
            : syncUiState
              ? syncStatusLabel(syncUiState)
              : '연결 안 됨';
  const syncTone =
    cloudVault.activity !== 'idle'
      ? 'syncing'
      : cloudVault.connected && cloudVault.config?.lastError
        ? 'danger'
        : cloudVault.connected
          ? 'ready'
          : syncStatusTone(syncUiState);
  const loadSyncRemoteSnapshot = useCallback(
    (group: AiTtsSyncConflictGroup) => {
      if (!syncApiClient) return Promise.reject(new Error('동기화 서버가 연결되지 않았습니다.'));
      return loadAiTtsRemoteSnapshot(syncApiClient, group);
    },
    [syncApiClient],
  );

  const remoteReadingPositionChapter = remoteReadingPosition
    ? chapters.find((chapter) => chapter.id === remoteReadingPosition.chapterId)
    : undefined;

  const goToRemoteReadingPosition = async () => {
    const position = remoteReadingPosition;
    if (!position || !selectedNovel || position.novelId !== selectedNovel.id) return;
    if (!(await readerScreenHandle.goToReadingPosition(position))) {
      setRemoteReadingPosition(undefined);
      showToast('서버 읽기 위치의 화를 찾지 못했습니다.', 'warning');
      return;
    }
    setRemoteReadingPosition(undefined);
    setSyncPanelOpen(false);
    showToast('서버 읽기 위치로 이동했습니다.', 'success');
  };

  const openSelectionNote = (_selection?: ReaderSelection) => {
    setAddonTab('notes');
    setAddonOpen(true);
    revealChrome();
  };

  const startBookAIWorkflow = () => {
    const llmSettings = providerSettingsForScope(providerSettingsBundle, 'llm_labeling');
    const providerId = llmSettings?.defaultProviderId;
    const modelId = providerId ? llmSettings?.modelByProvider[providerId] : undefined;
    const providerOptions = providerId ? llmSettings?.providerOptionsByProvider[providerId] : undefined;
    return bookAIWorkflowController.start({ providerId, modelId, providerOptions });
  };

  const retryBookAIWorkflow = bookAIWorkflowController.retry;
  const cancelBookAIWorkflow = bookAIWorkflowController.cancel;
  const refreshBookAIWorkflowStatus = bookAIWorkflowController.refreshStatus;
  const refreshBookAIWorkflowTTSCacheReadiness = desktopProviderMode
    ? async (silent = false) => {
        const { module, input } = await loadNativeTTSCacheContext();
        return module.refreshNativeTTSCacheReadiness(input, { silent });
      }
    : bookAIWorkflowController.refreshCacheReadiness;

  const resolveDesktopAIProvider = async () => {
    if (!desktopProviderMode) return undefined;
    const llmSettings =
      providerSettingsForScope(providerSettingsBundle, 'llm_labeling') ??
      loadDesktopLocalProviderSettings(platformRuntime.kind).llmLabeling;
    const providerId = llmSettings.defaultProviderId || 'openai';
    const catalogProvider =
      llmProviders.find((provider) => provider.providerId === providerId) ??
      desktopProviderCatalog(providerSecretStatuses, platformRuntime.kind).aiProviders.find(
        (provider) => provider.providerId === providerId,
      );
    if (!catalogProvider || !catalogProviderReady(catalogProvider)) {
      showToast(
        catalogProvider ? `${catalogProvider.displayName} 키를 먼저 저장하세요.` : '기기 로컬 provider를 선택하세요.',
        'warning',
      );
      return undefined;
    }
    if (!desktopLocalLLMProviderIds.has(providerId)) {
      const supported =
        platformRuntime.kind === 'tauri-mobile'
          ? 'OpenAI, Gemini API, Claude API'
          : 'OpenAI, Gemini API, Gemini Vertex, Claude API';
      showToast(
        `기기 로컬 실행은 현재 ${supported}를 지원합니다. Gemini Agent Platform과 Android Vertex 파일 인증은 connected 서버 모드를 사용하세요.`,
        'warning',
      );
      return undefined;
    }
    const modelId = (
      llmSettings.modelByProvider[providerId] ||
      catalogProvider.models.find((model) => model.enabled)?.modelId ||
      ''
    ).trim();
    if (!modelId) {
      showToast(`${catalogProvider.displayName} 모델을 입력하세요.`, 'warning');
      return undefined;
    }
    const providerOptions = llmSettings.providerOptionsByProvider[providerId] ?? {};
    const { DesktopStructuredJsonAIProvider, desktopStructuredJsonProviderName } =
      await import('./providers/desktop-structured-json-provider');
    return {
      providerId,
      modelId,
      providerOptions,
      catalogProvider,
      provider: new DesktopStructuredJsonAIProvider({
        providerId,
        displayName: desktopStructuredJsonProviderName(providerId),
        modelId,
        providerOptions,
      }),
    };
  };

  const createDesktopAnalysisJobState = async (
    type: RemoteProviderJob['type'],
    input: {
      bookId: string;
      chapterId?: string;
      providerId: string;
      modelId: string;
      inputHashMaterial: string;
      progress?: Record<string, unknown>;
    },
  ): Promise<RemoteProviderJob> => {
    const { providerJobId, providerRequestIntegrityHash } = await import('./domain/identity/provider-identities');
    const startedAt = new Date().toISOString();
    const inputHash = providerRequestIntegrityHash(input.inputHashMaterial);
    return {
      id: providerJobId({
        userId: `desktop:${platformRuntime.kind}`,
        novelId: input.bookId,
        chapterId: input.chapterId,
        jobType: type,
        providerId: input.providerId,
        modelId: input.modelId,
        inputHash,
      }),
      novelId: input.bookId,
      chapterId: input.chapterId,
      type,
      providerId: input.providerId,
      modelId: input.modelId,
      inputHash,
      status: 'running',
      stage: 'desktop_local',
      progress: jsonValue({
        source: platformRuntime.kind === 'tauri-mobile' ? 'android_secure_store' : 'desktop_secure_store',
        ...input.progress,
      }),
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
    };
  };

  const completeDesktopAnalysisJobState = (
    execution: AnalysisExecutionToken,
    job: RemoteProviderJob,
    progress?: Record<string, unknown>,
  ): void => {
    const finishedAt = new Date().toISOString();
    analysisExecutionController.publishJob(execution, {
      ...job,
      status: 'succeeded',
      stage: 'completed',
      updatedAt: finishedAt,
      finishedAt,
      progress: jsonValue({
        ...(recordValue(job.progress) ?? {}),
        ...progress,
      }),
    });
  };

  const failDesktopAnalysisJobState = (
    execution: AnalysisExecutionToken,
    job: RemoteProviderJob,
    message: string,
  ): void => {
    const failedAt = new Date().toISOString();
    analysisExecutionController.publishJob(execution, {
      ...job,
      status: 'failed',
      stage: 'failed',
      updatedAt: failedAt,
      finishedAt: failedAt,
      errorMessage: message,
    });
  };

  const runRemoteAnalysisJob = async () => {
    if (!providerApiClient || !selectedNovel || !currentChapter) return;
    const bookId = selectedNovel.id;
    const chapterId = currentChapter.id;
    const llmSettings = providerSettingsForScope(providerSettingsBundle, 'llm_labeling');
    const providerId = llmSettings?.defaultProviderId;
    const modelId = providerId ? llmSettings?.modelByProvider[providerId] : undefined;
    if (
      !(await runConnectedProviderPreflight({
        syncBeforeJob: () => syncConnectedProviderState('before_job'),
        targetStillActive: () => connectedProviderTargetStillActive(bookId, chapterId),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(bookId, [chapterId]),
      }))
    )
      return;
    const execution = analysisExecutionController.begin(bookId, chapterId, { clearJob: true });
    if (!execution) return;
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const { job } = await providerApiClient.enqueueAnalysisJob({ bookId, chapterId, providerId, modelId });
      if (!(await analysisExecutionController.publishRemoteJob(execution, job))) return;
      const finalJob = await analysisExecutionController.pollRemoteJob(execution, job.id);
      if (finalJob.status !== 'succeeded') return;
      if (!(await syncConnectedProviderState('after_job'))) return;
      const [loadedSegments, loadedCharacters, loadedVoiceProfiles, freshNovel] = await Promise.all([
        readerRepository.listSegments(chapterId),
        readerRepository.listCharacters(bookId),
        readerRepository.listVoiceProfiles(bookId),
        readerRepository.getNovel(bookId),
      ]);
      if (activeNovelIdRef.current === bookId && activeChapterIdRef.current === chapterId) {
        setSegmentsState(loadedSegments);
        setCharacters(loadedCharacters);
        setVoiceProfiles(loadedVoiceProfiles);
        if (freshNovel) setSelectedNovel(freshNovel);
        setReaderMode('analysis');
        showToast('서버 AI 분석 결과를 반영했습니다.', 'success');
      }
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      showToast(`서버 AI 분석 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runDesktopAnalysisJob = async () => {
    if (!desktopProviderMode || !selectedNovel || !currentChapter) return;
    const bookId = selectedNovel.id;
    const chapterId = currentChapter.id;
    const resolvedProvider = await resolveDesktopAIProvider();
    if (!resolvedProvider) return;
    const { providerId, modelId, providerOptions, provider } = resolvedProvider;
    const job = await createDesktopAnalysisJobState('chapter_segment_labeling', {
      bookId,
      chapterId,
      providerId,
      modelId,
      inputHashMaterial: `${chapterId}:${currentChapter.textHash}:${providerId}:${modelId}:${JSON.stringify(providerOptions)}`,
    });
    const execution = analysisExecutionController.begin(bookId, chapterId, { clearJob: true });
    if (!execution) return;
    analysisExecutionController.publishJob(execution, job);
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const [validationRuntime, analysisContext] = await Promise.all([
        import('./features/ai/chapter-labeling-validation-runtime'),
        import('./features/ai/analysis-paragraph-source').then((module) =>
          module.loadChapterAnalysisContext(readerRepository, bookId, chapterId, execution.controller.signal),
        ),
      ]);
      const { paragraphs: analysisParagraphs, knownCharacters, characterRelations, userCorrections } = analysisContext;
      const characterGraph = { novelId: bookId, characters: knownCharacters, relations: characterRelations };
      const validationPolicy = validationRuntime.resolveChapterLabelingRequestProfile(providerOptions).validationPolicy;
      const expectedSegmentsRevision = chapterSegmentsRevision(segments);
      const expectedGraphRevision = characterGraphRevision(knownCharacters, characterRelations);
      if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let result = await provider.labelChapterSegments({
        novelId: bookId,
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        knownCharacters,
        characterGraph,
        userCorrections,
        signal: execution.controller.signal,
      });
      if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let validation = validationRuntime.validateChapterLabelingResult({
        novelId: bookId,
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        knownCharacters,
        characterGraph,
        userCorrections,
        validationPolicy,
        result,
      });
      let quality = validationRuntime.validateChapterLabelingQuality({
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        result,
      });
      const autoRepairValue = providerOptions.autoRepairOnValidationFailure;
      const autoRepairEnabled =
        autoRepairValue === true ||
        (typeof autoRepairValue === 'string' &&
          ['1', 'true', 'yes', 'on'].includes(autoRepairValue.trim().toLowerCase()));
      if ((!validation.ok || !quality.ok) && autoRepairEnabled && provider.repairChapterLabels) {
        result = await provider.repairChapterLabels({
          novelId: bookId,
          chapter: currentChapter,
          paragraphs: analysisParagraphs,
          knownCharacters,
          characterGraph,
          userCorrections,
          existingResult: result,
          validationIssues: [...validation.issues, ...quality.issues],
          signal: execution.controller.signal,
        });
        if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        validation = validationRuntime.validateChapterLabelingResult({
          novelId: bookId,
          chapter: currentChapter,
          paragraphs: analysisParagraphs,
          knownCharacters,
          characterGraph,
          userCorrections,
          validationPolicy,
          result,
        });
        quality = validationRuntime.validateChapterLabelingQuality({
          chapter: currentChapter,
          paragraphs: analysisParagraphs,
          result,
        });
      }
      if (!validation.ok) {
        throw new Error(validationRuntime.chapterLabelingValidationErrorMessage(validation));
      }
      if (!quality.ok) {
        throw new Error(validationRuntime.chapterLabelingQualityErrorMessage(quality));
      }
      await readerRepository.saveSegments(chapterId, result.segments, {
        expectedRevision: expectedSegmentsRevision,
      });
      if (result.characters.length > 0) {
        await readerRepository.saveCharacters(bookId, result.characters, { expectedRevision: expectedGraphRevision });
      }
      const nextCharacters = result.characters.length > 0 ? result.characters : knownCharacters;
      const nextNovel = { ...selectedNovel, analysisStatus: 'ready' as const, updatedAt: new Date().toISOString() };
      await readerRepository.patchNovelMetadata(bookId, { analysisStatus: nextNovel.analysisStatus });
      await refreshAfterLocalMutation('aiTts');
      if (activeNovelIdRef.current === bookId && activeChapterIdRef.current === chapterId) {
        setSegmentsState(result.segments);
        setCharacters(nextCharacters);
        setSelectedNovel(nextNovel);
        setReaderMode('analysis');
        completeDesktopAnalysisJobState(execution, job, {
          segmentCount: result.segments.length,
          characterCount: result.characters.length,
          validation: validation.summary,
          quality: quality.summary,
          relationCount: characterRelations.length,
          correctionCount: userCorrections.length,
        });
        showToast('Desktop AI 라벨링 결과를 반영했습니다.', 'success');
      }
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      failDesktopAnalysisJobState(execution, job, message);
      showToast(`Desktop AI 분석 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runDesktopLabelRepairJob = async () => {
    if (!desktopProviderMode || !selectedNovel || !currentChapter || segments.length === 0) return;
    const bookId = selectedNovel.id;
    const chapterId = currentChapter.id;
    const resolvedProvider = await resolveDesktopAIProvider();
    if (!resolvedProvider) return;
    const { providerId, modelId, providerOptions, provider } = resolvedProvider;
    if (!provider.repairChapterLabels) {
      showToast(
        `${resolvedProvider.catalogProvider.displayName}는 Desktop 라벨 repair를 지원하지 않습니다.`,
        'warning',
      );
      return;
    }
    const job = await createDesktopAnalysisJobState('chapter_label_repair', {
      bookId,
      chapterId,
      providerId,
      modelId,
      inputHashMaterial: `${chapterId}:${currentChapter.textHash}:${segments.map((segment) => segment.id).join(':')}:${providerId}:${modelId}:${JSON.stringify(providerOptions)}`,
    });
    const execution = analysisExecutionController.begin(bookId, chapterId, { clearJob: true });
    if (!execution) return;
    analysisExecutionController.publishJob(execution, job);
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const [validationRuntime, analysisContext] = await Promise.all([
        import('./features/ai/chapter-labeling-validation-runtime'),
        import('./features/ai/analysis-paragraph-source').then((module) =>
          module.loadChapterAnalysisContext(readerRepository, bookId, chapterId, execution.controller.signal),
        ),
      ]);
      const { paragraphs: analysisParagraphs, knownCharacters, characterRelations, userCorrections } = analysisContext;
      const characterGraph = { novelId: bookId, characters: knownCharacters, relations: characterRelations };
      const expectedSegmentsRevision = chapterSegmentsRevision(segments);
      const expectedGraphRevision = characterGraphRevision(knownCharacters, characterRelations);
      const existingResult = { characters: knownCharacters, segments };
      const inputValidation = validationRuntime.validateChapterLabelingResult({
        novelId: bookId,
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        knownCharacters,
        characterGraph,
        userCorrections,
        validationPolicy: 'strict_tts',
        result: existingResult,
      });
      const inputQuality = validationRuntime.validateChapterLabelingQuality({
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        result: existingResult,
      });
      let result = existingResult;
      if (!inputValidation.ok || !inputQuality.ok) {
        result = await provider.repairChapterLabels({
          novelId: bookId,
          chapter: currentChapter,
          paragraphs: analysisParagraphs,
          knownCharacters,
          characterGraph,
          userCorrections,
          existingResult,
          validationIssues: [...inputValidation.issues, ...inputQuality.issues],
          signal: execution.controller.signal,
        });
      }
      if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const validation = validationRuntime.validateChapterLabelingResult({
        novelId: bookId,
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        knownCharacters,
        characterGraph,
        userCorrections,
        validationPolicy: 'strict_tts',
        result,
      });
      const quality = validationRuntime.validateChapterLabelingQuality({
        chapter: currentChapter,
        paragraphs: analysisParagraphs,
        result,
      });
      if (!validation.ok) {
        throw new Error(validationRuntime.chapterLabelingValidationErrorMessage(validation));
      }
      if (!quality.ok) {
        throw new Error(validationRuntime.chapterLabelingQualityErrorMessage(quality));
      }
      await readerRepository.saveSegments(chapterId, result.segments, {
        expectedRevision: expectedSegmentsRevision,
      });
      if (result.characters.length > 0) {
        await readerRepository.saveCharacters(bookId, result.characters, { expectedRevision: expectedGraphRevision });
      }
      await refreshAfterLocalMutation('aiTts');
      const freshNovel = await readerRepository.getNovel(bookId);
      if (activeNovelIdRef.current === bookId && activeChapterIdRef.current === chapterId) {
        setSegmentsState(result.segments);
        setCharacters(result.characters.length > 0 ? result.characters : knownCharacters);
        if (freshNovel) setSelectedNovel(freshNovel);
        setReaderMode('analysis');
        completeDesktopAnalysisJobState(execution, job, {
          segmentCount: result.segments.length,
          characterCount: result.characters.length,
          inputValidation: inputValidation.summary,
          inputQuality: inputQuality.summary,
          validation: validation.summary,
          quality: quality.summary,
          relationCount: characterRelations.length,
          correctionCount: userCorrections.length,
          repaired: !inputValidation.ok || !inputQuality.ok,
        });
        showToast(
          !inputValidation.ok || !inputQuality.ok
            ? 'Desktop 라벨 repair 결과를 반영했습니다.'
            : '현재 라벨은 repair가 필요한 오류 없이 검증됐습니다.',
          'success',
        );
      }
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      failDesktopAnalysisJobState(execution, job, message);
      showToast(`Desktop 라벨 repair 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runDesktopBundleAnalysisJob = async () => {
    if (!desktopProviderMode || !selectedNovel || !currentChapter || bundleAnalysisChapters.length === 0) return;
    const bookId = selectedNovel.id;
    const chapterIds = bundleAnalysisChapters.map((chapter) => chapter.id);
    const resolvedProvider = await resolveDesktopAIProvider();
    if (!resolvedProvider) return;
    const { providerId, modelId, providerOptions, provider } = resolvedProvider;
    if (!provider.analyzeCharacterBundle) {
      showToast(
        `${resolvedProvider.catalogProvider.displayName}는 Desktop 묶음 인물 분석을 지원하지 않습니다.`,
        'warning',
      );
      return;
    }
    const bundleId = characterAnalysisBundleId(bookId, chapterIds);
    const job = await createDesktopAnalysisJobState('character_bundle_analysis', {
      bookId,
      providerId,
      modelId,
      inputHashMaterial: `${bookId}:${chapterIds.join(':')}:${providerId}:${modelId}:${JSON.stringify(providerOptions)}`,
      progress: {
        bundleId,
        sourceChapterIds: chapterIds,
      },
    });
    const execution = analysisExecutionController.begin(bookId, currentChapter.id, {
      clearJob: true,
      clearBundleJob: true,
    });
    if (!execution) return;
    analysisExecutionController.publishJob(execution, job);
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const { existingCharacters, existingRelations, userCorrections, chapterSources } =
        await import('./features/ai/analysis-paragraph-source').then((module) =>
          module.loadBundleAnalysisContext(
            readerRepository,
            bookId,
            bundleAnalysisChapters,
            execution.controller.signal,
          ),
        );
      if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await provider.analyzeCharacterBundle({
        novelId: bookId,
        bundleId,
        chapters: chapterSources,
        existingGraph: {
          novelId: bookId,
          characters: existingCharacters,
          relations: existingRelations,
        },
        previousBundleSummary: lastBundleAnalysisSummary.bundleSummaryForNext,
        userCorrections,
        signal: execution.controller.signal,
      });
      if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const finishedJob: RemoteProviderJob = {
        ...job,
        status: 'succeeded',
        stage: 'completed',
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        progress: jsonValue({
          ...(recordValue(job.progress) ?? {}),
          sourceContext: {
            bundleId,
            sourceChapterIds: result.sourceChapterIds,
            entryChapterId: currentChapter.id,
          },
          discoveredGraph: result.discoveredGraph,
          discoveredCharacterCount: result.discoveredGraph.characters.length,
          discoveredRelationCount: result.discoveredGraph.relations.length,
          bundleSummaryForNext: result.bundleSummaryForNext,
          correctionCount: userCorrections.length,
        }),
      };
      analysisExecutionController.publishJob(execution, finishedJob);
      analysisExecutionController.publishBundleJob(execution, finishedJob);
      showToast(
        `Desktop 묶음 분석 완료: 후보 ${result.discoveredGraph.characters.length}명, 관계 ${result.discoveredGraph.relations.length}개`,
        'success',
      );
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      failDesktopAnalysisJobState(execution, job, message);
      showToast(`Desktop 묶음 인물 분석 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runDesktopGraphMergeJob = async () => {
    if (!desktopProviderMode || !selectedNovel || !lastBundleAnalysisJob) return;
    const bookId = selectedNovel.id;
    const summary = bundleAnalysisJobSummary(lastBundleAnalysisJob);
    if (!summary.discoveredGraph) {
      showToast('병합할 후보 그래프가 없습니다. 먼저 묶음 인물 분석을 완료하세요.', 'warning');
      return;
    }
    if (!graphReview || graphReview.parseError) {
      showToast(
        `후보 그래프를 읽을 수 없습니다${graphReview?.parseError ? `: ${graphReview.parseError}` : '.'}`,
        'warning',
      );
      return;
    }
    if (graphReview.reviewedGraph.characters.length === 0) {
      showToast('병합할 후보가 모두 제외되었습니다.', 'warning');
      return;
    }
    const resolvedProvider = await resolveDesktopAIProvider();
    if (!resolvedProvider) return;
    const { providerId, modelId, providerOptions, provider } = resolvedProvider;
    if (!provider.mergeCharacterGraph) {
      showToast(`${resolvedProvider.catalogProvider.displayName}는 Desktop 후보 병합을 지원하지 않습니다.`, 'warning');
      return;
    }
    const job = await createDesktopAnalysisJobState('character_graph_merge', {
      bookId,
      providerId,
      modelId,
      inputHashMaterial: `${bookId}:${lastBundleAnalysisJob.id}:${providerId}:${modelId}:${JSON.stringify(providerOptions)}:${JSON.stringify(graphReview.reviewedGraph)}`,
    });
    const execution = analysisExecutionController.begin(bookId, currentChapter?.id, { clearJob: true });
    if (!execution) return;
    analysisExecutionController.publishJob(execution, job);
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const [existingCharacters, existingRelations, userCorrections] = await Promise.all([
        readerRepository.listCharacters(bookId),
        readerRepository.listCharacterRelations(bookId),
        readerRepository.listCorrections(bookId),
      ]);
      const sourceBundleId =
        summary.bundleId ??
        (typeof summary.sourceContext?.bundleId === 'string' ? summary.sourceContext.bundleId : undefined) ??
        lastBundleAnalysisJob.id;
      const sourceContext = {
        bundleId: sourceBundleId,
        chapterIds: summary.sourceChapterIds,
        summary: summary.bundleSummaryForNext,
      };
      const existingGraph: CharacterGraph = {
        novelId: bookId,
        characters: existingCharacters,
        relations: existingRelations,
      };
      const expectedGraphRevision = characterGraphRevision(existingCharacters, existingRelations);
      const graph = await provider.mergeCharacterGraph({
        novelId: bookId,
        existingGraph,
        discoveredGraph: graphReview.reviewedGraph,
        sourceContext,
        userCorrections,
        signal: execution.controller.signal,
      });
      if (execution.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await readerRepository.saveCharacterGraph(bookId, graph, { expectedRevision: expectedGraphRevision });
      await refreshAfterLocalMutation('aiTts');
      if (activeNovelIdRef.current === bookId) {
        setCharacters(graph.characters);
        const loadedVoiceProfiles = await readerRepository.listVoiceProfiles(bookId);
        setVoiceProfiles(loadedVoiceProfiles);
        const freshNovel = await readerRepository.getNovel(bookId);
        if (freshNovel) setSelectedNovel(freshNovel);
        completeDesktopAnalysisJobState(execution, job, {
          characterCount: graph.characters.length,
          relationCount: graph.relations.length,
          correctionCount: userCorrections.length,
          sourceContext,
        });
        showToast('Desktop 후보 그래프를 등장인물 목록에 병합했습니다.', 'success');
      }
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      failDesktopAnalysisJobState(execution, job, message);
      showToast(`Desktop 등장인물 그래프 병합 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runRemoteLabelRepairJob = async () => {
    if (!providerApiClient || !selectedNovel || !currentChapter || segments.length === 0) return;
    const bookId = selectedNovel.id;
    const chapterId = currentChapter.id;
    const llmSettings = providerSettingsForScope(providerSettingsBundle, 'llm_labeling');
    const providerId = llmSettings?.defaultProviderId;
    const modelId = providerId ? llmSettings?.modelByProvider[providerId] : undefined;
    if (
      !(await runConnectedProviderPreflight({
        syncBeforeJob: () => syncConnectedProviderState('before_job'),
        targetStillActive: () => connectedProviderTargetStillActive(bookId, chapterId),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(bookId, [chapterId]),
      }))
    )
      return;
    const execution = analysisExecutionController.begin(bookId, chapterId, { clearJob: true });
    if (!execution) return;
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const { job } = await providerApiClient.enqueueAnalysisJob({
        bookId,
        chapterId,
        providerId,
        modelId,
        jobType: 'chapter_label_repair',
      });
      if (!(await analysisExecutionController.publishRemoteJob(execution, job))) return;
      const finalJob = await analysisExecutionController.pollRemoteJob(execution, job.id);
      if (finalJob.status !== 'succeeded') return;
      if (!(await syncConnectedProviderState('after_job'))) return;
      const [loadedSegments, loadedCharacters, loadedVoiceProfiles, freshNovel] = await Promise.all([
        readerRepository.listSegments(chapterId),
        readerRepository.listCharacters(bookId),
        readerRepository.listVoiceProfiles(bookId),
        readerRepository.getNovel(bookId),
      ]);
      if (activeNovelIdRef.current === bookId && activeChapterIdRef.current === chapterId) {
        setSegmentsState(loadedSegments);
        setCharacters(loadedCharacters);
        setVoiceProfiles(loadedVoiceProfiles);
        if (freshNovel) setSelectedNovel(freshNovel);
        setReaderMode('analysis');
        showToast('현재 화 라벨을 재검증하고 repair 결과를 반영했습니다.', 'success');
      }
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      showToast(`라벨 repair 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runRemoteBundleAnalysisJob = async () => {
    if (!providerApiClient || !selectedNovel || !currentChapter || bundleAnalysisChapters.length === 0) return;
    const bookId = selectedNovel.id;
    const chapterIds = bundleAnalysisChapters.map((chapter) => chapter.id);
    const llmSettings = providerSettingsForScope(providerSettingsBundle, 'llm_labeling');
    const providerId = llmSettings?.defaultProviderId;
    const modelId = providerId ? llmSettings?.modelByProvider[providerId] : undefined;
    const bundleId = characterAnalysisBundleId(bookId, chapterIds);
    if (
      !(await runConnectedProviderPreflight({
        syncBeforeJob: () => syncConnectedProviderState('before_job'),
        targetStillActive: () => connectedProviderTargetStillActive(bookId, currentChapter.id),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(bookId, chapterIds),
      }))
    )
      return;
    const execution = analysisExecutionController.begin(bookId, currentChapter.id, {
      clearJob: true,
      clearBundleJob: true,
    });
    if (!execution) return;
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const { job } = await providerApiClient.enqueueAnalysisJob({
        bookId,
        chapterIds,
        providerId,
        modelId,
        jobType: 'character_bundle_analysis',
        sourceContext: {
          bundleId,
          sourceChapterIds: chapterIds,
          entryChapterId: currentChapter.id,
        },
      });
      if (!(await analysisExecutionController.publishRemoteJob(execution, job))) return;
      const finalJob = await analysisExecutionController.pollRemoteJob(execution, job.id);
      if (finalJob.status !== 'succeeded') return;
      if (!(await syncConnectedProviderState('after_job'))) return;
      const summary = bundleAnalysisJobSummary(finalJob);
      analysisExecutionController.publishBundleJob(execution, finalJob);
      const freshNovel = await readerRepository.getNovel(bookId);
      if (activeNovelIdRef.current === bookId && freshNovel) setSelectedNovel(freshNovel);
      showToast(
        `묶음 분석 완료: 후보 ${summary.discoveredCharacterCount ?? 0}명, 관계 ${summary.discoveredRelationCount ?? 0}개`,
        'success',
      );
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      showToast(`묶음 인물 분석 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runRemoteGraphMergeJob = async () => {
    if (!providerApiClient || !selectedNovel || !lastBundleAnalysisJob) return;
    const bookId = selectedNovel.id;
    const summary = bundleAnalysisJobSummary(lastBundleAnalysisJob);
    if (!summary.discoveredGraph) {
      showToast('병합할 후보 그래프가 없습니다. 먼저 묶음 인물 분석을 완료하세요.', 'warning');
      return;
    }
    if (!graphReview || graphReview.parseError) {
      showToast(
        `후보 그래프를 읽을 수 없습니다${graphReview?.parseError ? `: ${graphReview.parseError}` : '.'}`,
        'warning',
      );
      return;
    }
    if (graphReview.reviewedGraph.characters.length === 0) {
      showToast('병합할 후보가 모두 제외되었습니다.', 'warning');
      return;
    }
    const llmSettings = providerSettingsForScope(providerSettingsBundle, 'llm_labeling');
    const providerId = llmSettings?.defaultProviderId;
    const modelId = providerId ? llmSettings?.modelByProvider[providerId] : undefined;
    if (
      !(await runConnectedProviderPreflight({
        syncBeforeJob: () => syncConnectedProviderState('before_job'),
        targetStillActive: () => connectedProviderTargetStillActive(bookId),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(bookId),
      }))
    )
      return;
    const execution = analysisExecutionController.begin(bookId, currentChapter?.id, { clearJob: true });
    if (!execution) return;
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    try {
      const { job } = await providerApiClient.enqueueAnalysisJob({
        bookId,
        providerId,
        modelId,
        jobType: 'character_graph_merge',
        discoveredGraph: graphReview.reviewedGraph,
        sourceContext: {
          ...summary.sourceContext,
          bundleId: summary.bundleId ?? summary.sourceContext?.bundleId ?? lastBundleAnalysisJob.id,
          chapterIds: summary.sourceChapterIds,
          sourceChapterIds: summary.sourceChapterIds,
          summary: summary.bundleSummaryForNext,
          bundleSummaryForNext: summary.bundleSummaryForNext,
          sourceJobId: lastBundleAnalysisJob.id,
          graphReview: {
            excludedCharacterIds: [...graphReviewExcludedCharacterIds],
            includedCharacterCount: graphReview.reviewedGraph.characters.length,
            includedRelationCount: graphReview.reviewedGraph.relations.length,
            invalidRelationCount: graphReview.invalidRelationCount,
          },
        },
      });
      if (!(await analysisExecutionController.publishRemoteJob(execution, job))) return;
      const finalJob = await analysisExecutionController.pollRemoteJob(execution, job.id);
      if (finalJob.status !== 'succeeded') return;
      if (!(await syncConnectedProviderState('after_job'))) return;
      const [loadedCharacters, loadedVoiceProfiles, freshNovel] = await Promise.all([
        readerRepository.listCharacters(bookId),
        readerRepository.listVoiceProfiles(bookId),
        readerRepository.getNovel(bookId),
      ]);
      if (activeNovelIdRef.current === bookId) {
        setCharacters(loadedCharacters);
        setVoiceProfiles(loadedVoiceProfiles);
        if (freshNovel) setSelectedNovel(freshNovel);
        showToast('후보 그래프를 등장인물 목록에 병합했습니다.', 'success');
      }
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      showToast(`등장인물 그래프 병합 실패: ${message}`, 'danger');
    } finally {
      analysisExecutionController.finish(execution);
    }
  };

  const runMockAnalysis = async () => {
    if (!selectedNovel || !currentChapter) return;
    const analysisParagraphs = await import('./features/ai/analysis-paragraph-source').then((module) =>
      module.loadPinnedAnalysisParagraphs(
        readerRepository,
        selectedNovel.id,
        currentChapter.id,
        new AbortController().signal,
      ),
    );
    const expectedSegmentsRevision = chapterSegmentsRevision(segments);
    const existingRelations = await readerRepository.listCharacterRelations(selectedNovel.id);
    const expectedGraphRevision = characterGraphRevision(characters, existingRelations);
    const result = await aiProvider.labelChapterSegments({
      novelId: selectedNovel.id,
      chapter: currentChapter,
      paragraphs: analysisParagraphs,
    });
    await readerRepository.saveSegments(currentChapter.id, result.segments, {
      expectedRevision: expectedSegmentsRevision,
    });
    await readerRepository.saveCharacters(selectedNovel.id, result.characters, {
      expectedRevision: expectedGraphRevision,
    });
    setSegmentsState(result.segments);
    setCharacters(result.characters);
    const nextNovel = { ...selectedNovel, analysisStatus: 'mock_ready' as const };
    await readerRepository.patchNovelMetadata(selectedNovel.id, { analysisStatus: nextNovel.analysisStatus });
    await refreshAfterLocalMutation('aiTts');
    setSelectedNovel(nextNovel);
    setReaderMode('analysis');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    showToast('로컬 Mock 분석 결과를 표시했습니다. 외부 요청은 없습니다.', 'success');
  };

  const selectCorrectionSegment = (segment: LabeledSegment) => {
    setCorrectionTarget(segment);
    setCorrectionSpeakerDraft(segment.speakerId);
    setCorrectionEmotionDraft(segment.emotion || 'neutral');
    setAddonOpen(true);
    setAddonTab(MOYA_AI_ADDON_ID);
    setReaderMode('correction');
  };

  const toggleGraphReviewCandidate = (characterId: string) => {
    setGraphReviewExcludedCharacterIds((previous) => {
      const next = new Set(previous);
      if (next.has(characterId)) {
        next.delete(characterId);
      } else {
        next.add(characterId);
      }
      return next;
    });
  };

  const segmentSnippet = (segment: LabeledSegment): string => {
    const paragraph = cachedParagraphById(segment.paragraphId);
    const text = paragraph?.text.slice(segment.startOffset, segment.endOffset).trim();
    return text || segment.evidence || segment.id;
  };

  const applyCorrectionDraft = async () => {
    if (!selectedNovel || !currentChapter || !correctionTarget) return;
    const nextSpeakerId = correctionSpeakerDraft.trim() || 'unknown';
    const nextEmotion = correctionEmotionDraft.trim() || 'neutral';
    const speakerChanged = nextSpeakerId !== correctionTarget.speakerId;
    const speakerConfirmed = speakerChanged || correctionReviewSegmentIds.has(correctionTarget.id);
    const emotionChanged = nextEmotion !== (correctionTarget.emotion || 'neutral');
    if (!speakerConfirmed && !emotionChanged) {
      showToast('변경된 라벨이 없습니다.', 'warning');
      return;
    }
    const correctedSegment = applyLabelCorrection({
      segment: correctionTarget,
      speakerId: nextSpeakerId,
      emotion: nextEmotion,
      confirmSpeaker: speakerConfirmed,
    });
    const nextSegments = segments.map((segment) => (segment.id === correctionTarget.id ? correctedSegment : segment));
    const createdAt = new Date().toISOString();
    try {
      const currentCorrections = await readerRepository.listCorrections(selectedNovel.id);
      const sourceWindow = activeBookAIWorkflowPlan?.labelingWindows.find((window) =>
        window.paragraphIds.includes(correctionTarget.paragraphId),
      );
      await readerRepository.applyLabelCorrections({
        operationId: persistentId128('label_mutation_operation', [selectedNovel.id, correctionTarget.id, createdAt]),
        bookId: selectedNovel.id,
        chapterId: currentChapter.id,
        createdAt,
        expected: {
          contentRevisionId: selectedNovel.activeContentRevisionId ?? 'legacy',
          correctionRevisionId: correctionsRevision(currentCorrections),
          segmentCollectionRevision: chapterSegmentsRevision(segments),
        },
        edits: [
          {
            segmentId: correctionTarget.id,
            expectedSegmentHash: labelMutationSegmentHash(correctionTarget),
            patch: {
              ...(speakerConfirmed ? { speakerId: nextSpeakerId } : {}),
              ...(emotionChanged ? { emotion: nextEmotion } : {}),
            },
            intent:
              correctionScope === 'future_pattern'
                ? {
                    kind: 'relabel_from_window',
                    windowId: sourceWindow?.id ?? `chapter:${currentChapter.id}`,
                  }
                : { kind: 'segment_only' },
          },
        ],
      });
      await refreshAfterLocalMutation('aiTts');
    } catch (error) {
      console.error(error);
      showToast('라벨 교정 저장에 실패했습니다.', 'danger');
      return;
    }
    setSegmentsState(nextSegments);
    const remainingReviewItems = buildLabelCorrectionReviewItems({ segments: nextSegments });
    const nextTarget =
      remainingReviewItems.find((item) => item.segment.segmentIndex > correctionTarget.segmentIndex)?.segment ??
      remainingReviewItems[0]?.segment;
    if (nextTarget) {
      selectCorrectionSegment(nextTarget);
    } else {
      setCorrectionTarget(undefined);
    }
    showToast('라벨 교정을 저장했습니다.', 'success');
  };

  const voiceProfileMatchesTarget = (
    profile: VoiceProfile,
    target: { role: VoiceProfile['role']; characterId?: string },
  ) =>
    profile.role === target.role &&
    (target.characterId ? profile.characterId === target.characterId : !profile.characterId);

  const saveSystemVoiceProfile = async (
    target: { role: VoiceProfile['role']; characterId?: string; label: string },
    providerVoiceId: string,
  ) => {
    if (!selectedNovel) return;
    const novelId = selectedNovel.id;
    const previousProfiles = voiceProfilesRef.current;
    const existing = previousProfiles.find(
      (profile) => profile.providerId === 'system' && voiceProfileMatchesTarget(profile, target),
    );
    const nextProfiles = previousProfiles.filter(
      (profile) => !(profile.providerId === 'system' && voiceProfileMatchesTarget(profile, target)),
    );
    if (providerVoiceId) {
      const voice = voices.find((item) => item.id === providerVoiceId);
      const profile: VoiceProfile = {
        ...(existing ?? {}),
        id:
          existing?.id ??
          voiceProfileId({
            novelId,
            role: target.role,
            characterId: target.characterId,
            providerId: 'system',
          }),
        novelId,
        characterId: target.characterId,
        role: target.role,
        providerId: 'system',
        providerVoiceId,
        label: `${target.label} · ${voice?.label ?? providerVoiceId}`,
        language: voice?.lang,
        speed: existing?.speed ?? 1,
        providerOptions: existing?.providerOptions ?? {},
        isUserSelected: true,
      };
      nextProfiles.push(profile);
    }
    const saveVersion = voiceProfileSaveVersionRef.current + 1;
    voiceProfileSaveVersionRef.current = saveVersion;
    voiceProfilesRef.current = nextProfiles;
    setVoiceProfiles(nextProfiles);
    const saveTask = voiceProfileSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await readerRepository.saveVoiceProfiles(novelId, nextProfiles, {
          expectedRevision: voiceProfilesRevision(previousProfiles),
        });
        await refreshAfterLocalMutation('aiTts');
      });
    voiceProfileSaveQueueRef.current = saveTask.catch(() => undefined);
    try {
      await saveTask;
      await voiceProductController.reconcileUserVoiceProfiles(nextProfiles).catch((error) => {
        showToast(error instanceof Error ? error.message : '화자 음성 배정을 갱신하지 못했습니다.', 'warning');
      });
      bookAIWorkflowController.invalidateTTSReadiness();
      if (saveVersion === voiceProfileSaveVersionRef.current) {
        showToast(
          providerVoiceId ? `${target.label} 음성을 저장했습니다.` : `${target.label} 음성 지정을 해제했습니다.`,
          'success',
        );
      }
    } catch {
      if (saveVersion === voiceProfileSaveVersionRef.current) {
        const restoredProfiles = await readerRepository.listVoiceProfiles(novelId).catch(() => previousProfiles);
        voiceProfilesRef.current = restoredProfiles;
        setVoiceProfiles(restoredProfiles);
      }
      showToast(`${target.label} 음성을 저장하지 못했습니다.`, 'warning');
    }
  };

  const saveHostedVoiceProfile = async (
    target: { role: VoiceProfile['role']; characterId?: string; label: string },
    providerVoiceId: string,
  ) => {
    if (!selectedNovel || !selectedHostedTTSProvider) return;
    const providerId = selectedHostedTTSProvider.providerId;
    const novelId = selectedNovel.id;
    const previousProfiles = voiceProfilesRef.current;
    const existing = previousProfiles.find(
      (profile) => profile.providerId === providerId && voiceProfileMatchesTarget(profile, target),
    );
    const nextProfiles = previousProfiles.filter(
      (profile) => !(profile.providerId === providerId && voiceProfileMatchesTarget(profile, target)),
    );
    const trimmedVoiceId = providerVoiceId.trim();
    if ((existing?.providerVoiceId ?? '') === trimmedVoiceId) return;
    if (trimmedVoiceId) {
      const profile: VoiceProfile = {
        ...(existing ?? {}),
        id:
          existing?.id ??
          voiceProfileId({
            novelId,
            role: target.role,
            characterId: target.characterId,
            providerId,
          }),
        novelId,
        characterId: target.characterId,
        role: target.role,
        providerId,
        providerVoiceId: trimmedVoiceId,
        providerModel: savedTTSSettings?.modelByProvider[providerId],
        label: `${target.label} · ${selectedHostedTTSProvider.displayName} ${trimmedVoiceId}`,
        speed: existing?.speed ?? 1,
        providerOptions: existing?.providerOptions ?? {},
        isUserSelected: true,
      };
      nextProfiles.push(profile);
    }
    const saveVersion = voiceProfileSaveVersionRef.current + 1;
    voiceProfileSaveVersionRef.current = saveVersion;
    voiceProfilesRef.current = nextProfiles;
    setVoiceProfiles(nextProfiles);
    const saveTask = voiceProfileSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await readerRepository.saveVoiceProfiles(novelId, nextProfiles, {
          expectedRevision: voiceProfilesRevision(previousProfiles),
        });
        await refreshAfterLocalMutation('aiTts');
      });
    voiceProfileSaveQueueRef.current = saveTask.catch(() => undefined);
    try {
      await saveTask;
      await voiceProductController.reconcileUserVoiceProfiles(nextProfiles).catch((error) => {
        showToast(error instanceof Error ? error.message : '화자 음성 배정을 갱신하지 못했습니다.', 'warning');
      });
      bookAIWorkflowController.invalidateTTSReadiness();
      if (saveVersion === voiceProfileSaveVersionRef.current) {
        showToast(
          trimmedVoiceId
            ? `${target.label} hosted 음성을 저장했습니다.`
            : `${target.label} hosted 음성 지정을 해제했습니다.`,
          'success',
        );
      }
    } catch {
      if (saveVersion === voiceProfileSaveVersionRef.current) {
        const restoredProfiles = await readerRepository.listVoiceProfiles(novelId).catch(() => previousProfiles);
        voiceProfilesRef.current = restoredProfiles;
        setVoiceProfiles(restoredProfiles);
      }
      showToast(`${target.label} hosted 음성을 저장하지 못했습니다.`, 'warning');
    }
  };

  const saveHostedVoiceProfileOption = async (
    target: { role: VoiceProfile['role']; characterId?: string; label: string },
    option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
    value: string | number | boolean | undefined,
  ) => {
    if (!selectedNovel || !selectedHostedTTSProvider) return;
    const providerId = selectedHostedTTSProvider.providerId;
    const novelId = selectedNovel.id;
    const previousProfiles = voiceProfilesRef.current;
    const existing = previousProfiles.find(
      (profile) => profile.providerId === providerId && voiceProfileMatchesTarget(profile, target),
    );
    const nextProviderOptions = setProviderOptionInRecord(existing?.providerOptions, option, value);
    if (!existing && Object.keys(nextProviderOptions).length === 0) return;
    if (providerOptionsContainSecretLikeValue(nextProviderOptions)) {
      showToast('Voice profile 옵션에는 API key, token, credential 값을 저장할 수 없습니다.', 'warning');
      return;
    }
    if (JSON.stringify(existing?.providerOptions ?? {}) === JSON.stringify(nextProviderOptions)) return;
    const { defaultHostedVoiceId } = await import('./providers/hosted-voice-default');
    const providerVoiceId = existing?.providerVoiceId?.trim() || defaultHostedVoiceId(providerId, savedTTSSettings);
    const nextProfiles = previousProfiles.filter(
      (profile) => !(profile.providerId === providerId && voiceProfileMatchesTarget(profile, target)),
    );
    const profile: VoiceProfile = {
      ...(existing ?? {}),
      id:
        existing?.id ??
        voiceProfileId({
          novelId,
          role: target.role,
          characterId: target.characterId,
          providerId,
        }),
      novelId,
      characterId: target.characterId,
      role: target.role,
      providerId,
      providerVoiceId,
      providerModel: savedTTSSettings?.modelByProvider[providerId],
      label: `${target.label} - ${selectedHostedTTSProvider.displayName} ${providerVoiceId}`,
      speed: existing?.speed ?? 1,
      providerOptions: nextProviderOptions,
      isUserSelected: true,
    };
    nextProfiles.push(profile);

    const saveVersion = voiceProfileSaveVersionRef.current + 1;
    voiceProfileSaveVersionRef.current = saveVersion;
    voiceProfilesRef.current = nextProfiles;
    setVoiceProfiles(nextProfiles);
    const saveTask = voiceProfileSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await readerRepository.saveVoiceProfiles(novelId, nextProfiles, {
          expectedRevision: voiceProfilesRevision(previousProfiles),
        });
        await refreshAfterLocalMutation('aiTts');
      });
    voiceProfileSaveQueueRef.current = saveTask.catch(() => undefined);
    try {
      await saveTask;
      await voiceProductController.reconcileUserVoiceProfiles(nextProfiles).catch((error) => {
        showToast(error instanceof Error ? error.message : '화자 음성 배정을 갱신하지 못했습니다.', 'warning');
      });
      bookAIWorkflowController.invalidateTTSReadiness();
      if (saveVersion === voiceProfileSaveVersionRef.current) {
        showToast(`${target.label} hosted voice 옵션을 저장했습니다.`, 'success');
      }
    } catch {
      if (saveVersion === voiceProfileSaveVersionRef.current) {
        const restoredProfiles = await readerRepository.listVoiceProfiles(novelId).catch(() => previousProfiles);
        voiceProfilesRef.current = restoredProfiles;
        setVoiceProfiles(restoredProfiles);
      }
      showToast(`${target.label} hosted voice 옵션을 저장하지 못했습니다.`, 'warning');
    }
  };

  const playDesktopTtsSegment = async (
    playable: PlayableTtsSegment,
    paragraph: Paragraph,
    sessionId: number,
    sourceSegments: LabeledSegment[] = segments,
  ): Promise<boolean> => {
    const contentRevision = selectedNovel?.activeContentRevisionId;
    if (
      !desktopProviderMode ||
      !ttsCacheGateway ||
      !contentRevision ||
      !selectedHostedTTSProvider ||
      !hostedTTSPlaybackReady
    )
      return false;
    const { buildHostedTTSCacheRequest } = await import('./providers/hosted-tts-playback');
    const cacheRequest = buildHostedTTSCacheRequest({
      paragraph,
      playable,
      segments: sourceSegments,
      voiceProfiles: hostedVoiceProfiles,
      contentRevision,
      chapterTextHash: currentChapter?.id === paragraph.chapterId ? currentChapter.textHash : undefined,
      providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
      modelByProvider: savedTTSSettings?.modelByProvider,
      pronunciationRevisionId: voiceProductController.state?.pronunciationProfile.revisionId,
      pronunciationFingerprint: voiceProductController.state?.pronunciationProfile.revisionId,
      capability: selectedHostedTTSCapability,
      voiceEntryFingerprintByVoiceId: selectedVoiceEntryFingerprintByVoiceId,
      pitchOverride: ttsPlaybackSettings.pitch,
    });
    if (!cacheRequest) return false;

    const operation = ttsExecutionController.beginHostedPlayback(sessionId, '데스크톱 합성 중');
    if (!operation) return true;
    try {
      const { nativeTTSCacheRenderInput } = await import('./features/tts/native-tts-cache-request');
      const result = await ttsCacheGateway.render(
        {
          ...nativeTTSCacheRenderInput(cacheRequest, contentRevision),
          cacheOnly: ttsPlaybackSettings.offlineOnly,
        },
        operation.controller.signal,
      );
      if (operation.controller.signal.aborted || !ttsExecutionController.isSessionCurrent(sessionId)) return true;
      if (!(await ttsExecutionController.waitForResume(sessionId))) return true;
      ttsExecutionController.setHostedStatus(operation, result.cacheHit ? 'native_cache_hit' : 'native_cache_rendered');
      return ttsExecutionController.playAudio(
        new Blob([result.synthesis.audio], { type: result.synthesis.contentType }),
        sessionId,
      );
    } catch (error) {
      if (operation.controller.signal.aborted) return true;
      const message = error instanceof Error ? error.message : String(error);
      if (ttsPlaybackSettings.offlineOnly && message.includes('cache miss')) {
        ttsExecutionController.setHostedStatus(operation, 'offline_cache_miss');
        return false;
      }
      ttsExecutionController.setHostedStatus(operation, '시스템 TTS 대체');
      showToast(`데스크톱 TTS 실패, 시스템 TTS로 이어갑니다: ${message}`, 'warning');
      return false;
    } finally {
      ttsExecutionController.finishOperation(operation);
    }
  };

  const prefetchHostedTtsSegment = async (
    playable: PlayableTtsSegment | undefined,
    paragraph: Paragraph | undefined,
    sessionId: number,
  ): Promise<void> => {
    if (ttsPlaybackSettings.offlineOnly) return;
    if (desktopProviderMode && playable && paragraph) {
      const contentRevision = selectedNovel?.activeContentRevisionId;
      if (!ttsCacheGateway || !contentRevision || !selectedHostedTTSProvider || !currentChapter) return;
      const { buildHostedTTSCacheRequest } = await import('./providers/hosted-tts-playback');
      const cacheRequest = buildHostedTTSCacheRequest({
        paragraph,
        playable,
        segments,
        voiceProfiles: hostedVoiceProfiles,
        contentRevision,
        chapterTextHash: currentChapter.id === paragraph.chapterId ? currentChapter.textHash : undefined,
        providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
        modelByProvider: savedTTSSettings?.modelByProvider,
        pronunciationRevisionId: voiceProductController.state?.pronunciationProfile.revisionId,
        pronunciationFingerprint: voiceProductController.state?.pronunciationProfile.revisionId,
        capability: selectedHostedTTSCapability,
        voiceEntryFingerprintByVoiceId: selectedVoiceEntryFingerprintByVoiceId,
        pitchOverride: ttsPlaybackSettings.pitch,
      });
      if (!cacheRequest) return;
      const requestKey = hostedTTSCacheRequestKey(paragraph.chapterId, cacheRequest.request);
      const metricsTargetKey = `${selectedHostedTTSProvider.providerId}:${paragraph.novelId}`;
      if (hostedTtsPrefetchMetricsRef.current.targetKey !== metricsTargetKey) {
        hostedTtsPrefetchMetricsRef.current = {
          targetKey: metricsTargetKey,
          averageResolveLatencyMs: 0,
          consecutiveFailures: 0,
        };
      }
      const controller = ttsExecutionController.beginPrefetch(sessionId, requestKey);
      if (!controller) return;
      const startedAt = Date.now();
      try {
        const { nativeTTSCacheRenderInput } = await import('./features/tts/native-tts-cache-request');
        await ttsCacheGateway.render(nativeTTSCacheRenderInput(cacheRequest, contentRevision), controller.signal);
        const elapsed = Math.max(1, Date.now() - startedAt);
        const metrics = hostedTtsPrefetchMetricsRef.current;
        metrics.averageResolveLatencyMs = metrics.averageResolveLatencyMs
          ? Math.round(metrics.averageResolveLatencyMs * 0.7 + elapsed * 0.3)
          : elapsed;
        metrics.consecutiveFailures = 0;
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          const metrics = hostedTtsPrefetchMetricsRef.current;
          metrics.consecutiveFailures = Math.min(10, metrics.consecutiveFailures + 1);
        }
      } finally {
        ttsExecutionController.finishPrefetch(requestKey, controller);
      }
      return;
    }
    if (!playable || !paragraph || !providerApiClient || !currentChapter || !hostedTTSPlaybackReady) return;
    if (connectedProviderLocalMetadataPending) return;
    if (!ttsExecutionController.isSessionCurrent(sessionId)) return;
    const { buildHostedTTSCacheRequest } = await import('./providers/hosted-tts-playback');
    const cacheRequest = buildHostedTTSCacheRequest({
      paragraph,
      playable,
      segments,
      voiceProfiles: hostedVoiceProfiles,
      contentRevision: selectedNovel?.activeContentRevisionId,
      chapterTextHash: currentChapter.id === paragraph.chapterId ? currentChapter.textHash : undefined,
      providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
      modelByProvider: savedTTSSettings?.modelByProvider,
      pronunciationRevisionId: voiceProductController.state?.pronunciationProfile.revisionId,
      pronunciationFingerprint: voiceProductController.state?.pronunciationProfile.revisionId,
      capability: selectedHostedTTSCapability,
      voiceEntryFingerprintByVoiceId: selectedVoiceEntryFingerprintByVoiceId,
      pitchOverride: ttsPlaybackSettings.pitch,
    });
    if (!cacheRequest?.request.renderSpec) return;
    const renderSpecHash = ttsRenderSpecHash(cacheRequest.request.renderSpec);
    const contentRevisionId = selectedNovel?.activeContentRevisionId ?? 'legacy';
    const requestKey = hostedTTSCacheRequestKey(currentChapter.id, cacheRequest.request);
    const metricsTargetKey = `${selectedHostedTTSProvider?.providerId ?? 'hosted'}:${currentChapter.novelId}`;
    if (hostedTtsPrefetchMetricsRef.current.targetKey !== metricsTargetKey) {
      hostedTtsPrefetchMetricsRef.current = {
        targetKey: metricsTargetKey,
        averageResolveLatencyMs: 0,
        consecutiveFailures: 0,
      };
    }
    const controller = ttsExecutionController.beginPrefetch(sessionId, requestKey);
    if (!controller) return;
    const startedAt = Date.now();
    try {
      const { runHostedTTSPrefetch } = await import('./providers/hosted-tts-playback-runner');
      const result = await runHostedTTSPrefetch({
        chapterId: currentChapter.id,
        requestKey,
        request: cacheRequest.request,
        signal: controller.signal,
        shouldContinue: () =>
          ttsExecutionController.isSessionCurrent(sessionId) && activeChapterIdRef.current === currentChapter.id,
        resolveCache: (chapterId, request, signal) => providerApiClient.resolveTTSCache(chapterId, request, signal),
        pollJob: (job, signal) => ttsExecutionController.pollHostedJob(job.id, signal, { silent: true }),
        fetchAudio: async (chapterId, cacheKey, signal) => {
          const cached = await hostedTTSOfflineCache.getByCacheKey(paragraph.novelId, cacheKey).catch(() => undefined);
          if (cached) return cached.blob;
          const audio = await providerApiClient.fetchTTSCacheAudio(chapterId, cacheKey, signal);
          await hostedTTSOfflineCache
            .put({
              bookId: paragraph.novelId,
              chapterId: paragraph.chapterId,
              cacheKey,
              renderSpecHash,
              contentRevisionId,
              blob: audio,
            })
            .catch(() => undefined);
          return audio;
        },
        rememberPrefetched: (key, audio) => {
          ttsExecutionController.rememberPrefetched(sessionId, key, audio);
        },
        isAbortError,
      });
      if (!result.aborted) {
        const metrics = hostedTtsPrefetchMetricsRef.current;
        if (result.stored) {
          const elapsed = Math.max(1, Date.now() - startedAt);
          metrics.averageResolveLatencyMs = metrics.averageResolveLatencyMs
            ? Math.round(metrics.averageResolveLatencyMs * 0.7 + elapsed * 0.3)
            : elapsed;
          metrics.consecutiveFailures = 0;
        } else if (result.failed) {
          metrics.consecutiveFailures = Math.min(10, metrics.consecutiveFailures + 1);
        }
      }
    } finally {
      ttsExecutionController.finishPrefetch(requestKey, controller);
    }
  };

  const playHostedTtsSegment = async (
    playable: PlayableTtsSegment,
    paragraph: Paragraph,
    sessionId: number,
    sourceSegments: LabeledSegment[] = segments,
    options: { skipConnectedPreflight?: boolean } = {},
  ): Promise<boolean> => {
    if (desktopProviderMode) return playDesktopTtsSegment(playable, paragraph, sessionId);
    if (!currentChapter || !hostedTTSPlaybackReady) return false;
    const paragraphChapter = chapters.find((chapter) => chapter.id === paragraph.chapterId);
    const { buildHostedTTSCacheRequest } = await import('./providers/hosted-tts-playback');
    const cacheRequest = buildHostedTTSCacheRequest({
      paragraph,
      playable,
      segments: sourceSegments,
      voiceProfiles: hostedVoiceProfiles,
      contentRevision: selectedNovel?.activeContentRevisionId,
      chapterTextHash: paragraphChapter?.textHash,
      providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
      modelByProvider: savedTTSSettings?.modelByProvider,
      pronunciationRevisionId: voiceProductController.state?.pronunciationProfile.revisionId,
      pronunciationFingerprint: voiceProductController.state?.pronunciationProfile.revisionId,
      capability: selectedHostedTTSCapability,
      voiceEntryFingerprintByVoiceId: selectedVoiceEntryFingerprintByVoiceId,
      pitchOverride: ttsPlaybackSettings.pitch,
    });
    if (!cacheRequest?.request.renderSpec) return false;
    const renderSpecHash = ttsRenderSpecHash(cacheRequest.request.renderSpec);
    const contentRevisionId = selectedNovel?.activeContentRevisionId ?? 'legacy';
    const requestKey = hostedTTSCacheRequestKey(paragraph.chapterId, cacheRequest.request);
    if (!ttsExecutionController.isSessionCurrent(sessionId)) return true;
    const persisted = await hostedTTSOfflineCache
      .getByRenderSpecHash(paragraph.novelId, renderSpecHash)
      .catch(() => undefined);
    if (!ttsExecutionController.isSessionCurrent(sessionId)) return true;
    if (persisted) {
      const operation = ttsExecutionController.beginHostedPlayback(sessionId, 'indexeddb_cache_hit');
      if (!operation) return true;
      try {
        return await ttsExecutionController.playAudio(persisted.blob, sessionId);
      } finally {
        ttsExecutionController.finishOperation(operation);
      }
    }
    if (ttsPlaybackSettings.offlineOnly) {
      const operation = ttsExecutionController.beginHostedPlayback(sessionId, 'offline_cache_miss');
      if (operation) ttsExecutionController.finishOperation(operation);
      return false;
    }
    if (!providerApiClient) return false;
    if (
      !options.skipConnectedPreflight &&
      !(await runConnectedProviderPreflight({
        syncBeforeJob: connectedProviderLocalMetadataPending
          ? () => syncConnectedProviderState('before_job')
          : undefined,
        targetStillActive: () => connectedProviderTargetStillActive(paragraph.novelId, paragraph.chapterId),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(paragraph.novelId, [paragraph.chapterId]),
      }))
    )
      return false;
    if (!ttsExecutionController.isSessionCurrent(sessionId)) return true;
    const prefetched = ttsExecutionController.takePrefetched(requestKey);
    if (prefetched) {
      const operation = ttsExecutionController.beginHostedPlayback(sessionId, 'prefetch_hit');
      if (!operation) return true;
      try {
        return await ttsExecutionController.playAudio(prefetched.blob, sessionId);
      } finally {
        ttsExecutionController.finishOperation(operation);
      }
    }

    const operation = ttsExecutionController.beginHostedPlayback(sessionId);
    if (!operation) return true;
    try {
      const { runHostedTTSPlayback } = await import('./providers/hosted-tts-playback-runner');
      const result = await runHostedTTSPlayback({
        chapterId: paragraph.chapterId,
        requestKey,
        request: cacheRequest.request,
        signal: operation.controller.signal,
        takePrefetched: ttsExecutionController.takePrefetched,
        shouldContinue: () => ttsExecutionController.isSessionCurrent(sessionId),
        waitForResume: () => ttsExecutionController.waitForResume(sessionId),
        resolveCache: (chapterId, request, signal) => providerApiClient.resolveTTSCache(chapterId, request, signal),
        pollJob: (job, signal) => ttsExecutionController.pollHostedJob(job.id, signal, { operation }),
        fetchAudio: async (chapterId, cacheKey, signal) => {
          const cached = await hostedTTSOfflineCache.getByCacheKey(paragraph.novelId, cacheKey).catch(() => undefined);
          if (cached) return cached.blob;
          const audio = await providerApiClient.fetchTTSCacheAudio(chapterId, cacheKey, signal);
          await hostedTTSOfflineCache
            .put({
              bookId: paragraph.novelId,
              chapterId: paragraph.chapterId,
              cacheKey,
              renderSpecHash,
              contentRevisionId,
              blob: audio,
            })
            .catch(() => undefined);
          return audio;
        },
        playAudio: (blob) => ttsExecutionController.playAudio(blob, sessionId),
        onStatus: (status) => {
          ttsExecutionController.setHostedStatus(operation, status);
        },
        onJob: (job) => {
          ttsExecutionController.setHostedJob(operation, job);
        },
        isAbortError,
      });
      if (result.fallback && result.errorMessage) {
        showToast(`서버 TTS 실패, 시스템 TTS로 이어갑니다: ${result.errorMessage}`, 'warning');
      }
      return result.played;
    } finally {
      ttsExecutionController.finishOperation(operation);
    }
  };

  const warmupHostedTTSChapters = (scope: TTSWarmupScope): Chapter[] =>
    selectTTSWarmupChapters({
      scope,
      chapters,
      currentChapter,
      nearbyChapterLimit: DEFAULT_HOSTED_TTS_BULK_WARMUP_CHAPTER_LIMIT,
    });

  const loadHostedTTSWarmupChapterSource = async (
    chapter: Chapter,
    signal: AbortSignal,
    options: { maxCandidateParagraphs?: number } = {},
  ): Promise<HostedTTSWarmupChapterSource | undefined> => {
    const [source, voiceBindings] = await Promise.all([
      loadTTSWarmupChapterSource({
        repository: readerRepository,
        chapter,
        currentChapterId: currentChapter?.id,
        currentSegments: segments,
        cachedParagraph: cachedParagraphById,
        maxCandidateParagraphs: options.maxCandidateParagraphs ?? DEFAULT_HOSTED_TTS_WARMUP_LIMIT,
        signal,
      }),
      voiceProductController.loadVoiceBindings(chapter.id, selectedHostedTTSProvider?.providerId),
    ]);
    if (!source) return undefined;
    return {
      ...source,
      voiceBindings,
    };
  };

  const warmupNativeTTSCache = async (scope: TTSWarmupScope) => {
    const contentRevision = selectedNovel?.activeContentRevisionId;
    if (!ttsCacheGateway || !currentChapter || !selectedNovel || !contentRevision || !hostedTTSPlaybackReady) return;
    const sourceChapters = warmupHostedTTSChapters(scope);
    const operation = ttsExecutionController.beginWarmup(
      currentChapter.novelId,
      currentChapter.id,
      'native_warmup_loading',
    );
    if (!operation) return;
    let persistDownloadFailure: (() => Promise<unknown>) | undefined;
    let persistDownloadCancellation: (() => Promise<unknown>) | undefined;
    try {
      const { IndexedDbTTSDownloadRepository } = await import('./storage/tts-download-store');
      const downloadRepository = new IndexedDbTTSDownloadRepository();
      const downloadJob = await downloadRepository.create({
        bookId: selectedNovel.id,
        contentRevisionId: contentRevision,
        chapterIds: sourceChapters.map((chapter) => chapter.id),
        wholeBook: scope === 'book',
        policy: offlineTTSRecoveryPolicy,
      });
      persistDownloadFailure = () => downloadRepository.finish(downloadJob.id, 'failed');
      persistDownloadCancellation = () => downloadRepository.cancel(downloadJob.id);
      const { module, input } = await loadNativeTTSCacheContext();
      const summary = await module.runNativeTTSCacheOperation(
        input,
        'render',
        sourceChapters,
        operation.controller.signal,
        {
          fullScan: scope === 'book',
          retryLimit: downloadJob.policy.retryLimit,
          recoveryPolicy: {
            network: downloadJob.policy.network,
            charging: downloadJob.policy.charging,
          },
          onStatus: (status) => ttsExecutionController.setHostedStatus(operation, status),
          observer: {
            planned: (items) => downloadRepository.planItems(downloadJob.id, items),
            running: (renderSpecHash) => downloadRepository.markItemRunning(downloadJob.id, renderSpecHash),
            retrying: (renderSpecHash, error, nextAttemptAt) =>
              downloadRepository.markItemRetryWait(
                downloadJob.id,
                renderSpecHash,
                error instanceof Error ? error.message : String(error),
                nextAttemptAt,
              ),
            ready: (renderSpecHash, result) =>
              downloadRepository.markItemReady(downloadJob.id, renderSpecHash, {
                cacheKey: result.cacheKey,
                byteSize: result.byteSize,
              }),
            failed: (renderSpecHash, error) =>
              downloadRepository.markItemFailed(
                downloadJob.id,
                renderSpecHash,
                error instanceof Error ? error.message : String(error),
              ),
          },
        },
      );
      if (!summary) return;
      if (summary.aborted) {
        await downloadRepository.cancel(downloadJob.id);
        return;
      }
      const unsuccessful = summary.failed + summary.sourceFailures + (summary.readiness?.missing ?? 0);
      const completedJob = await downloadRepository.finish(
        downloadJob.id,
        unsuccessful ? (summary.completed > 0 ? 'partial' : 'failed') : 'completed',
      );
      await ttsCacheGateway
        .prune?.({
          maxBytes: 2 * 1024 * 1024 * 1024,
          protectedCacheKeys: await downloadRepository.protectedCacheKeys(),
        })
        .catch(() => undefined);
      ttsExecutionController.setHostedStatus(operation, unsuccessful ? 'native_warmup_partial' : 'native_warmup_ready');
      showToast(
        `오프라인 TTS 준비 ${completedJob?.readyItems ?? summary.completed}/${completedJob?.plannedItems ?? summary.total} · ${formatBytes(completedJob?.byteSize ?? summary.readiness?.byteSize ?? 0)}`,
        unsuccessful ? 'warning' : 'success',
      );
    } catch (error) {
      if (isAbortError(error)) {
        await persistDownloadCancellation?.().catch(() => undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await persistDownloadFailure?.().catch(() => undefined);
      ttsExecutionController.setHostedStatus(operation, 'native_warmup_failed');
      showToast(`오프라인 TTS 준비 실패: ${message}`, 'warning');
    } finally {
      ttsExecutionController.finishOperation(operation);
      await refreshOfflineTTSDownloadJob().catch(() => undefined);
    }
  };

  const warmupHostedTTSCache = async (scope: TTSWarmupScope = 'current') => {
    if (scope === 'book' && !voiceProductWholeBookReady) {
      showToast('주요 캐릭터 음성 샘플을 모두 승인한 뒤 책 전체 캐시를 준비할 수 있습니다.', 'warning');
      return;
    }
    if (desktopProviderMode) return warmupNativeTTSCache(scope);
    if (!providerApiClient || !currentChapter || !selectedNovel?.activeContentRevisionId || !hostedTTSPlaybackReady)
      return;
    const sourceChapters = warmupHostedTTSChapters(scope);
    if (
      !(await runConnectedProviderPreflight({
        syncBeforeJob: connectedProviderLocalMetadataPending
          ? () => syncConnectedProviderState('before_job')
          : undefined,
        targetStillActive: () => connectedProviderTargetStillActive(currentChapter.novelId, currentChapter.id),
        ensureAttached: () =>
          ensureConnectedProviderServerBookAttached(
            currentChapter.novelId,
            sourceChapters.map((chapter) => chapter.id),
          ),
      }))
    )
      return;
    const operation = ttsExecutionController.beginWarmup(currentChapter.novelId, currentChapter.id, 'warmup_loading');
    if (!operation) return;
    let persistDownloadFailure: (() => Promise<unknown>) | undefined;
    let persistDownloadCancellation: (() => Promise<unknown>) | undefined;
    try {
      const [
        { buildHostedTTSBulkWarmupRequests },
        { runHostedTTSBackgroundWarmup },
        { runHostedTTSWarmupQueue },
        { IndexedDbTTSDownloadRepository },
      ] = await Promise.all([
        import('./providers/hosted-tts-warmup'),
        import('./providers/hosted-tts-background-warmup-runner'),
        import('./providers/hosted-tts-warmup-runner'),
        import('./storage/tts-download-store'),
      ]);
      const downloadRepository = new IndexedDbTTSDownloadRepository();
      const downloadJob = await downloadRepository.create({
        bookId: selectedNovel.id,
        contentRevisionId: selectedNovel.activeContentRevisionId,
        chapterIds: sourceChapters.map((chapter) => chapter.id),
        wholeBook: scope === 'book',
        policy: offlineTTSRecoveryPolicy,
      });
      persistDownloadFailure = () => downloadRepository.finish(downloadJob.id, 'failed');
      persistDownloadCancellation = () => downloadRepository.cancel(downloadJob.id);
      const buildWarmupRequests = (
        chapterSources: HostedTTSWarmupChapterSource[],
        maxRequests: number,
      ): HostedTTSWarmupRequest[] =>
        buildHostedTTSBulkWarmupRequests({
          chapters: chapterSources,
          characters,
          voiceProfiles: hostedVoiceProfiles,
          fallbackVoiceURI: settings.ttsVoiceURI,
          baseRate: ttsPlaybackSettings.rate,
          maxRequests,
          contentRevision: selectedNovel?.activeContentRevisionId,
          providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
          modelByProvider: savedTTSSettings?.modelByProvider,
          pronunciationRevisionId: voiceProductController.state?.pronunciationProfile.revisionId,
          pronunciationFingerprint: voiceProductController.state?.pronunciationProfile.revisionId,
          capability: selectedHostedTTSCapability,
          voiceEntryFingerprintByVoiceId: selectedVoiceEntryFingerprintByVoiceId,
          language: selectedNovel?.language,
          spokenTextRules,
          rubyPolicy: 'reading',
          footnotePolicy: 'skip_marker',
        });
      const runWarmupQueue = async (warmupRequests: HostedTTSWarmupRequest[], signal: AbortSignal) => {
        const planned = warmupRequests.flatMap((request) => {
          const renderSpec = request.request.renderSpec;
          if (!renderSpec) return [];
          const renderSpecHash = ttsRenderSpecHash(renderSpec);
          return [
            {
              chapterId: request.chapterId,
              paragraphId: request.paragraphId,
              cacheKey: renderSpecHash,
              renderSpecHash,
            },
          ];
        });
        await downloadRepository.planItems(downloadJob.id, planned);
        return runHostedTTSWarmupQueue({
          requests: warmupRequests,
          signal,
          resolveCache: (request, requestSignal) =>
            providerApiClient.resolveTTSCache(request.chapterId, request.request, requestSignal),
          pollJob: (job, requestSignal) => ttsExecutionController.pollHostedJob(job.id, requestSignal, { operation }),
          fetchAudio: async (request, resolved, requestSignal) => {
            const cached = await hostedTTSOfflineCache
              .getByCacheKey(selectedNovel.id, resolved.cacheKey)
              .catch(() => undefined);
            if (cached) return cached.blob;
            const audio = await providerApiClient.fetchTTSCacheAudio(
              request.chapterId,
              resolved.cacheKey,
              requestSignal,
            );
            const renderSpec = request.request.renderSpec;
            if (!renderSpec) throw new Error('Hosted TTS render specification is missing.');
            await hostedTTSOfflineCache.put({
              bookId: selectedNovel.id,
              chapterId: request.chapterId,
              cacheKey: resolved.cacheKey,
              renderSpecHash: ttsRenderSpecHash(renderSpec),
              contentRevisionId: selectedNovel.activeContentRevisionId!,
              blob: audio,
            });
            return audio;
          },
          onRequestStart: (request) => {
            if (request.request.renderSpec) {
              return downloadRepository.markItemRunning(downloadJob.id, ttsRenderSpecHash(request.request.renderSpec));
            }
          },
          onRequestReady: (request, resolved, audio) => {
            if (request.request.renderSpec && audio) {
              return downloadRepository.markItemReady(downloadJob.id, ttsRenderSpecHash(request.request.renderSpec), {
                cacheKey: resolved.cacheKey,
                byteSize: audio.size,
                storage: 'indexeddb',
              });
            }
          },
          onRequestFailed: (request, error) => {
            if (request.request.renderSpec) {
              return downloadRepository.markItemFailed(
                downloadJob.id,
                ttsRenderSpecHash(request.request.renderSpec),
                error instanceof Error ? error.message : String(error),
              );
            }
          },
          onRequestRetry: (request, error, nextAttemptAt) => {
            if (request.request.renderSpec) {
              return downloadRepository.markItemRetryWait(
                downloadJob.id,
                ttsRenderSpecHash(request.request.renderSpec),
                error instanceof Error ? error.message : String(error),
                nextAttemptAt,
              );
            }
          },
          retryLimit: downloadJob.policy.retryLimit,
          wait: abortableDelay,
          onStatus: (status) => {
            ttsExecutionController.setHostedStatus(operation, status);
          },
          onJob: (job) => {
            ttsExecutionController.setHostedJob(operation, job);
          },
          isAbortError,
        });
      };

      if (scope === 'book') {
        const warmupSummary = await runHostedTTSBackgroundWarmup({
          chapters: sourceChapters,
          signal: operation.controller.signal,
          chapterBatchSize: DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT,
          loadChapterSource: (chapter, signal) =>
            loadHostedTTSWarmupChapterSource(chapter, signal, {
              maxCandidateParagraphs: Number.POSITIVE_INFINITY,
            }),
          buildRequests: (chapterSources) => buildWarmupRequests(chapterSources, Number.POSITIVE_INFINITY),
          runQueue: runWarmupQueue,
          yieldBetweenBatches: () => abortableDelay(0, operation.controller.signal),
          onStatus: (status) => {
            ttsExecutionController.setHostedStatus(operation, status);
          },
          isAbortError,
        });
        if (warmupSummary.aborted) {
          await downloadRepository.cancel(downloadJob.id);
          return;
        }
        if (warmupSummary.total === 0) {
          await downloadRepository.finish(downloadJob.id, 'completed');
          ttsExecutionController.setHostedStatus(operation, 'warmup_empty');
          showToast('준비할 서버 TTS cache 대상이 없습니다.', 'warning');
          return;
        }
        const failed = warmupSummary.failed + warmupSummary.sourceFailures;
        await downloadRepository.finish(
          downloadJob.id,
          failed ? (warmupSummary.completed > 0 ? 'partial' : 'failed') : 'completed',
        );
        ttsExecutionController.setHostedStatus(operation, failed ? 'warmup_partial' : 'warmup_ready');
        showToast(
          `서버 TTS 전체 cache 준비 완료: ${warmupSummary.completed}/${warmupSummary.total}개 · ${warmupSummary.chapters}화 · hit ${warmupSummary.cacheHits} · job ${warmupSummary.jobs}`,
          failed ? 'warning' : 'success',
        );
        if (activeBookAIWorkflow?.id) {
          try {
            if (!bookAITTSPreparationRunner?.refreshCacheReadiness) return;
            const workflow = await bookAITTSPreparationRunner.refreshCacheReadiness(
              activeBookAIWorkflow.id,
              operation.controller.signal,
            );
            if (selectedNovel && workflow.novelId === selectedNovel.id) {
              bookAIWorkflowController.adoptWorkflow(workflow, { confirmsTTSReadiness: true });
            }
          } catch (error) {
            if (!isAbortError(error)) {
              const message = error instanceof Error ? error.message : String(error);
              showToast(`TTS 오디오 cache 상태 확인 실패: ${message}`, 'warning');
            }
          }
        }
        return;
      }

      const chapterSources: HostedTTSWarmupChapterSource[] = [];
      for (const chapter of sourceChapters) {
        if (operation.controller.signal.aborted) {
          await downloadRepository.cancel(downloadJob.id);
          return;
        }
        const source = await loadHostedTTSWarmupChapterSource(chapter, operation.controller.signal);
        if (source && source.paragraphs.length > 0) chapterSources.push(source);
      }
      const warmupRequests = buildWarmupRequests(chapterSources, DEFAULT_HOSTED_TTS_WARMUP_LIMIT);
      if (!warmupRequests.length) {
        await downloadRepository.finish(downloadJob.id, 'completed');
        ttsExecutionController.setHostedStatus(operation, 'warmup_empty');
        showToast('준비할 서버 TTS cache 대상이 없습니다.', 'warning');
        return;
      }

      const warmupSummary = await runWarmupQueue(warmupRequests, operation.controller.signal);
      if (warmupSummary.aborted) {
        await downloadRepository.cancel(downloadJob.id);
        return;
      }
      const cacheHits = warmupSummary.cacheHits;
      const jobs = warmupSummary.jobs;
      const failed = warmupSummary.failed;
      await downloadRepository.finish(
        downloadJob.id,
        failed ? (warmupSummary.completed > 0 ? 'partial' : 'failed') : 'completed',
      );
      ttsExecutionController.setHostedStatus(operation, failed ? 'warmup_partial' : 'warmup_ready');
      showToast(
        `서버 TTS cache 준비 완료: ${warmupRequests.length - failed}/${warmupRequests.length}개 · hit ${cacheHits} · job ${jobs}`,
        failed ? 'warning' : 'success',
      );
    } catch (error) {
      if (isAbortError(error)) {
        await persistDownloadCancellation?.().catch(() => undefined);
        return;
      }
      await persistDownloadFailure?.().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      ttsExecutionController.setHostedStatus(operation, 'warmup_failed');
      showToast(`서버 TTS cache 준비 실패: ${message}`, 'warning');
    } finally {
      ttsExecutionController.finishOperation(operation);
      await refreshOfflineTTSDownloadJob().catch(() => undefined);
    }
  };

  const navigateBookAIWorkflowReviewTarget = async (
    item: BookAIWorkflowReviewItem,
    initialMode: ReaderMode,
  ): Promise<{ chapterChanged: boolean; paragraphId?: string }> => {
    const paragraphId = item.paragraphIds?.[0];
    const paragraph = paragraphId ? await readerRepository.getParagraph(paragraphId) : undefined;
    const targetChapterId = item.chapterId ?? paragraph?.chapterId;
    const targetChapter = targetChapterId
      ? (chapters.find((chapter) => chapter.id === targetChapterId) ??
        (await readerRepository.getChapter(targetChapterId)))
      : undefined;

    if (targetChapter && targetChapter.id !== currentChapter?.id) {
      await bookWorkspace.openChapter(targetChapter, {
        novel: selectedNovel,
        targetParagraphId: paragraphId,
        initialMode,
      });
      return { chapterChanged: true, paragraphId };
    }

    setReaderMode(initialMode);
    if (paragraphId) await scrollToParagraph(paragraphId);
    return { chapterChanged: false, paragraphId };
  };

  const runBookAIWorkflowReviewAction = async (item: BookAIWorkflowReviewItem): Promise<void> => {
    setAddonOpen(true);
    if (item.recommendedAction === 'assign_voice_profiles') {
      setAddonTab('tts');
      if (selectedHostedTTSProvider && selectedHostedTTSVoices.length === 0) {
        void refreshHostedTTSVoices(selectedHostedTTSProvider.providerId);
      }
      showToast('TTS 탭에서 누락된 캐릭터 음성을 지정한 뒤 workflow를 다시 실행하세요.', 'warning');
      return;
    }
    if (item.recommendedAction === 'review_labels') {
      setAddonTab(MOYA_AI_ADDON_ID);
      const navigation = await navigateBookAIWorkflowReviewTarget(item, 'correction');
      const target = navigation.chapterChanged
        ? undefined
        : (correctionReviewItems.find((candidate) => candidate.segment.paragraphId === navigation.paragraphId) ??
          correctionReviewItems[0]);
      if (target) {
        selectCorrectionSegment(target.segment);
        await scrollToParagraph(target.segment.paragraphId);
        showToast('라벨 검토 큐에서 unknown/저신뢰 라벨을 먼저 확인하세요.', 'warning');
      } else if (navigation.chapterChanged) {
        showToast('문제가 보고된 화와 문단을 열었습니다. 해당 화의 라벨을 검토하세요.', 'warning');
      } else {
        showToast('현재 화에는 표시할 라벨 검토 항목이 없습니다. 문제 window를 열어 확인해야 합니다.', 'warning');
      }
      return;
    }
    if (item.recommendedAction === 'inspect_failed_job') {
      setAddonTab(MOYA_AI_ADDON_ID);
      await navigateBookAIWorkflowReviewTarget(item, 'analysis');
      const failedJob = activeBookAIWorkflow?.jobs.find((link) => link.providerJobId === item.providerJobId)?.job;
      if (failedJob) analysisExecutionController.showJob(failedJob);
      showToast('실패한 provider job 정보를 AI 패널에 표시했습니다. 원인 확인 후 workflow를 재시도하세요.', 'warning');
      return;
    }
    if (
      item.recommendedAction === 'retry_workflow' ||
      item.recommendedAction === 'retry_same_request' ||
      item.recommendedAction === 'resume_after_fix'
    ) {
      setAddonTab(MOYA_AI_ADDON_ID);
      void retryBookAIWorkflow();
    }
  };

  const playVoiceProfileSample = async (profile: VoiceProfile, kind: 'neutral' | 'in_context'): Promise<void> => {
    if (kind === 'neutral') {
      await voiceProductController.playAndRecordSample(
        profile,
        kind,
        ttsVoiceSampleText(TTS_NEUTRAL_SAMPLE_KO_V1) ?? '',
      );
      return;
    }
    const speakerId = profile.characterId ?? profile.role;
    const segment = segments.find((item) => item.speakerId === speakerId);
    const paragraph = segment ? cachedParagraphById(segment.paragraphId) : undefined;
    const text =
      segment && paragraph
        ? paragraph.text.slice(segment.startOffset, segment.endOffset).trim() || paragraph.text.trim()
        : undefined;
    if (!text) {
      showToast('현재 불러온 화에서 이 화자의 문맥 샘플을 찾지 못했습니다.', 'warning');
      return;
    }
    await voiceProductController.playAndRecordSample(profile, kind, text.slice(0, 240), segment?.id);
  };

  const speakAt = async (index: number, sessionId: number, startQueueItemFingerprint?: string) => {
    const chapter = currentChapter;
    const sessionSignal = ttsExecutionController.sessionSignal(sessionId);
    if (!sessionSignal) return;
    let paragraphCount = chapter?.paragraphCount ?? 0;
    const [playbackSession, playbackRunner, playbackBuilder, footnotePlanner] = await Promise.all([
      import('./providers/tts-playback-session'),
      import('./providers/tts-playback-session-runner'),
      import('./providers/tts-playback'),
      import('./providers/epub-footnote-playback'),
    ]);
    let playbackStartIndex = index;
    let plannedParagraphs: readonly Paragraph[] | undefined;
    let sourceIndexByParagraphId: ReadonlyMap<string, number> | undefined;
    if (chapter && selectedNovel?.format === 'epub') {
      const sourceParagraphs: Paragraph[] = [];
      for await (const page of readerRepository.iterateParagraphPages({
        chapterId: chapter.id,
        signal: sessionSignal,
      })) {
        sourceParagraphs.push(...page.paragraphs);
      }
      const plan = footnotePlanner.planEpubFootnotePlayback({
        paragraphs: sourceParagraphs,
        startIndex: index,
        policy: ttsPlaybackSettings.footnotePlayback,
      });
      plannedParagraphs = plan.paragraphs;
      sourceIndexByParagraphId = plan.sourceIndexByParagraphId;
      playbackStartIndex = 0;
      paragraphCount = plannedParagraphs.length;
    }
    const playbackVoiceProfiles = playbackSession.playbackVoiceProfilesForSession({
      hostedReady: hostedTTSPlaybackReady,
      hostedVoiceProfiles,
      systemVoiceProfiles: activeSystemVoiceProfiles,
    });
    let liveVoiceBindings = [] as Awaited<ReturnType<typeof voiceProductController.loadVoiceBindings>>;
    try {
      const playbackProviderId = hostedTTSPlaybackReady ? selectedHostedTTSProvider?.providerId : 'system';
      liveVoiceBindings = chapter ? await voiceProductController.loadVoiceBindings(chapter.id, playbackProviderId) : [];
    } catch (error) {
      showToast(error instanceof Error ? error.message : '최신 화자 음성 배정을 불러오지 못했습니다.', 'warning');
    }
    if (!ttsExecutionController.isSessionCurrent(sessionId)) return;
    const result = await playbackRunner.runTTSPlaybackSession({
      startIndex: playbackStartIndex,
      startQueueItemFingerprint,
      queueItemFingerprint: ttsQueueItemFingerprint,
      paragraphCount,
      getParagraph: plannedParagraphs
        ? async (playbackIndex) => plannedParagraphs?.[playbackIndex]
        : getParagraphAtIndex,
      sourceParagraphIndex: sourceIndexByParagraphId
        ? (paragraph, playbackIndex) => sourceIndexByParagraphId?.get(paragraph.id) ?? playbackIndex
        : undefined,
      buildPlayableSegments: (paragraph) => {
        const playable = playbackBuilder.buildPlayableTtsSegments({
          paragraph,
          segments,
          characters,
          voiceProfiles: playbackVoiceProfiles,
          fallbackVoiceURI: settings.ttsVoiceURI,
          baseRate: ttsPlaybackSettings.rate,
          voiceBindings: liveVoiceBindings,
          language: selectedNovel?.language,
          spokenTextRules,
          rubyPolicy: 'reading',
          footnotePolicy: 'skip_marker',
        });
        return planTTSParagraphSentences(
          paragraph,
          playable.filter(
            (item) =>
              !item.contentType || !ttsPlaybackSettings.skippedContentTypes.some((type) => type === item.contentType),
          ),
        );
      },
      shouldContinue: () => ttsExecutionController.isSessionCurrent(sessionId),
      signal: sessionSignal,
      waitForResume: () => ttsExecutionController.waitForResume(sessionId),
      playHostedSegment: hostedTTSPlaybackReady
        ? (playable, paragraph) => playHostedTtsSegment(playable, paragraph, sessionId)
        : undefined,
      canPrefetchHostedSegment:
        hostedTTSPlaybackReady && !ttsPlaybackSettings.offlineOnly
          ? desktopProviderMode
            ? () => true
            : (_playable, paragraph) =>
                ensureConnectedProviderServerBookAttached(paragraph.novelId, [paragraph.chapterId], { silent: true })
          : undefined,
      prefetchHostedSegment:
        hostedTTSPlaybackReady && !ttsPlaybackSettings.offlineOnly
          ? (playable, paragraph) => {
              void prefetchHostedTtsSegment(playable, paragraph, sessionId);
            }
          : undefined,
      hostedPrefetchDepth:
        hostedTTSPlaybackReady && !ttsPlaybackSettings.offlineOnly
          ? (playable) =>
              playbackSession.adaptiveHostedTTSPrefetchDepth({
                averageResolveLatencyMs: hostedTtsPrefetchMetricsRef.current.averageResolveLatencyMs,
                consecutiveFailures: hostedTtsPrefetchMetricsRef.current.consecutiveFailures,
                currentItemDurationMs: playbackSession.estimatePlayableDurationMs(playable),
                cacheCapacity: 4,
              })
          : undefined,
      buildSystemFallbackInput: (playable) => ({
        ...playbackSession.buildSystemTTSFallbackInput({
          playable,
          systemVoiceProfiles: activeSystemVoiceProfiles,
          fallbackVoiceURI: settings.ttsVoiceURI,
          baseRate: ttsPlaybackSettings.rate,
          pitch: ttsPlaybackSettings.pitch,
          volume: ttsPlaybackSettings.volume,
        }),
        mediaMetadata: {
          title: currentChapter?.title ?? selectedNovel?.title ?? '모야',
          album: selectedNovel?.title,
          artist: selectedNovel?.author,
        },
      }),
      speakSystem: (input) => systemTTS.speak(input),
      speakSystemSequence: systemTTS.speakSequence ? (items) => systemTTS.speakSequence!(items) : undefined,
      stopSystem: () => systemTTS.stop(),
      sentencePauseMs: ttsPlaybackSettings.sentencePauseMs,
      paragraphPauseMs: ttsPlaybackSettings.paragraphPauseMs,
      shouldStopAfterItem: ttsExecutionController.shouldStopAfterItem,
      onItemActiveChanged: (active) => ttsExecutionController.setItemActive(sessionId, active),
      onParagraphStart: (paragraphIndex, paragraph) => {
        if (!ttsExecutionController.setParagraph(sessionId, paragraphIndex)) return;
        if (selectedNovel) {
          const resumeRecord: TTSPlaybackResumeRecord = {
            schemaVersion: 1,
            bookId: selectedNovel.id,
            chapterId: paragraph.chapterId,
            paragraphIndex,
            contentRevisionId: selectedNovel.activeContentRevisionId,
            settingsFingerprint: ttsResumeFingerprint,
            updatedAt: new Date().toISOString(),
          };
          saveTTSPlaybackResume(resumeRecord);
          setTTSResumeRecord(resumeRecord);
        }
        void scrollToParagraph(paragraph.id);
      },
      onPlayableStart: async (_playableIndex, playable, paragraphIndex, paragraph) => {
        if (!selectedNovel?.activeContentRevisionId) return;
        const sourceRange = playable.sourceRanges.find((range) => range.paragraphId === paragraph.id);
        const startOffset = sourceRange?.startOffset ?? 0;
        const endOffset = sourceRange?.endOffset ?? startOffset;
        try {
          const position = await saveListeningPosition({
            bookId: selectedNovel.id,
            chapterId: paragraph.chapterId,
            contentRevisionId: selectedNovel.activeContentRevisionId,
            queueItemFingerprint: ttsQueueItemFingerprint(playable),
            settingsFingerprint: ttsResumeFingerprint,
            anchor: {
              kind: 'reflowable_text',
              paragraphId: paragraph.id,
              startOffset,
              endOffset,
              reader: {
                bookId: selectedNovel.id,
                contentRevisionId: selectedNovel.activeContentRevisionId,
                sectionId: paragraph.chapterId,
                blockId: paragraph.id,
                blockIndex: paragraphIndex,
                offset: startOffset,
              },
            },
          });
          setTTSListeningPosition(position);
          await readerMutationCommittedRef.current('progress');
        } catch {
          // Playback remains available when a best-effort cursor write fails.
        }
      },
      onActivePlayback: (playback) => {
        ttsExecutionController.setActivePlayback(sessionId, playback);
      },
      onError: (message) => {
        if (!ttsExecutionController.finishSession(sessionId, { preserveIndex: true, errorMessage: message })) return;
        showToast(`TTS 오류: ${message}`, 'danger');
      },
    });
    if (!chapter || !ttsExecutionController.isSessionCurrent(sessionId, false)) return;
    if (result.stopReason === 'timer') {
      ttsExecutionController.finishSession(sessionId);
      showToast('수면 타이머에 따라 재생을 마쳤습니다.', 'info');
      return;
    }
    if (!result.completed) return;
    const nextChapter = nextPlaybackChapter(chapters, chapter.id);
    const stopAtChapterEnd = ttsExecutionController.shouldStopAtChapterEnd();
    if (stopAtChapterEnd || ttsPlaybackSettings.chapterEndBehavior === 'stop' || !nextChapter) {
      ttsExecutionController.finishSession(sessionId);
      clearTTSPlaybackResume(chapter.novelId);
      void clearListeningPosition(chapter.novelId).then(() => readerMutationCommittedRef.current('progress'));
      setTTSListeningPosition(undefined);
      setTTSResumeRecord(undefined);
      if (!nextChapter && ttsPlaybackSettings.chapterEndBehavior === 'continue') {
        showToast('마지막 화 재생을 마쳤습니다.', 'info');
      }
      return;
    }
    const continueAfterPause = await waitForPlaybackDelay({
      durationMs: ttsPlaybackSettings.chapterPauseMs,
      shouldContinue: () => ttsExecutionController.isSessionCurrent(sessionId),
      waitForResume: () => ttsExecutionController.waitForResume(sessionId),
      signal: sessionSignal,
    });
    if (!continueAfterPause || !ttsExecutionController.isSessionCurrent(sessionId, false)) return;
    bookPlaybackCoordinator.schedule({ bookId: chapter.novelId, chapterId: nextChapter.id, startIndex: 0 });
    ttsExecutionController.finishSession(sessionId, { preserveSleepTimer: true });
    await bookWorkspace.openChapter(nextChapter, {
      novel: selectedNovel,
      initialMode: 'listen',
      preserveTTS: true,
    });
  };

  const startTTS = async (
    requestedIndex?: number,
    options: { preserveSleepTimer?: boolean; revealPanel?: boolean; queueItemFingerprint?: string } = {},
  ) => {
    const chapter = currentChapter;
    if (!chapter?.paragraphCount) return;
    stopProviderSamples();
    setReaderMode('listen');
    if (options.revealPanel) {
      setAddonOpen(true);
      setAddonTab('tts');
    }
    const status = await refreshTTSState();
    if (!status) return;
    if (!status.canSpeak && !hostedTTSPlaybackReady) {
      showToast(status.message, 'warning');
      return;
    }
    const startIndex = requestedIndex ?? ttsIndex ?? readerScreenHandle.getLocation()?.ttsIndex ?? 0;
    const sessionId = ttsExecutionController.beginSession(chapter.novelId, chapter.id, startIndex, {
      preserveSleepTimer: options.preserveSleepTimer,
    });
    if (sessionId === undefined) return;
    await speakAt(startIndex, sessionId, options.queueItemFingerprint);
  };

  const prepareFixedDocumentTTS = async (requestedStartPageIndex: number, requestedEndPageIndex: number) => {
    if (
      !selectedNovel ||
      selectedNovel.format !== 'pdf' ||
      view !== 'document' ||
      !currentChapter ||
      !selectedNovel.activeContentRevisionId ||
      !hostedTTSPlaybackReady
    ) {
      showToast('PDF 오프라인 음성을 준비할 provider를 먼저 선택하세요.', 'warning');
      return;
    }
    const startPageIndex = clamp(Math.min(requestedStartPageIndex, requestedEndPageIndex), 0, chapters.length - 1);
    const endPageIndex = clamp(
      Math.max(requestedStartPageIndex, requestedEndPageIndex),
      startPageIndex,
      Math.min(chapters.length - 1, startPageIndex + 49),
    );
    const fixedVoiceProfile = hostedVoiceProfiles.find(
      (profile) => profile.role === 'narrator' && !profile.characterId,
    );
    if (!fixedVoiceProfile) {
      showToast('PDF 오프라인 준비에 사용할 내레이터 음성을 먼저 지정하세요.', 'warning');
      return;
    }
    const revisions = (await fixedDocumentTextRepository.listReadyRevisions(selectedNovel.id)).filter(
      (revision) => revision.pageIndex >= startPageIndex && revision.pageIndex <= endPageIndex,
    );
    const loadedRevisionBlocks = await Promise.all(
      revisions.map(async (revision) => ({
        revision,
        blocks: await fixedDocumentTextRepository.getBlocks(revision.id),
      })),
    );
    const { sources: revisionBlocks, skippedOcr } = selectFixedDocumentTtsSources(loadedRevisionBlocks);
    if (skippedOcr.length > 0) {
      showToast(
        `OCR 신뢰도가 낮은 ${skippedOcr.length}페이지는 오프라인 음성 준비에서 건너뜁니다. 해당 페이지를 다시 OCR해 주세요.`,
        'warning',
      );
    }
    const queue = buildFixedDocumentTtsQueue({
      blocks: revisionBlocks.flatMap((entry) => entry.blocks),
      language: selectedNovel.language,
      rules: spokenTextRules,
      rate: ttsPlaybackSettings.rate,
      voiceProfile: fixedVoiceProfile,
    });
    const sortedDocumentChapters = [...chapters].sort((left, right) => left.index - right.index);
    const { buildFixedDocumentTtsWarmupRequests } =
      await import('./features/fixed-document/text/fixed-document-tts-warmup');
    const requests = buildFixedDocumentTtsWarmupRequests({
      queue,
      chapters: sortedDocumentChapters,
      voiceProfiles: hostedVoiceProfiles,
      contentRevision: selectedNovel.activeContentRevisionId,
      providerOptionsByProvider: savedTTSSettings?.providerOptionsByProvider,
      modelByProvider: savedTTSSettings?.modelByProvider,
      pronunciationRevisionId: voiceProductController.state?.pronunciationProfile.revisionId,
      pronunciationFingerprint: voiceProductController.state?.pronunciationProfile.revisionId,
      capability: selectedHostedTTSCapability,
      voiceEntryFingerprintByVoiceId: selectedVoiceEntryFingerprintByVoiceId,
    });
    if (!requests.length) {
      showToast('선택 범위에 준비된 PDF 본문이 없습니다. 텍스트 준비 또는 OCR을 먼저 실행하세요.', 'warning');
      return;
    }
    const targetChapterIds = [...new Set(requests.map((request) => request.chapterId))];
    if (
      !desktopProviderMode &&
      (!providerApiClient ||
        !(await runConnectedProviderPreflight({
          syncBeforeJob: connectedProviderLocalMetadataPending
            ? () => syncConnectedProviderState('before_job')
            : undefined,
          targetStillActive: () => connectedProviderTargetStillActive(selectedNovel.id, currentChapter.id),
          ensureAttached: () => ensureConnectedProviderServerBookAttached(selectedNovel.id, targetChapterIds),
        })))
    )
      return;
    const operation = ttsExecutionController.beginWarmup(
      selectedNovel.id,
      currentChapter.id,
      'fixed_document_warmup_loading',
    );
    if (!operation) return;
    let persistDownloadFailure: (() => Promise<unknown>) | undefined;
    let persistDownloadCancellation: (() => Promise<unknown>) | undefined;
    try {
      const [{ IndexedDbTTSDownloadRepository }, { runNativeTTSWarmup }, { runHostedTTSWarmupQueue }] =
        await Promise.all([
          import('./storage/tts-download-store'),
          import('./features/tts/native-tts-warmup-runner'),
          import('./providers/hosted-tts-warmup-runner'),
        ]);
      const downloadRepository = new IndexedDbTTSDownloadRepository();
      const downloadJob = await downloadRepository.create({
        bookId: selectedNovel.id,
        contentRevisionId: selectedNovel.activeContentRevisionId,
        chapterIds: targetChapterIds,
        wholeBook: false,
        policy: offlineTTSRecoveryPolicy,
      });
      persistDownloadFailure = () => downloadRepository.finish(downloadJob.id, 'failed');
      persistDownloadCancellation = () => downloadRepository.cancel(downloadJob.id);
      if (desktopProviderMode) {
        if (!ttsCacheGateway) throw new Error('데스크톱 TTS cache gateway를 사용할 수 없습니다.');
        const requestsByChapter = new Map<string, HostedTTSWarmupRequest[]>();
        for (const request of requests) {
          const bucket = requestsByChapter.get(request.chapterId);
          if (bucket) bucket.push(request);
          else requestsByChapter.set(request.chapterId, [request]);
        }
        const targetChapters = sortedDocumentChapters.filter((chapter) => requestsByChapter.has(chapter.id));
        const summary = await runNativeTTSWarmup({
          novelId: selectedNovel.id,
          contentRevision: selectedNovel.activeContentRevisionId,
          chapters: targetChapters,
          signal: operation.controller.signal,
          gateway: ttsCacheGateway,
          loadChapterSource: async (chapter) => {
            const chapterRequests = requestsByChapter.get(chapter.id) ?? [];
            if (!chapterRequests.length) return undefined;
            return {
              chapterId: chapter.id,
              chapterTextHash: chapter.textHash,
              paragraphs: chapterRequests.map((request) => ({
                id: request.paragraphId,
                novelId: selectedNovel.id,
                chapterId: chapter.id,
                index: request.paragraphIndex,
                text: request.text,
                startOffsetInChapter: 0,
                endOffsetInChapter: request.text.length,
                textHash: request.request.inputTextHash,
              })),
              segments: [],
            };
          },
          buildRequests: (sources) => sources.flatMap((source) => requestsByChapter.get(source.chapterId) ?? []),
          retryLimit: downloadJob.policy.retryLimit,
          recoveryPolicy: {
            network: downloadJob.policy.network,
            charging: downloadJob.policy.charging,
          },
          onStatus: (status) => ttsExecutionController.setHostedStatus(operation, status),
          observer: {
            planned: (items) => downloadRepository.planItems(downloadJob.id, items),
            running: (renderSpecHash) => downloadRepository.markItemRunning(downloadJob.id, renderSpecHash),
            retrying: (renderSpecHash, error, nextAttemptAt) =>
              downloadRepository.markItemRetryWait(
                downloadJob.id,
                renderSpecHash,
                error instanceof Error ? error.message : String(error),
                nextAttemptAt,
              ),
            ready: (renderSpecHash, result) =>
              downloadRepository.markItemReady(downloadJob.id, renderSpecHash, {
                cacheKey: result.cacheKey,
                byteSize: result.byteSize,
              }),
            failed: (renderSpecHash, error) =>
              downloadRepository.markItemFailed(
                downloadJob.id,
                renderSpecHash,
                error instanceof Error ? error.message : String(error),
              ),
          },
        });
        if (summary.aborted) {
          await downloadRepository.cancel(downloadJob.id);
          return;
        }
        const unsuccessful = summary.failed + summary.sourceFailures + (summary.readiness?.missing ?? 0);
        const completed = await downloadRepository.finish(
          downloadJob.id,
          unsuccessful ? (summary.completed > 0 ? 'partial' : 'failed') : 'completed',
        );
        showToast(
          `PDF 오프라인 음성 ${completed?.readyItems ?? summary.completed}/${completed?.plannedItems ?? summary.total}개 준비`,
          unsuccessful ? 'warning' : 'success',
        );
        return;
      }

      for (const source of revisionBlocks) {
        operation.controller.signal.throwIfAborted();
        await providerApiClient!.saveDocumentTextPage(
          selectedNovel.id,
          source.revision,
          source.blocks,
          operation.controller.signal,
        );
      }
      await downloadRepository.planItems(
        downloadJob.id,
        requests.flatMap((request) => {
          const renderSpec = request.request.renderSpec;
          if (!renderSpec) return [];
          const renderSpecHash = ttsRenderSpecHash(renderSpec);
          return [
            {
              chapterId: request.chapterId,
              paragraphId: request.paragraphId,
              cacheKey: renderSpecHash,
              renderSpecHash,
            },
          ];
        }),
      );
      const summary = await runHostedTTSWarmupQueue({
        requests,
        signal: operation.controller.signal,
        resolveCache: (request, signal) =>
          providerApiClient!.resolveTTSCache(request.chapterId, request.request, signal),
        pollJob: (job, signal) => ttsExecutionController.pollHostedJob(job.id, signal, { operation }),
        fetchAudio: async (request, resolved, signal) => {
          const cached = await hostedTTSOfflineCache
            .getByCacheKey(selectedNovel.id, resolved.cacheKey)
            .catch(() => undefined);
          if (cached) return cached.blob;
          const audio = await providerApiClient!.fetchTTSCacheAudio(request.chapterId, resolved.cacheKey, signal);
          const renderSpec = request.request.renderSpec;
          if (!renderSpec) throw new Error('Hosted TTS render specification is missing.');
          await hostedTTSOfflineCache.put({
            bookId: selectedNovel.id,
            chapterId: request.chapterId,
            cacheKey: resolved.cacheKey,
            renderSpecHash: ttsRenderSpecHash(renderSpec),
            contentRevisionId: selectedNovel.activeContentRevisionId!,
            blob: audio,
          });
          return audio;
        },
        onRequestStart: (request) =>
          request.request.renderSpec
            ? downloadRepository.markItemRunning(downloadJob.id, ttsRenderSpecHash(request.request.renderSpec))
            : undefined,
        onRequestReady: (request, resolved, audio) =>
          request.request.renderSpec && audio
            ? downloadRepository.markItemReady(downloadJob.id, ttsRenderSpecHash(request.request.renderSpec), {
                cacheKey: resolved.cacheKey,
                byteSize: audio.size,
                storage: 'indexeddb',
              })
            : undefined,
        onRequestRetry: (request, error, nextAttemptAt) =>
          request.request.renderSpec
            ? downloadRepository.markItemRetryWait(
                downloadJob.id,
                ttsRenderSpecHash(request.request.renderSpec),
                error instanceof Error ? error.message : String(error),
                nextAttemptAt,
              )
            : undefined,
        onRequestFailed: (request, error) =>
          request.request.renderSpec
            ? downloadRepository.markItemFailed(
                downloadJob.id,
                ttsRenderSpecHash(request.request.renderSpec),
                error instanceof Error ? error.message : String(error),
              )
            : undefined,
        retryLimit: downloadJob.policy.retryLimit,
        wait: abortableDelay,
        onStatus: (status) => ttsExecutionController.setHostedStatus(operation, status),
        onJob: (job) => ttsExecutionController.setHostedJob(operation, job),
        isAbortError,
      });
      if (summary.aborted) {
        await downloadRepository.cancel(downloadJob.id);
        return;
      }
      const completed = await downloadRepository.finish(
        downloadJob.id,
        summary.failed ? (summary.completed > 0 ? 'partial' : 'failed') : 'completed',
      );
      showToast(
        `PDF 오프라인 음성 ${completed?.readyItems ?? summary.completed}/${completed?.plannedItems ?? summary.total}개 준비`,
        summary.failed ? 'warning' : 'success',
      );
    } catch (error) {
      if (isAbortError(error)) {
        await persistDownloadCancellation?.().catch(() => undefined);
        return;
      }
      await persistDownloadFailure?.().catch(() => undefined);
      showToast(`PDF 오프라인 음성 준비 실패: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    } finally {
      ttsExecutionController.finishOperation(operation);
      await refreshOfflineTTSDownloadJob().catch(() => undefined);
    }
  };

  const startFixedDocumentTTS = async (
    requestedPageIndex: number,
    requestedBlockId?: string,
    requestedStartOffset?: number,
  ) => {
    if (!selectedNovel || view !== 'document' || !currentChapter || !selectedNovel.activeContentRevisionId) return;
    stopProviderSamples();
    const status = await refreshTTSState();
    if (!status?.canSpeak && !hostedTTSPlaybackReady) {
      showToast(status?.message ?? '사용 가능한 TTS 음성이 없습니다.', 'warning');
      return;
    }
    const fixedVoiceProfile = hostedTTSPlaybackReady
      ? hostedVoiceProfiles.find((profile) => profile.role === 'narrator' && !profile.characterId)
      : activeSystemVoiceProfiles.find((profile) => profile.role === 'narrator' && !profile.characterId);
    const revisions = await fixedDocumentTextRepository.listReadyRevisions(selectedNovel.id);
    const selectedRevisions = revisions.filter((revision) => revision.pageIndex >= requestedPageIndex);
    const loadedRevisionBlocks = await Promise.all(
      selectedRevisions.map(async (revision) => ({
        revision,
        blocks: await fixedDocumentTextRepository.getBlocks(revision.id),
      })),
    );
    const { sources: revisionBlocks, skippedOcr } = selectFixedDocumentTtsSources(loadedRevisionBlocks);
    if (skippedOcr.length > 0) {
      showToast(
        `OCR 신뢰도가 낮은 ${skippedOcr.length}페이지는 TTS에서 건너뜁니다. 해당 페이지를 다시 OCR해 주세요.`,
        'warning',
      );
    }
    const blocks = revisionBlocks.flatMap((entry) => entry.blocks);
    const revisionById = new Map(revisionBlocks.map((entry) => [entry.revision.id, entry]));
    const queue = buildFixedDocumentTtsQueue({
      blocks,
      language: selectedNovel.language,
      rules: spokenTextRules,
      rate: ttsPlaybackSettings.rate,
      voiceProfile: fixedVoiceProfile,
    });
    const requestedIndex = requestedBlockId
      ? queue.findIndex((item) => {
          if (item.block.id !== requestedBlockId) return false;
          if (requestedStartOffset === undefined) return true;
          const range = fixedDocumentTtsSourceRange(item.playable, item.block);
          return requestedStartOffset >= range.startOffset && requestedStartOffset < range.endOffset;
        })
      : queue.findIndex((item) => item.block.pageIndex >= requestedPageIndex);
    if (requestedBlockId && requestedIndex < 0) {
      const requestedSource = loadedRevisionBlocks.find((source) =>
        source.blocks.some((block) => block.id === requestedBlockId),
      );
      const rejectedForOcrQuality = skippedOcr.some((source) => source.revisionId === requestedSource?.revision.id);
      showToast(
        rejectedForOcrQuality
          ? '선택한 OCR 텍스트의 신뢰도가 낮습니다. 해당 페이지를 다시 OCR한 뒤 재생해 주세요.'
          : '선택한 위치에서 재생할 문장을 찾지 못했습니다. TTS 건너뛰기 규칙을 확인해 주세요.',
        'warning',
      );
      return;
    }
    const startIndex = Math.max(0, requestedIndex);
    if (!queue[startIndex]) {
      showToast(
        '이 페이지부터 재생할 준비된 PDF 텍스트가 없습니다. 텍스트 준비 또는 OCR을 먼저 실행하세요.',
        'warning',
      );
      return;
    }
    const sortedDocumentChapters = [...chapters].sort((left, right) => left.index - right.index);
    const sessionTarget = `fixed_document_${selectedNovel.id}`;
    const hostedFixedDocumentMode = !desktopProviderMode && hostedTTSPlaybackReady && Boolean(providerApiClient);
    let hostedFixedDocumentReady = hostedFixedDocumentMode;
    if (hostedFixedDocumentMode && !ttsPlaybackSettings.offlineOnly) {
      const chapterIds = [
        ...new Set(
          queue.slice(startIndex).map((item) => sortedDocumentChapters[item.block.pageIndex]?.id ?? currentChapter.id),
        ),
      ];
      hostedFixedDocumentReady = await runConnectedProviderPreflight({
        syncBeforeJob: connectedProviderLocalMetadataPending
          ? () => syncConnectedProviderState('before_job')
          : undefined,
        targetStillActive: () => connectedProviderTargetStillActive(selectedNovel.id, currentChapter.id),
        ensureAttached: () => ensureConnectedProviderServerBookAttached(selectedNovel.id, chapterIds),
      });
    }
    const sessionId = ttsExecutionController.beginSession(selectedNovel.id, sessionTarget, startIndex);
    if (sessionId === undefined) return;
    const signal = ttsExecutionController.sessionSignal(sessionId);
    if (!signal) return;
    const uploadedTextRevisions = new Set<string>();
    try {
      for (let index = startIndex; index < queue.length; index += 1) {
        if (!ttsExecutionController.isSessionCurrent(sessionId) || signal.aborted) return;
        if (!(await ttsExecutionController.waitForResume(sessionId))) return;
        const { block, playable } = queue[index];
        const chapter = sortedDocumentChapters[block.pageIndex] ?? currentChapter;
        const sourceRange = fixedDocumentTtsSourceRange(playable, block);
        const sourceQuads = fixedDocumentTtsRangeQuads(block, sourceRange.startOffset, sourceRange.endOffset);
        const paragraph = fixedDocumentTtsParagraph(block, selectedNovel.id, chapter.id);
        const sourceSegment = fixedDocumentTtsSegment(block, selectedNovel.id, chapter.id, sourceRange);
        ttsExecutionController.setParagraph(sessionId, index);
        ttsExecutionController.setActivePlayback(sessionId, {
          paragraphId: block.id,
          speakerLabel: '내레이터',
          segmentIds: [block.id],
          ranges: [{ start: sourceRange.startOffset, end: sourceRange.endOffset }],
        });
        const position = await saveListeningPosition({
          bookId: selectedNovel.id,
          chapterId: chapter.id,
          contentRevisionId: selectedNovel.activeContentRevisionId,
          queueItemFingerprint: ttsQueueItemFingerprint(playable),
          settingsFingerprint: ttsResumeFingerprint,
          anchor: {
            kind: 'fixed_text',
            bookId: selectedNovel.id,
            pageIndex: block.pageIndex,
            textRevisionId: block.revisionId,
            blockId: block.id,
            startOffset: sourceRange.startOffset,
            endOffset: sourceRange.endOffset,
            quads: sourceQuads,
          },
        });
        setTTSListeningPosition(position);
        await readerMutationCommittedRef.current('progress');
        ttsExecutionController.setItemActive(sessionId, true);
        try {
          let providerPlayed = false;
          if (desktopProviderMode && hostedTTSPlaybackReady) {
            providerPlayed = await playDesktopTtsSegment(playable, paragraph, sessionId, [sourceSegment]);
          } else if (hostedFixedDocumentMode && (ttsPlaybackSettings.offlineOnly || hostedFixedDocumentReady)) {
            if (!ttsPlaybackSettings.offlineOnly && !uploadedTextRevisions.has(block.revisionId)) {
              const source = revisionById.get(block.revisionId);
              if (!source) {
                hostedFixedDocumentReady = false;
              } else {
                try {
                  await providerApiClient!.saveDocumentTextPage(
                    selectedNovel.id,
                    source.revision,
                    source.blocks,
                    signal,
                  );
                  uploadedTextRevisions.add(block.revisionId);
                } catch (error) {
                  hostedFixedDocumentReady = false;
                  showToast(
                    `PDF 텍스트를 서버에 준비하지 못해 시스템 TTS로 전환합니다: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    'warning',
                  );
                }
              }
            }
            if (ttsPlaybackSettings.offlineOnly || hostedFixedDocumentReady) {
              providerPlayed = await playHostedTtsSegment(playable, paragraph, sessionId, [sourceSegment], {
                skipConnectedPreflight: true,
              });
            }
          }
          if (!providerPlayed) {
            await new Promise<void>((resolve, reject) => {
              let settled = false;
              const finish = (error?: string) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', cancelled);
                if (error) reject(new Error(error));
                else resolve();
              };
              const cancelled = () => finish();
              signal.addEventListener('abort', cancelled, { once: true });
              void systemTTS
                .speak({
                  text: playable.text,
                  rate: playable.rate,
                  pitch: ttsPlaybackSettings.pitch,
                  volume: ttsPlaybackSettings.volume,
                  voiceURI: playable.voiceURI ?? settings.ttsVoiceURI,
                  mediaMetadata: {
                    title: `${chapter.title} · ${block.pageIndex + 1}페이지`,
                    album: selectedNovel.title,
                    artist: selectedNovel.author,
                  },
                  playbackAnchor: {
                    kind: 'fixed_text',
                    bookId: selectedNovel.id,
                    chapterId: chapter.id,
                    pageIndex: block.pageIndex,
                    textRevisionId: block.revisionId,
                    blockId: block.id,
                    startOffset: sourceRange.startOffset,
                    endOffset: sourceRange.endOffset,
                    queueItemFingerprint: ttsQueueItemFingerprint(playable),
                  },
                  onEnd: () => finish(),
                  onError: (message) => finish(message),
                })
                .catch((error) => finish(error instanceof Error ? error.message : 'PDF TTS 재생 오류'));
            });
          }
        } finally {
          ttsExecutionController.setItemActive(sessionId, false);
        }
        if (ttsExecutionController.shouldStopAfterItem()) {
          ttsExecutionController.finishSession(sessionId);
          return;
        }
        if (
          !(await waitForPlaybackDelay({
            durationMs: ttsPlaybackSettings.sentencePauseMs,
            shouldContinue: () => ttsExecutionController.isSessionCurrent(sessionId),
            waitForResume: () => ttsExecutionController.waitForResume(sessionId),
            signal,
          }))
        ) {
          return;
        }
      }
      if (ttsExecutionController.finishSession(sessionId)) showToast('준비된 PDF 텍스트 재생을 마쳤습니다.', 'info');
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : 'PDF TTS를 재생하지 못했습니다.';
      ttsExecutionController.finishSession(sessionId, { preserveIndex: true, errorMessage: message });
      showToast(message, 'danger');
    }
  };

  const jumpTTS = async (direction: -1 | 1) => {
    if (view === 'document' && selectedNovel && activeTTSPlayback) {
      const revisions = await fixedDocumentTextRepository.listReadyRevisions(selectedNovel.id);
      const loadedRevisionBlocks = await Promise.all(
        revisions.map(async (revision) => ({
          revision,
          blocks: await fixedDocumentTextRepository.getBlocks(revision.id),
        })),
      );
      const { sources } = selectFixedDocumentTtsSources(loadedRevisionBlocks);
      const blocks = sources.flatMap((source) => source.blocks);
      const queue = buildFixedDocumentTtsQueue({
        blocks,
        language: selectedNovel.language,
        rules: spokenTextRules,
        rate: ttsPlaybackSettings.rate,
      });
      const currentRange = activeTTSPlayback.ranges[0];
      const currentIndex = queue.findIndex((item) => {
        if (item.block.id !== activeTTSPlayback.paragraphId) return false;
        const range = fixedDocumentTtsSourceRange(item.playable, item.block);
        return !currentRange || (range.startOffset === currentRange.start && range.endOffset === currentRange.end);
      });
      const target = queue[clamp(currentIndex + direction, 0, Math.max(0, queue.length - 1))];
      if (target) {
        const range = fixedDocumentTtsSourceRange(target.playable, target.block);
        await startFixedDocumentTTS(target.block.pageIndex, target.block.id, range.startOffset);
      }
      return;
    }
    const chapter = currentChapter;
    const paragraphCount = chapter?.paragraphCount ?? 0;
    if (!paragraphCount) return;
    stopProviderSamples();
    const nextIndex = clamp(
      (ttsIndex ?? readerScreenHandle.getLocation()?.ttsIndex ?? 0) + direction,
      0,
      paragraphCount - 1,
    );
    const status = await refreshTTSState();
    if (!status) return;
    if (!status.canSpeak && !hostedTTSPlaybackReady) {
      showToast(status.message, 'warning');
      return;
    }
    if (!chapter) return;
    const sessionId = ttsExecutionController.beginSession(chapter.novelId, chapter.id, nextIndex, {
      preserveSleepTimer: ttsPlaying,
    });
    if (sessionId === undefined) return;
    setReaderMode('listen');
    await speakAt(nextIndex, sessionId);
  };

  const resumeSavedTTS = async () => {
    if (!selectedNovel || !ttsResumeRecord) return;
    const chapter = chapters.find((item) => item.id === ttsResumeRecord.chapterId);
    if (!chapter) {
      clearTTSPlaybackResume(selectedNovel.id);
      await clearListeningPosition(selectedNovel.id);
      await readerMutationCommittedRef.current('progress');
      setTTSListeningPosition(undefined);
      setTTSResumeRecord(undefined);
      showToast('저장된 TTS 위치가 현재 책에 없어 새로 시작합니다.', 'warning');
      return;
    }
    if (chapter.id === currentChapter?.id) {
      await startTTS(ttsResumeRecord.paragraphIndex, {
        queueItemFingerprint: ttsListeningPosition?.queueItemFingerprint,
      });
      return;
    }
    bookPlaybackCoordinator.schedule({
      bookId: selectedNovel.id,
      chapterId: chapter.id,
      startIndex: Math.min(ttsResumeRecord.paragraphIndex, Math.max(0, chapter.paragraphCount - 1)),
      queueItemFingerprint: ttsListeningPosition?.queueItemFingerprint,
    });
    await bookWorkspace.openChapter(chapter, { novel: selectedNovel, initialMode: 'listen' });
  };

  const pauseTTS = ttsExecutionController.pause;

  const resumeTTS = ttsExecutionController.resume;

  const stopTTS = () => {
    bookPlaybackCoordinator.cancel();
    ttsExecutionController.stopAll();
    stopProviderSamples();
  };
  const startTTSRef = useRef(startTTS);
  const ttsMediaActionsRef = useRef({ pause: pauseTTS, resume: resumeTTS, stop: stopTTS, jump: jumpTTS });
  startTTSRef.current = startTTS;
  ttsMediaActionsRef.current = { pause: pauseTTS, resume: resumeTTS, stop: stopTTS, jump: jumpTTS };

  useEffect(() => {
    if (!selectedNovel || !currentChapter) return;
    const pending = bookPlaybackCoordinator.take(selectedNovel.id, currentChapter.id);
    if (!pending) return;
    const timeout = window.setTimeout(() => {
      void startTTSRef.current(pending.startIndex, {
        preserveSleepTimer: true,
        queueItemFingerprint: pending.queueItemFingerprint,
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [bookPlaybackCoordinator, currentChapter, selectedNovel]);

  useEffect(() => {
    if (!selectedNovel || !currentChapter) {
      mediaSession.clear();
      return;
    }
    mediaSession.setMetadata({
      title: currentChapter.title,
      artist: selectedNovel.author,
      album: selectedNovel.title,
    });
    mediaSession.setHandlers({
      play: ttsPaused ? ttsMediaActionsRef.current.resume : () => void startTTSRef.current(),
      pause: ttsMediaActionsRef.current.pause,
      stop: ttsMediaActionsRef.current.stop,
      previous: () => void ttsMediaActionsRef.current.jump(-1),
      next: () => void ttsMediaActionsRef.current.jump(1),
    });
    mediaSession.setPlaybackState(ttsPlaying ? (ttsPaused ? 'paused' : 'playing') : 'none');
    return () => mediaSession.clear();
  }, [currentChapter, mediaSession, selectedNovel, ttsPaused, ttsPlaying]);

  const appBackLayers: readonly AppBackLayer[] = [
    { id: 'import', open: importFeature.isOpen, dismiss: importFeature.close },
    { id: 'external-sources', open: externalSourceFeature.open, dismiss: externalSourceFeature.close },
    {
      id: 'chapter-structure',
      open: chapterStructureFeature.open,
      dismiss: chapterStructureFeature.closePanel,
    },
    { id: 'backup', open: backupFeature.open, dismiss: backupFeature.closePanel },
    { id: 'settings', open: settingsOpen, dismiss: readerSettingsController.closePanel },
    { id: 'sync', open: syncPanelOpen, dismiss: () => setSyncPanelOpen(false) },
    {
      id: 'library-management',
      open: Boolean(libraryManagement.panel),
      dismiss: libraryManagement.closePanel,
    },
    { id: 'reader-addon', open: view === 'reader' && addonOpen, dismiss: () => setAddonOpen(false) },
    {
      id: 'library-selection',
      open: view === 'library' && libraryManagement.selectionMode,
      dismiss: libraryManagement.clearSelection,
    },
    {
      id: 'chapter-title-editor',
      open: view === 'chapters' && bookWorkspaceState.bookTitleEditing,
      dismiss: bookWorkspace.cancelBookTitleEdit,
    },
  ];
  const closeActiveAppLayer = () => Boolean(dismissTopAppBackLayer(appBackLayers));

  useAndroidAppEvents(platformRuntime, {
    onBack: () => {
      if (dispatchAndroidBackEscape()) return true;
      return handleAppBackNavigation({
        layers: appBackLayers,
        view,
        returnToChapters: bookWorkspace.returnToChapters,
        returnToLibrary: () => bookWorkspace.setView('library'),
      }).handled;
    },
    onLifecycle: (phase) => {
      if (phase === 'background') void readerScreenHandle.flushSession();
    },
  });

  const readerScreenModel = useReaderBasicsScreenModel({
    novel: selectedNovel,
    chapter: currentChapter,
    chapters,
    settingsController: readerSettingsController,
    annotationsController,
    localReadingPosition,
    addonOpen,
    addonTab,
    overlays: { syncPanelOpen, importOpen: importFeature.isOpen },
    ttsIndex,
    openRequestVersion: readerOpenRequestVersion,
    effectiveSettings: effectiveReaderSettings,
  });

  useLayoutEffect(() => {
    readerScreenHandle.updateDecorations({
      segments,
      characters,
      highlights,
      reviewSegmentIds: correctionReviewSegmentIds,
      correctionTargetId: correctionTarget?.id,
      activePlayback: activeTTSPlayback,
    });
  }, [
    activeTTSPlayback,
    characters,
    correctionReviewSegmentIds,
    correctionTarget?.id,
    highlights,
    readerScreenHandle,
    segments,
  ]);

  readerScreenHandle.setActions({
    openChapter: (chapter, options = {}) => bookWorkspace.openChapter(chapter, { ...options, novel: selectedNovel }),
    returnToChapters: bookWorkspace.returnToChapters,
    openSettings: openReaderSettings,
    openSync: () => setSyncPanelOpen(true),
    toggleAddon: () => setAddonOpen((open) => !open),
    openAddon: (tab: AddonTab) => {
      setAddonTab(
        tab === 'info'
          ? extensionRuntime.trustedExtensions.getReaderAddon(READER_INFO_ADDON_ID)
            ? READER_INFO_ADDON_ID
            : 'outline'
          : tab,
      );
      setAddonOpen(true);
      revealChrome();
    },
    closeActiveLayer: closeActiveAppLayer,
    adjustFontSize: (delta: number) =>
      changeReadingProfile({ fontSize: clamp(readingProfile.fontSize + delta, 11, 40) }),
    adjustContentWidth: (delta: number) =>
      changeReadingProfile({ contentWidth: clamp(readingProfile.contentWidth + delta, 420, 1280) }),
    toggleNightTheme: () =>
      changeReadingProfile({
        theme: readingProfile.theme === 'dark' || readingProfile.theme === 'midnight' ? 'light' : 'dark',
      }),
    toggleBookmark: (location: ReaderLocationSnapshot) => toggleBookmark(location),
    addHighlight: (location: ReaderLocationSnapshot, selection?: ReaderSelection) =>
      void addHighlight('yellow', location, selection),
    highlightSelection: (
      location: ReaderLocationSnapshot,
      selection: ReaderSelection,
      color: ReaderHighlight['color'],
    ) => void addHighlight(color, location, selection),
    openSelectionNote,
    previewSelectionTTS: (selection: ReaderSelection) => {
      const text = selection.text.trim();
      if (!text) return;
      setSpokenPreviewRequest((current) => ({ id: (current?.id ?? 0) + 1, text }));
      setAddonTab('tts');
      setAddonOpen(true);
      revealChrome();
    },
    selectCorrectionSegment: (segmentId: string) => {
      const segment = segments.find((candidate) => candidate.id === segmentId);
      if (segment) selectCorrectionSegment(segment);
    },
    startTTS: (paragraphIndex: number) => void startTTS(paragraphIndex),
    toggleTTS: (paragraphIndex: number) => (ttsPlaying ? stopTTS() : void startTTS(paragraphIndex)),
    modeChanged: bookWorkspace.setReaderMode,
    locationCommitted: (location, bookProgress, updatedAt) => {
      if (!selectedNovel || !currentChapter) return;
      bookWorkspace.commitLocation({
        novelId: selectedNovel.id,
        chapterId: currentChapter.id,
        location,
        bookProgress,
        updatedAt,
      });
    },
    locationPersistenceFailed: bookWorkspace.locationPersistenceFailed,
    sessionTimeCommitted: bookWorkspace.commitSessionTime,
    sessionTimePersistenceFailed: () => undefined,
    sessionDisplayChanged: bookWorkspace.setReaderSessionDisplaySeconds,
    notify: showToast,
  });

  const activeTrustedReaderAddon = extensionRuntime.trustedExtensions.getReaderAddon(addonTab);
  const aiWorkflowPanelData: AIWorkflowPanelData = {
    stageLabel: activeBookAIWorkflow ? bookAIWorkflowStageLabel(activeBookAIWorkflow.stage) : '계획 대기',
    graphBundleCount: activeBookAIWorkflowPlan?.bundleWindows.length ?? activeBookAIWorkflowProgress.totalBundleWindows,
    labelingWindowCount:
      activeBookAIWorkflowPlan?.labelingWindows.length ?? activeBookAIWorkflowProgress.totalLabelingWindows,
    succeededJobCount: activeBookAIWorkflowProgress.childSucceeded,
    pendingJobCount: activeBookAIWorkflowProgress.childPending,
    failedJobCount: activeBookAIWorkflowProgress.childFailed,
    labelingBudget: activeBookAIWorkflowPlan?.labelingBudget
      ? {
          targetCharacters: activeBookAIWorkflowPlan.labelingBudget.targetLabelingCharacters,
          contextWindowTokens: activeBookAIWorkflowPlan.labelingBudget.capability.contextWindowTokens,
          reservedOutputTokens: activeBookAIWorkflowPlan.labelingBudget.capability.maxOutputTokens,
          estimated: activeBookAIWorkflowPlan.labelingBudget.capability.tokenCountMode === 'estimated_characters',
        }
      : undefined,
    workflow: activeBookAIWorkflow
      ? {
          status: activeBookAIWorkflow.status,
          stage: activeBookAIWorkflow.stage,
          jobCount: activeBookAIWorkflow.jobs.length,
          modelId: activeBookAIWorkflow.modelId,
          errorMessage: activeBookAIWorkflow.errorMessage,
        }
      : undefined,
    compactSpeaker: bookAIWorkflowCompactSpeakerView(activeBookAIWorkflow),
    labelVoiceReadiness: activeBookAIWorkflowTtsReadiness
      ? {
          ok: activeBookAIWorkflowTtsReadiness.ok === true,
          segmentCount: progressNumber(activeBookAIWorkflowTtsReadinessMetrics, 'segmentCount') ?? 0,
          missingParagraphCount:
            progressNumber(activeBookAIWorkflowTtsReadinessMetrics, 'missingPlannedParagraphCount') ?? 0,
          missingVoiceCount:
            progressNumber(activeBookAIWorkflowTtsReadinessMetrics, 'missingCharacterVoiceProfileCount') ?? 0,
          unknownPercent: Math.round(
            (progressNumber(activeBookAIWorkflowTtsReadinessMetrics, 'unknownSegmentRatio') ?? 0) * 100,
          ),
        }
      : undefined,
    cacheReadiness: activeBookAIWorkflowTtsCacheReadiness
      ? {
          ok: activeBookAIWorkflowTtsCacheReadiness.ok === true,
          cachedSegmentCount: progressNumber(activeBookAIWorkflowTtsCacheReadinessMetrics, 'cachedSegmentCount') ?? 0,
          cacheableSegmentCount:
            progressNumber(activeBookAIWorkflowTtsCacheReadinessMetrics, 'cacheableSegmentCount') ?? 0,
          missingCachedSegmentCount:
            progressNumber(activeBookAIWorkflowTtsCacheReadinessMetrics, 'missingCachedSegmentCount') ?? 0,
          cacheItemCount: progressNumber(activeBookAIWorkflowTtsCacheReadinessMetrics, 'cacheItemCount') ?? 0,
          cachedByteSizeLabel: formatBytes(
            progressNumber(activeBookAIWorkflowTtsCacheReadinessMetrics, 'cachedByteSize') ?? 0,
          ),
        }
      : undefined,
    labelVoiceReady: bookAIWorkflowLabelVoiceReady,
    cacheReady: bookAIWorkflowCacheReady,
    reviewItems: activeBookAIWorkflowReviewItems,
    reviewWorkspace: {
      available: analysisReviewController.available,
      reviews: analysisReviewController.reviews,
      loading: analysisReviewController.loading,
      busyReviewId: analysisReviewController.busyReviewId,
      error: analysisReviewController.error,
    },
    workflowRuntime: bookAITTSPreparationRunner?.runtime,
    error: bookAIWorkflowError,
    retryDisabled: bookAIWorkflowRetryDisabled,
    cancelDisabled: bookAIWorkflowCancelDisabled,
    startDisabled: bookAIWorkflowDisabled || bookAIWorkflowBusy,
    refreshDisabled: !bookAIWorkflowAvailable || !selectedNovel || bookAIWorkflowLoading,
    warmupDisabled: bookAIWorkflowWarmupDisabled,
    cacheRefreshDisabled: bookAIWorkflowCacheRefreshDisabled,
  };
  const aiWorkflowPanelActions: AIAddonPanelActions['workflow'] = {
    retry: retryBookAIWorkflow,
    cancel: cancelBookAIWorkflow,
    start: startBookAIWorkflow,
    refresh: refreshBookAIWorkflowStatus,
    warmupBookCache: () => {
      setAddonTab('tts');
      return warmupHostedTTSCache('book');
    },
    refreshCacheReadiness: refreshBookAIWorkflowTTSCacheReadiness,
    runReviewAction: runBookAIWorkflowReviewAction,
    refreshReviews: analysisReviewController.refresh,
    saveReviewDraft: analysisReviewController.saveDraft,
    approveReview: analysisReviewController.approve,
    rejectReview: analysisReviewController.reject,
  };
  const trustedAnalysisWorkflowHostContext: TrustedAnalysisWorkflowHostContext = {
    target: selectedNovel
      ? {
          bookId: selectedNovel.id,
          contentRevisionId: selectedNovel.activeContentRevisionId,
          chapterId: currentChapter?.id,
        }
      : undefined,
    bookAITTS: {
      enabled: Boolean(bookAITTSPreparationRunner && selectedNovel),
      data: aiWorkflowPanelData,
      actions: aiWorkflowPanelActions,
    },
    characterBundleAnalysis: {
      enabled: !bundleAnalysisDisabled,
      run: () => (desktopProviderMode ? runDesktopBundleAnalysisJob() : runRemoteBundleAnalysisJob()),
    },
  };
  const managedBookWorkflowSurface =
    managedBookWorkflow.active && managedBookWorkflow.active.isEnabled?.(trustedAnalysisWorkflowHostContext) !== false
      ? extensionRuntime.trustedExtensions.renderAnalysisWorkflow(
          managedBookWorkflow.active.descriptor.id,
          trustedAnalysisWorkflowHostContext,
        )
      : undefined;
  const managedBookWorkflowSwitchDisabled =
    bookAIWorkflowLoading || Boolean(activeBookAIWorkflow && !isTerminalBookAIWorkflow(activeBookAIWorkflow));
  const selectBookAIWorkflow = (workflowId: ExtensionContributionId) => {
    if (!selectedNovel) return;
    if (managedBookWorkflowSwitchDisabled) {
      showToast('진행 중인 AI 분석을 취소하거나 완료한 뒤 분석 방식을 변경해 주세요.', 'warning');
      return;
    }
    updateSettings((previous) => ({
      ...previous,
      aiWorkflows: selectManagedBookWorkflow(previous.aiWorkflows, selectedNovel.id, workflowId),
    }));
  };
  const runTrustedAnalysisWorkflow = async (workflowId: ExtensionContributionId): Promise<void> => {
    try {
      await extensionRuntime.trustedExtensions.executeAnalysisWorkflow(workflowId, trustedAnalysisWorkflowHostContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`AI workflow를 실행하지 못했습니다: ${message}`, 'danger');
    }
  };
  const aiReaderAddonSurface = (
    <Suspense fallback={<div className="panel-body" aria-busy="true" />}>
      <AIAddonPanel
        data={{
          workflow: aiWorkflowPanelData,
          analysis: {
            showDeveloperTools: SHOW_DEVELOPER_AI_TOOLS,
            desktopProviderMode,
            desktopAnalysisDisabled,
            remoteAnalysisDisabled,
            labelRepairDisabled,
            graphMergeDisabled,
            segmentCount: segments.length,
            bundleStatusLabel: lastBundleAnalysisSummary.discoveredGraph
              ? `후보 ${lastBundleAnalysisSummary.discoveredCharacterCount ?? 0}명 · 관계 ${lastBundleAnalysisSummary.discoveredRelationCount ?? 0}개`
              : `현재 화부터 ${bundleAnalysisChapters.length}화`,
            providerStatusLabel: remoteAnalysisRunning
              ? `${remoteAnalysisJob?.stage ?? remoteAnalysisJob?.status ?? 'queued'}`
              : llmProviderBlocked && selectedLLMProvider
                ? providerReadinessLabel(selectedLLMProvider)
                : providerSettingsMode
                  ? selectedLLMLabel
                  : SHOW_DEVELOPER_AI_TOOLS
                    ? 'Mock only'
                    : 'provider 미연결',
            remoteJob: remoteAnalysisJob,
            providers: llmProviders,
            providerDraft: llmDraft,
            workflows: trustedAnalysisWorkflows
              .filter((workflow) => (workflow.descriptor.kind ?? 'action') === 'action')
              .map((workflow) => ({
                ...workflow.descriptor,
                disabled: workflow.isEnabled?.(trustedAnalysisWorkflowHostContext) === false,
              })),
          },
          graphReview:
            graphReview || graphKnowledgeData
              ? {
                  includedCharacterCount: graphReview?.reviewedGraph.characters.length ?? characters.length,
                  candidateCount: graphReview?.candidates.length ?? 0,
                  newCandidateCount: graphReview?.newCandidateCount ?? 0,
                  duplicateCandidateCount: graphReview?.duplicateCandidateCount ?? 0,
                  lowConfidenceCount: graphReview?.lowConfidenceCount ?? 0,
                  relationCount: graphReview?.reviewedGraph.relations.length ?? 0,
                  invalidRelationCount: graphReview?.invalidRelationCount ?? 0,
                  parseError: graphReview?.parseError,
                  candidates: graphReviewCandidates.map((candidate) => ({
                    id: candidate.character.id,
                    name: candidate.character.canonicalName,
                    confidence: candidate.character.confidence,
                    detailLabel: graphCandidateDetailLabel(candidate),
                    excluded: candidate.excluded,
                  })),
                  knowledge: graphKnowledgeData,
                }
              : undefined,
          correction: {
            segmentCount: segments.length,
            reviewItems: correctionReviewItems.map((item) => ({
              segment: item.segment,
              speakerLabel: speakerLabel(item.segment, characters),
              reasons: item.reasons,
              snippet: segmentSnippet(item.segment),
            })),
            readerMode,
            characters,
            target: correctionTarget,
            targetSnippet: correctionTarget ? segmentSnippet(correctionTarget) : undefined,
            speakerDraft: correctionSpeakerDraft,
            speakerOptions: correctionSpeakerOptions,
            candidateSpeakerOptions:
              correctionTarget?.candidateSpeakers.map((speakerId) => ({
                id: speakerId,
                label: speakerIdLabel(speakerId, characters),
              })) ?? [],
            emotionDraft: correctionEmotionDraft,
            emotionOptions: correctionEmotionOptions,
            scope: correctionScope,
          },
        }}
        actions={{
          workflow: aiWorkflowPanelActions,
          analysis: {
            runMock: runMockAnalysis,
            runDesktop: runDesktopAnalysisJob,
            runRemote: runRemoteAnalysisJob,
            repairLabels: () => (desktopProviderMode ? runDesktopLabelRepairJob() : runRemoteLabelRepairJob()),
            runWorkflow: runTrustedAnalysisWorkflow,
            mergeGraph: () => (desktopProviderMode ? runDesktopGraphMergeJob() : runRemoteGraphMergeJob()),
          },
          graphReview: {
            toggleCandidate: toggleGraphReviewCandidate,
            confirmFact: (factId) => graphKnowledgeController.decideFact(factId, 'active'),
            rejectFact: (factId) => graphKnowledgeController.decideFact(factId, 'rejected'),
            mergeCandidate: graphKnowledgeController.mergeCandidate,
            splitFact: graphKnowledgeController.splitFact,
          },
          correction: {
            selectSegment: (segment) => {
              selectCorrectionSegment(segment);
              return scrollToParagraph(segment.paragraphId);
            },
            setReaderMode,
            setSpeakerDraft: setCorrectionSpeakerDraft,
            setEmotionDraft: setCorrectionEmotionDraft,
            setScope: setCorrectionScope,
            apply: applyCorrectionDraft,
            close: () => setCorrectionTarget(undefined),
          },
        }}
        managedWorkflow={{
          active: managedBookWorkflow.active?.descriptor,
          options: managedBookWorkflow.available.map(({ descriptor }) => descriptor),
          surface: managedBookWorkflowSurface,
          usedFallback: managedBookWorkflow.usedFallback,
          switchDisabled: managedBookWorkflowSwitchDisabled,
          switchDisabledReason: managedBookWorkflowSwitchDisabled
            ? '진행 중인 분석을 취소하거나 완료한 뒤 변경할 수 있습니다.'
            : undefined,
          select: selectBookAIWorkflow,
        }}
        controller={{ providerSettings: providerSettingsPanelController }}
      />
    </Suspense>
  );
  const trustedReaderAddonHostContext: TrustedReaderAddonHostContext | undefined =
    selectedNovel && currentChapter
      ? {
          readerInfo: {
            novel: selectedNovel,
            chapter: currentChapter,
            projection: bookWorkspaceProjection,
            annotationCount: bookmarks.length + highlights.length + notes.length,
            syncLabel,
            returnToChapters: bookWorkspace.returnToChapters,
            openSettings: openReaderSettings,
            openSync: () => setSyncPanelOpen(true),
          },
          aiPanel: aiReaderAddonSurface,
        }
      : undefined;

  return (
    <div className="app-shell" style={styleVars}>
      <BookWorkspaceScreens
        controller={bookWorkspace}
        state={bookWorkspaceState}
        projection={bookWorkspaceProjection}
        libraryDrop={{ ...importFeature.libraryDrop, importBusy }}
        bootstrap={{ ...bootstrapState, retry: retryAppBootstrap }}
        sync={{ label: syncLabel, tone: syncTone }}
        annotationTotals={{ bookmarks: bookmarks.length, highlights: highlights.length, notes: notes.length }}
        openSync={() => setSyncPanelOpen(true)}
        openSettings={openReaderSettings}
        openBackup={backupFeature.openPanel}
        openImport={importFeature.open}
        openChapterAppend={importFeature.openChapterAppend}
        openLibraryFolders={libraryFolderFeature.show}
        externalSources={externalSourceFeature}
        openExternalSourceSettings={openExternalSourceSettings}
        addSample={addSample}
        exportSource={exportBookSource}
        reselectSource={reselectBookSource}
        reconstructSource={reconstructBookSource}
        openChapterStructure={chapterStructureFeature.openPanel}
        libraryManagement={libraryManagement}
        bookEnrichment={bookEnrichment}
      />

      {view === 'reader' && selectedNovel && currentChapter && readerScreenModel && (
        <>
          <Suspense fallback={<main className="reader-screen reader-loading" aria-busy="true" />}>
            <ReaderScreen model={readerScreenModel} screenHandle={readerScreenHandle} />
          </Suspense>
          {addonOpen && (
            <ReaderAddonShell
              activeTab={addonTab}
              tabs={readerAddonTabs}
              setActiveTab={setAddonTab}
              close={() => setAddonOpen(false)}
            >
              {activeTrustedReaderAddon && trustedReaderAddonHostContext && (
                <Suspense fallback={null}>{activeTrustedReaderAddon.render(trustedReaderAddonHostContext)}</Suspense>
              )}

              {addonTab === 'outline' && (
                <Suspense fallback={null}>
                  <ReaderOutlinePanel
                    chapters={chapters}
                    filteredChapters={bookWorkspaceProjection.filteredOutlineChapters}
                    currentChapterId={currentChapter.id}
                    readChapter={bookWorkspaceProjection.readChapter}
                    readChapterProgress={bookWorkspaceProjection.readChapterProgress}
                    annotationCounts={chapterAnnotationCounts}
                    query={outlineQuery}
                    setQuery={bookWorkspace.setOutlineQuery}
                    openChapter={bookWorkspace.openChapterFromList}
                  />
                </Suspense>
              )}

              {addonTab === 'tts' && (
                <Suspense fallback={<div className="panel-body" aria-busy="true" />}>
                  <TTSAddonPanel
                    status={ttsStatus}
                    statusTone={ttsStatusTone}
                    selectedVoiceMissing={selectedTTSVoiceMissing}
                    unavailable={ttsUnavailable}
                    hostedPlaybackReady={hostedTTSPlaybackReady}
                    paragraphCount={currentChapter.paragraphCount}
                    bookLanguage={selectedNovel?.language}
                    paragraphIndex={ttsIndex}
                    playing={ttsPlaying}
                    paused={ttsPaused}
                    speed={ttsPlaybackSettings.rate}
                    playbackSettings={ttsPlaybackSettings}
                    bookOverrideEnabled={ttsBookOverrideEnabled}
                    pitchSupported={selectedTTSPitchSupported}
                    resumeLabel={
                      ttsResumeRecord
                        ? `${chapters.find((chapter) => chapter.id === ttsResumeRecord.chapterId)?.title ?? '저장 위치'}에서 이어 듣기`
                        : undefined
                    }
                    selectedSystemVoiceId={settings.ttsVoiceURI}
                    voices={voices}
                    characters={characters}
                    voiceProfiles={voiceProfiles}
                    selectedHostedProvider={selectedHostedTTSProvider}
                    selectedHostedProviderLabel={selectedHostedTTSLabel}
                    selectedHostedVoices={selectedHostedTTSVoices}
                    savedTTSSettings={savedTTSSettings}
                    hostedBusy={hostedTTSBusy}
                    hostedVoicesLoadingProvider={hostedTTSVoicesLoadingProvider}
                    hostedWarmupDisabled={hostedTTSWarmupDisabled}
                    hostedStatus={hostedTTSStatus}
                    hostedJob={hostedTTSJob}
                    offlineDownloadJob={offlineTTSDownloadJob}
                    offlineDownloadError={offlineTTSDownloadError}
                    offlineDownloadPolicy={
                      platformRuntime.kind === 'tauri-mobile' ? offlineTTSRecoveryPolicy : undefined
                    }
                    hostedOfflineCacheStatus={hostedProviderMode ? hostedOfflineCacheStatus : undefined}
                    activePlayback={activeTTSPlayback}
                    providers={ttsSynthesisProviders}
                    providerDraft={ttsSynthesisDraft}
                    providerController={providerSettingsPanelController}
                    voiceProductState={voiceProductController.state}
                    voiceProductBusy={voiceProductController.busy}
                    voiceSampleBusyProfileId={voiceProductController.sampleBusyProfileId}
                    voiceProductSummary={voiceProductController.summary}
                    spokenTextRules={customSpokenTextRules}
                    spokenPreviewRequest={spokenPreviewRequest}
                    voiceCastingSummary={voiceProductController.castingSummary}
                    voicePoolViews={voiceProductController.voicePoolViews}
                    bookCharacterCount={selectedNovel.totalCharacters}
                    refreshStatus={refreshTTSState}
                    jump={jumpTTS}
                    start={startTTS}
                    resume={resumeTTS}
                    pause={pauseTTS}
                    stop={stopTTS}
                    changeSpeed={(value) => changeTTSPlaybackSettings({ rate: value })}
                    changePlaybackSettings={changeTTSPlaybackSettings}
                    setBookOverrideEnabled={setTTSBookOverrideEnabled}
                    resetBookOverride={() => selectedNovel && setTTSBookOverrideEnabled(false)}
                    resumeSavedPlayback={resumeSavedTTS}
                    changeSystemVoice={(value) => updateSettings({ ttsVoiceURI: value })}
                    saveSystemVoice={saveSystemVoiceProfile}
                    saveHostedVoice={saveHostedVoiceProfile}
                    saveHostedVoiceOption={saveHostedVoiceProfileOption}
                    refreshHostedVoices={refreshHostedTTSVoices}
                    warmup={warmupHostedTTSCache}
                    changeOfflineDownloadPolicy={(patch) =>
                      setOfflineTTSRecoveryPolicy((previous) => ({ ...previous, ...patch }))
                    }
                    requestHostedOfflineStorage={requestHostedOfflineStorage}
                    removeStaleHostedOfflineAudio={removeStaleHostedOfflineAudio}
                    generateVoiceDraft={voiceProductController.generateDraft}
                    saveVoicePool={voiceProductController.saveVoicePool}
                    playVoiceSample={playVoiceProfileSample}
                    decideVoice={voiceProductController.decide}
                    savePronunciationRule={voiceProductController.savePronunciationRule}
                    deletePronunciationRule={voiceProductController.deletePronunciationRule}
                    saveSpokenTextSkipRule={saveSpokenTextSkipRule}
                    deleteSpokenTextSkipRule={removeSpokenTextSkipRule}
                    previewSpokenTextRuleImpact={previewSpokenTextRuleImpact}
                    setMinorFallbackEnabled={voiceProductController.setMinorFallbackEnabled}
                    setMajorCharacterLimit={voiceProductController.setMajorCharacterLimit}
                  />
                </Suspense>
              )}

              {addonTab === 'notes' && (
                <Suspense fallback={<div className="panel-body" aria-busy="true" />}>
                  <AnnotationsPanel controller={annotationsController} />
                </Suspense>
              )}

              {addonTab === 'stats' && (
                <Suspense fallback={null}>
                  <BookWorkspaceStatsPanel
                    novel={selectedNovel}
                    projection={bookWorkspaceProjection}
                    sessionSeconds={readerSessionSeconds}
                    progress={readerProgress}
                    personalizationRepository={personalizationRepository}
                  />
                </Suspense>
              )}
            </ReaderAddonShell>
          )}
        </>
      )}

      {view === 'document' && selectedNovel && bookAssetRepository && (
        <Suspense fallback={<main className="fixed-doc-screen" aria-busy="true" />}>
          <FixedDocumentScreen
            novel={selectedNovel}
            chapters={chapters}
            readingPosition={localReadingPosition}
            initialChapterId={bookWorkspaceState.fixedDocumentOpenChapterId}
            repository={readerRepository}
            assets={bookAssetRepository}
            onBack={() => {
              bookWorkspace.setView('library');
              if (externalSourceFeature.localSeriesNovel?.id === selectedNovel.id) {
                void externalSourceFeature.showLocalSeries(selectedNovel);
              }
            }}
            onPageSettled={bookWorkspace.saveFixedDocumentPage}
            onGeneratedCover={(cover) => {
              const applyCover = (current: Novel) =>
                current.id === cover.bookId
                  ? {
                      ...current,
                      coverAssetId: cover.id,
                      coverContentHash: cover.contentHash,
                      coverFit: 'contain' as const,
                      coverPositionX: 50,
                      coverPositionY: 50,
                    }
                  : current;
              setNovels((current) => current.map(applyCover));
              setSelectedNovel((current) => (current ? applyCover(current) : current));
            }}
            onStartListening={startFixedDocumentTTS}
            onPrepareListening={prepareFixedDocumentTTS}
            onCancelListeningPreparation={ttsExecutionController.cancelWarmup}
            listeningPreparationBusy={ttsExecutionController.warmupBusy}
            listeningPosition={ttsPlaying ? ttsListeningPosition : undefined}
            annotationSyncRevision={syncState?.lastSyncedAt}
          />
        </Suspense>
      )}

      {(ttsPlaying || ttsExecutionController.errorMessage) && selectedNovel && currentChapter && (
        <Suspense fallback={null}>
          <TTSCompactBar
            bookTitle={selectedNovel.title}
            chapterTitle={currentChapter.title}
            speakerLabel={activeTTSPlayback?.speakerLabel}
            playing={ttsPlaying}
            paused={ttsPaused}
            busy={hostedTTSBusy}
            rate={ttsPlaybackSettings.rate}
            timerPreset={ttsExecutionController.sleepTimerPreset}
            timerRemainingSeconds={ttsExecutionController.sleepTimerRemainingSeconds}
            status={ttsExecutionController.errorMessage ?? hostedTTSStatus}
            previous={() => void jumpTTS(-1)}
            next={() => void jumpTTS(1)}
            start={() => {
              const anchor = ttsListeningPosition?.anchor;
              return view === 'document' && anchor?.kind === 'fixed_text'
                ? startFixedDocumentTTS(anchor.pageIndex, anchor.blockId, anchor.startOffset)
                : startTTS();
            }}
            pause={pauseTTS}
            resume={resumeTTS}
            stop={stopTTS}
            openSettings={() => {
              if (view === 'reader') {
                setAddonTab('tts');
                setAddonOpen(true);
                return;
              }
              void bookWorkspace
                .openChapter(currentChapter, {
                  novel: selectedNovel,
                  initialMode: 'listen',
                  preserveTTS: true,
                })
                .then(() => {
                  setAddonTab('tts');
                  setAddonOpen(true);
                });
            }}
            setTimer={ttsExecutionController.setSleepTimer}
          />
        </Suspense>
      )}

      {syncPanelOpen && (
        <Suspense
          fallback={
            <div className="settings-layer">
              <button
                className="panel-scrim"
                onClick={() => setSyncPanelOpen(false)}
                aria-label="동기화 패널 배경 닫기"
              />
              <aside className="settings-panel sync-panel" aria-busy="true">
                <header>
                  <h2>동기화</h2>
                  <button className="icon-btn" onClick={() => setSyncPanelOpen(false)} aria-label="동기화 패널 닫기">
                    <X size={18} />
                  </button>
                </header>
                <section>
                  <p className="empty-panel">동기화 상태를 불러오는 중...</p>
                </section>
              </aside>
            </div>
          }
        >
          <SyncPanel
            data={{
              cloudVault,
              mode: readerRuntime.mode,
              apiBaseUrl: readerRuntime.apiBaseUrl,
              syncState,
              syncOutbox,
              syncFlushing,
              syncServiceConnected: Boolean(syncService),
              remoteReadingPosition,
              remoteReadingPositionChapterTitle: remoteReadingPositionChapter?.title,
              serverAttachAvailable: serverAttach.available,
              serverAttachBusy,
              serverAttachProgress,
              serverAttachPercent,
              importBusy,
              selectedNovel,
              syncApiBaseUrlDraft,
              syncConnectionTest,
              apiAuthTokenDraft,
              apiAuthTokenConfigured,
              apiAuthTokenStorage: apiAuthTokenUsesNativeSecureStore() ? 'native_secure_store' : 'browser_storage',
              mergeSelections: syncMergeSelections.selections,
            }}
            actions={{
              close: () => setSyncPanelOpen(false),
              retry: retrySyncNow,
              acceptRemoteState: acceptRemoteSyncState,
              goToRemoteReadingPosition,
              uploadSelectedNovelToServer: serverAttach.upload,
              cancelServerAttach: serverAttach.cancel,
              setSyncApiBaseUrlDraft: (value) => {
                setSyncApiBaseUrlDraft(value);
                setSyncConnectionTest({ status: 'idle' });
              },
              testSyncConnection,
              saveSyncApiBaseUrl,
              setApiAuthTokenDraft,
              saveApiAuthToken,
              discardOutboxItem: discardSyncOutboxItem,
              discardOutboxGroup: discardSyncOutboxGroup,
              setMergeSelection: syncMergeSelections.setSelection,
              clearMergeSelection: syncMergeSelections.clearGroup,
              loadRemoteSnapshot: syncApiClient ? loadSyncRemoteSnapshot : undefined,
              applySelectedLocalFields: applyAiTtsSelectedLocalFields,
              applyRemoteSnapshot: applyAiTtsRemoteSnapshotGroup,
            }}
          />
        </Suspense>
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <ReaderSettingsPanel
            controller={readerSettingsController}
            profile={readingProfile}
            bookOverrideEnabled={readingBookOverrideEnabled}
            contrastWarning={readingProfileContrastWarning(readingProfile)}
            gestureBindings={settings.gestureBindings}
            personalizationRepository={personalizationRepository}
            platformRuntime={platformRuntime}
            providerExecutionRuntime={providerExecutionRuntime}
            selfHostAccount={selfHostAuth?.account}
            logoutSelfHostAccount={selfHostAuth?.logout}
            extensions={extensionSnapshots}
            externalSources={externalSourceFeature}
            webNovelMetadataCollector={webNovelMetadataCollector}
            bookEnrichmentAutomation={bookEnrichmentAutomation}
            libraryCount={novels.length}
            initialTab={settingsInitialTab}
            updateProfile={changeReadingProfile}
            setBookOverrideEnabled={setReadingBookOverrideEnabled}
            resetProfile={() =>
              updateSettings((previous) =>
                selectedNovel && hasBookReadingProfile(previous, selectedNovel.id)
                  ? resetBookReadingProfile(previous, selectedNovel.id)
                  : updateGlobalReadingProfile(previous, DEFAULT_READING_PROFILE),
              )
            }
            updateGestureBindings={(patch) =>
              updateSettings((previous) => ({
                ...previous,
                gestureBindings: { ...previous.gestureBindings, ...patch },
              }))
            }
            setExtensionEnabled={(extensionId, enabled) => {
              if (
                extensionId === MOYA_AI_EXTENSION_ID &&
                !enabled &&
                activeBookAIWorkflow &&
                !isTerminalBookAIWorkflow(activeBookAIWorkflow)
              ) {
                showToast('진행 중인 AI 작업을 취소하거나 완료한 뒤 Moya AI를 꺼 주세요.', 'warning');
                return;
              }
              if (!extensionRuntime.manager.setEnabled(extensionId, enabled)) {
                showToast('익스텐션 상태를 변경하지 못했습니다.', 'warning');
              }
            }}
          />
        </Suspense>
      )}

      {backupFeature.open && (
        <Suspense fallback={null}>
          <BackupPanel controller={backupFeature} />
        </Suspense>
      )}

      {chapterStructureFeature.open && (
        <Suspense fallback={null}>
          <ChapterStructurePanel controller={chapterStructureFeature} />
        </Suspense>
      )}

      <ToastHost
        toasts={toastList}
        readerActive={view === 'reader'}
        addonOpen={view === 'reader' && addonOpen}
        onDismiss={dismissToast}
      />
      <ImportFeatureHost
        controller={importFeature}
        showFloatingTrigger={(view === 'library' && !externalSourceFeature.open) || view === 'chapters'}
      />
      {libraryFolderFeature.open && (
        <Suspense fallback={null}>
          <LibraryFolderPanel controller={libraryFolderFeature} />
        </Suspense>
      )}
    </div>
  );
}
