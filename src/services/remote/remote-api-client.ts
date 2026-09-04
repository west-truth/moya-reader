import {
  Bookmark,
  ChapterSplitMode,
  Character,
  DocumentTextBlock,
  DocumentTextRevision,
  EncodingMode,
  LabeledSegment,
  Novel,
  Paragraph,
  ReaderHighlight,
  ReaderNote,
  ReaderSettings,
  UserCorrection,
  VoiceProfile,
} from '../../domain/types';
import type { ResourceMutationOptions } from '../../domain/resource-revisions';
import type {
  ProviderCatalogItem,
  ProviderJob,
  ProviderJobStatus,
  ProviderJobType,
  ProviderSecretStatus,
  TTSCacheItem,
  TTSCacheResolveInput,
  TTSCacheResolveResult,
} from '../../providers/provider-jobs';
import type { CharacterGraph, CharacterRelation } from '../../providers/ai';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';
import type {
  ApplyLabelCorrectionsCommandV2,
  ApplyLabelCorrectionsResultV2,
} from '../../providers/label-mutation-contract';
import type { BookAIWorkflowPlan, BookAIWorkflowPlanOptions } from '../../providers/book-ai-workflow-plan';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  DEFAULT_BOOK_AI_WORKFLOW_VERSION,
} from '../../providers/book-ai-workflow-definition';
import { defaultSettings } from '../../repositories/reader-defaults';
import {
  JsonValue,
  NegotiatedSyncContract,
  PullSyncResult,
  PushSyncResult,
  ReadingPosition,
  RemoteBookSnapshot,
  RemoteBookSnapshotStream,
  ResolvedSyncContract,
  SyncCapabilities,
  SyncEvent,
} from '../../sync/types';
import {
  getRemoteBookSnapshot,
  getRemoteBookSnapshotStream,
  type RemoteBookManifestResponse,
  type RemoteChapterListResponse,
  type RemotePageListResponse,
} from './remote-book-snapshot';
import {
  RemoteApiError,
  RemoteApiRequestTimeoutError,
  type RemoteMutationResult,
  type RemoteUploadStatus,
} from './remote-api-contracts';
import { RemoteBookTransport } from './remote-book-transport';
import { RemoteSearchTransport } from './remote-search-transport';
import { RemoteSyncTransport } from './remote-sync-transport';
import type { ReaderSearchPage, ReaderSearchPageRequest } from '../../repositories/reader-query-contract';
import type { BackupInspection, BackupRestoreOptions, BackupRestoreResult } from '../../repositories/backup-repository';
import type { BookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { SelfHostIntegrationSettingsV1 } from '../../integration-settings/self-host-integration-settings';
import type {
  BatchLibraryCommand,
  BatchLibraryReceipt,
  BatchLibraryTarget,
} from '../../repositories/library-catalog-repository';
import type {
  ChapterStructureCommand,
  ChapterStructureEditorState,
  ChapterStructurePreview,
  ChapterStructureReceipt,
  ChapterStructureReviewItem,
} from '../../repositories/chapter-structure-repository';

export {
  mapServerBook,
  mapServerChapter,
  mapServerParagraphPage,
  mapServerReadingPosition,
  RemoteSnapshotRevisionMismatchError,
} from './remote-book-snapshot';
export { RemoteApiError, RemoteApiRequestTimeoutError, type RemoteUploadStatus } from './remote-api-contracts';
export { mapServerSyncEvent } from './remote-sync-transport';

type JsonRecord = Record<string, unknown>;

function remoteSnapshotNotFound(error: unknown): boolean {
  return error instanceof RemoteApiError && error.status === 404;
}

async function remoteError(response: Response): Promise<RemoteApiError> {
  const raw = await response.text();
  if (!raw) return new RemoteApiError(response.statusText, response.status);
  try {
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      const message =
        (typeof record.error === 'string' && record.error) ||
        (typeof record.message === 'string' && record.message) ||
        response.statusText;
      return new RemoteApiError(message, response.status, payload);
    }
  } catch {
    // Plain-text responses remain valid error messages.
  }
  return new RemoteApiError(raw, response.status);
}

function decodedHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function coverMetadataFromHeaders(bookId: string, headers: Headers): JsonRecord | undefined {
  const id = headers.get('x-asset-id');
  const provenance = headers.get('x-asset-provenance');
  const contentHash = headers.get('x-asset-content-hash') ?? headers.get('etag');
  if (!id || !provenance || !contentHash) return undefined;
  return {
    id,
    book_id: bookId,
    provenance,
    status: headers.get('x-asset-status') ?? 'active',
    file_name: decodedHeader(headers.get('x-asset-file-name')),
    content_type: headers.get('content-type') ?? 'image/jpeg',
    byte_length: Number(headers.get('content-length')) || 0,
    content_hash: contentHash,
    pixel_width: Number(headers.get('x-asset-pixel-width')) || undefined,
    pixel_height: Number(headers.get('x-asset-pixel-height')) || undefined,
    created_at: headers.get('x-asset-created-at') ?? undefined,
    activated_at: headers.get('x-asset-activated-at') ?? undefined,
  };
}

export interface RemoteProviderJob extends ProviderJob {
  readonly stage?: string;
  readonly progress?: JsonValue;
}

export interface RemoteProviderCatalog {
  readonly aiProviders: ProviderCatalogItem[];
  readonly ttsProviders: ProviderCatalogItem[];
}

export interface RemoteProviderSettings {
  readonly scope: 'llm_labeling' | 'tts_synthesis';
  readonly defaultProviderId?: string;
  readonly enabledProviderIds: string[];
  readonly modelByProvider: Record<string, string>;
  readonly providerOptionsByProvider: Record<string, JsonRecord>;
  readonly updatedAt?: string;
}

export interface RemoteProviderSettingsBundle {
  readonly llmLabeling: RemoteProviderSettings;
  readonly ttsSynthesis: RemoteProviderSettings;
}

export interface RemoteProviderSettingsResponse {
  readonly settings: RemoteProviderSettingsBundle;
  readonly catalog: RemoteProviderCatalog;
  readonly secretStatuses: ProviderSecretStatus[];
}

export type RemoteImportJobStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';
export type RemoteImportJobStage =
  'queued' | 'reading' | 'decoding' | 'splitting_chapters' | 'writing' | 'ready' | 'failed' | 'cancelled';

export interface RemoteImportJob {
  id: string;
  upload_id: string;
  status: RemoteImportJobStatus;
  stage?: RemoteImportJobStage;
  bytes_read?: number | string;
  total_bytes?: number | string;
  chapters_detected?: number;
  paragraphs_written?: number;
  message?: string;
  book_id?: string;
  error_message?: string;
  updated_at?: string;
}

export interface RemoteProviderSecretResponse {
  readonly status?: ProviderSecretStatus;
  readonly catalog?: RemoteProviderCatalog;
  readonly secretStatuses?: ProviderSecretStatus[];
}

export interface EnqueueAnalysisJobInput {
  readonly bookId: string;
  readonly chapterId?: string;
  readonly chapterIds?: string[];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly jobType?: ProviderJobType;
  readonly discoveredGraph?: unknown;
  readonly sourceContext?: JsonRecord;
  readonly force?: boolean;
}

export type GetBookAIWorkflowPlanOptions = BookAIWorkflowPlanOptions;

export interface RemoteBookAIWorkflowJob {
  readonly id: string;
  readonly workflowId: string;
  readonly providerJobId: string;
  readonly stage: string;
  readonly planItemId: string;
  readonly sequence: number;
  readonly job?: RemoteProviderJob;
  readonly createdAt: string;
}

export interface RemoteBookAIWorkflow {
  readonly id: string;
  readonly novelId: string;
  readonly workflowType: string;
  readonly workflowDefinitionId: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly planHash: string;
  readonly plan: BookAIWorkflowPlan;
  readonly status: string;
  readonly stage: string;
  readonly progress?: JsonValue;
  readonly jobs: RemoteBookAIWorkflowJob[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface StartBookAIWorkflowInput {
  readonly bookId: string;
  readonly workflowDefinitionId: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly planOptions?: BookAIWorkflowPlanOptions;
  readonly force?: boolean;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizedJobProgressValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) return value.map(sanitizedJobProgressValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'providerOptions')
        .map(([key, item]) => [key, sanitizedJobProgressValue(item)]),
    );
  }
  return null;
}

export function mapServerBookmark(row: JsonRecord): Bookmark {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id),
    chapterId: stringValue(row.chapter_id),
    paragraphId: stringValue(row.paragraph_id) || undefined,
    label: stringValue(row.label),
    progress: numberValue(row.progress),
    scrollTop: numberValue(row.scroll_top),
    createdAt: stringValue(row.created_at, new Date(0).toISOString()),
  };
}

export function mapServerHighlight(row: JsonRecord): ReaderHighlight {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id),
    chapterId: stringValue(row.chapter_id),
    paragraphId: stringValue(row.paragraph_id),
    quote: stringValue(row.quote),
    color: stringValue(row.color, 'yellow') as ReaderHighlight['color'],
    progress: numberValue(row.progress),
    createdAt: stringValue(row.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(row.updated_at, new Date(0).toISOString()),
  };
}

export function mapServerNote(row: JsonRecord): ReaderNote {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id),
    chapterId: stringValue(row.chapter_id),
    paragraphId: stringValue(row.paragraph_id) || undefined,
    quote: stringValue(row.quote) || undefined,
    body: stringValue(row.body),
    progress: numberValue(row.progress),
    createdAt: stringValue(row.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(row.updated_at, new Date(0).toISOString()),
  };
}

export function mapServerCharacter(row: JsonRecord): Character {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id, stringValue(row.novelId)),
    canonicalName: stringValue(row.canonicalName, stringValue(row.canonical_name)),
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter((alias): alias is string => typeof alias === 'string')
      : [],
    color: stringValue(row.color),
    description: stringValue(row.description) || undefined,
    confidence: numberValue(row.confidence),
    isUserConfirmed: booleanValue(row.isUserConfirmed, booleanValue(row.is_user_confirmed)),
  };
}

export function mapServerCharacterRelation(row: JsonRecord): CharacterRelation {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    sourceCharacterId: stringValue(row.sourceCharacterId, stringValue(row.source_character_id)),
    targetCharacterId: stringValue(row.targetCharacterId, stringValue(row.target_character_id)),
    relationLabel: stringValue(row.relationLabel, stringValue(row.relation_label)),
    termsUsedBySource: Array.isArray(row.termsUsedBySource)
      ? row.termsUsedBySource.filter((term): term is string => typeof term === 'string')
      : Array.isArray(row.terms_used_by_source)
        ? row.terms_used_by_source.filter((term): term is string => typeof term === 'string')
        : [],
    termsUsedByTarget: Array.isArray(row.termsUsedByTarget)
      ? row.termsUsedByTarget.filter((term): term is string => typeof term === 'string')
      : Array.isArray(row.terms_used_by_target)
        ? row.terms_used_by_target.filter((term): term is string => typeof term === 'string')
        : [],
    confidence: numberValue(row.confidence),
    evidence: Array.isArray(row.evidence)
      ? row.evidence.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

export function mapServerSegment(row: JsonRecord): LabeledSegment {
  const prosody = row.prosodyIntent ?? row.prosody_intent;
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id, stringValue(row.novelId)),
    chapterId: stringValue(row.chapterId, stringValue(row.chapter_id)),
    paragraphId: stringValue(row.paragraphId, stringValue(row.paragraph_id)),
    segmentIndex: numberValue(row.segmentIndex, numberValue(row.segment_index)),
    startOffset: numberValue(row.startOffset, numberValue(row.start_offset)),
    endOffset: numberValue(row.endOffset, numberValue(row.end_offset)),
    segmentTextHash: stringValue(row.segmentTextHash, stringValue(row.segment_text_hash)),
    type: stringValue(row.type, stringValue(row.segment_type, 'unknown')) as LabeledSegment['type'],
    speakerId: stringValue(row.speakerId, stringValue(row.speaker_id, 'unknown')),
    candidateSpeakers: Array.isArray(row.candidateSpeakers)
      ? row.candidateSpeakers.filter((speaker): speaker is string => typeof speaker === 'string')
      : Array.isArray(row.candidate_speakers)
        ? row.candidate_speakers.filter((speaker): speaker is string => typeof speaker === 'string')
        : [],
    listenerIds: Array.isArray(row.listenerIds)
      ? row.listenerIds.filter((listener): listener is string => typeof listener === 'string')
      : Array.isArray(row.listener_ids)
        ? row.listener_ids.filter((listener): listener is string => typeof listener === 'string')
        : [],
    emotion: stringValue(row.emotion, 'neutral'),
    prosodyIntent:
      prosody && typeof prosody === 'object' && !Array.isArray(prosody)
        ? {
            pace: stringValue((prosody as JsonRecord).pace) || undefined,
            intensity: stringValue((prosody as JsonRecord).intensity) || undefined,
            delivery: stringValue((prosody as JsonRecord).delivery) || undefined,
          }
        : undefined,
    confidence: numberValue(row.confidence),
    evidence: stringValue(row.evidence) || undefined,
    voiceProfileId: stringValue(row.voiceProfileId, stringValue(row.voice_profile_id)) || undefined,
    isUserCorrected: booleanValue(row.isUserCorrected, booleanValue(row.is_user_corrected)),
  };
}

export function mapServerCorrection(row: JsonRecord): UserCorrection {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id, stringValue(row.novelId)),
    chapterId: stringValue(row.chapterId, stringValue(row.chapter_id)),
    paragraphId: stringValue(row.paragraphId, stringValue(row.paragraph_id)) || undefined,
    segmentId: stringValue(row.segmentId, stringValue(row.segment_id)) || undefined,
    correctionType: stringValue(
      row.correctionType,
      stringValue(row.correction_type, 'note'),
    ) as UserCorrection['correctionType'],
    beforeJson:
      row.beforeJson !== undefined
        ? stringValue(row.beforeJson)
        : row.before_json === undefined || row.before_json === null
          ? undefined
          : JSON.stringify(row.before_json),
    afterJson:
      row.afterJson !== undefined ? stringValue(row.afterJson) : (JSON.stringify(row.after_json ?? {}) ?? '{}'),
    applyScope: stringValue(row.applyScope, stringValue(row.apply_scope, 'chapter')) as UserCorrection['applyScope'],
    operationId: stringValue(row.operationId, stringValue(row.operation_id)) || undefined,
    intentKind: (stringValue(row.intentKind, stringValue(row.intent_kind)) ||
      undefined) as UserCorrection['intentKind'],
    intentJson:
      row.intentJson !== undefined
        ? stringValue(row.intentJson)
        : row.intent_json === undefined || row.intent_json === null
          ? undefined
          : JSON.stringify(row.intent_json),
    provenanceKind: (stringValue(row.provenanceKind, stringValue(row.provenance_kind)) ||
      undefined) as UserCorrection['provenanceKind'],
    sourceReviewArtifactId:
      stringValue(row.sourceReviewArtifactId, stringValue(row.source_review_artifact_id)) || undefined,
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
  };
}

export function mapServerVoiceProfile(row: JsonRecord): VoiceProfile {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    characterId: stringValue(row.characterId, stringValue(row.character_id)) || undefined,
    role: stringValue(row.role, 'unknown') as VoiceProfile['role'],
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    providerVoiceId: stringValue(row.providerVoiceId, stringValue(row.provider_voice_id)),
    providerModel: stringValue(row.providerModel, stringValue(row.provider_model)) || undefined,
    label: stringValue(row.label),
    language: stringValue(row.language) || undefined,
    tone: stringValue(row.tone) || undefined,
    speed: numberValue(row.speed, 1),
    pitch: row.pitch === null || row.pitch === undefined ? undefined : numberValue(row.pitch),
    emotionPolicy: stringValue(row.emotionPolicy, stringValue(row.emotion_policy)) || undefined,
    providerOptions:
      row.providerOptions && typeof row.providerOptions === 'object' && !Array.isArray(row.providerOptions)
        ? (row.providerOptions as Record<string, unknown>)
        : row.provider_options && typeof row.provider_options === 'object' && !Array.isArray(row.provider_options)
          ? (row.provider_options as Record<string, unknown>)
          : {},
    isUserSelected: booleanValue(row.isUserSelected, booleanValue(row.is_user_selected)),
    createdAt: stringValue(row.createdAt, stringValue(row.created_at)) || undefined,
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at)) || undefined,
  };
}

export function mapServerProviderJob(row: JsonRecord): RemoteProviderJob {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    chapterId: stringValue(row.chapterId, stringValue(row.chapter_id)) || undefined,
    type: stringValue(row.type, stringValue(row.job_type, 'chapter_segment_labeling')) as ProviderJobType,
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    modelId: stringValue(row.modelId, stringValue(row.model_id)) || undefined,
    inputHash: stringValue(row.inputHash, stringValue(row.input_hash)),
    status: stringValue(row.status, 'queued') as ProviderJobStatus,
    stage: stringValue(row.stage) || undefined,
    progress: row.progress === undefined ? undefined : sanitizedJobProgressValue(row.progress),
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at, new Date(0).toISOString())),
    startedAt: stringValue(row.startedAt, stringValue(row.started_at)) || undefined,
    finishedAt: stringValue(row.finishedAt, stringValue(row.finished_at)) || undefined,
    errorCode: stringValue(row.errorCode, stringValue(row.error_code)) || undefined,
    errorMessage: stringValue(row.errorMessage, stringValue(row.error_message)) || undefined,
  };
}

export function mapServerBookAIWorkflow(row: JsonRecord): RemoteBookAIWorkflow {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    workflowType: stringValue(row.workflowType, stringValue(row.workflow_type, 'book_ai_tts')),
    workflowDefinitionId: stringValue(
      row.workflowDefinitionId,
      stringValue(row.workflow_definition_id, DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID),
    ) as ExtensionContributionId,
    workflowVersion: stringValue(
      row.workflowVersion,
      stringValue(row.workflow_version, DEFAULT_BOOK_AI_WORKFLOW_VERSION),
    ),
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    modelId: stringValue(row.modelId, stringValue(row.model_id)) || undefined,
    planHash: stringValue(row.planHash, stringValue(row.plan_hash)),
    plan: row.plan as BookAIWorkflowPlan,
    status: stringValue(row.status, 'running'),
    stage: stringValue(row.stage, 'building_graph'),
    progress: row.progress === undefined ? undefined : sanitizedJobProgressValue(row.progress),
    jobs: Array.isArray(row.jobs)
      ? row.jobs.map((job): RemoteBookAIWorkflowJob => {
          const body = job && typeof job === 'object' && !Array.isArray(job) ? (job as JsonRecord) : {};
          const providerJob =
            body.job && typeof body.job === 'object' && !Array.isArray(body.job)
              ? mapServerProviderJob(body.job as JsonRecord)
              : undefined;
          return {
            id: stringValue(body.id),
            workflowId: stringValue(body.workflowId, stringValue(body.workflow_id)),
            providerJobId: stringValue(body.providerJobId, stringValue(body.provider_job_id)),
            stage: stringValue(body.stage),
            planItemId: stringValue(body.planItemId, stringValue(body.plan_item_id)),
            sequence: numberValue(body.sequence),
            job: providerJob,
            createdAt: stringValue(body.createdAt, stringValue(body.created_at, new Date(0).toISOString())),
          };
        })
      : [],
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at, new Date(0).toISOString())),
    startedAt: stringValue(row.startedAt, stringValue(row.started_at)) || undefined,
    finishedAt: stringValue(row.finishedAt, stringValue(row.finished_at)) || undefined,
    errorCode: stringValue(row.errorCode, stringValue(row.error_code)) || undefined,
    errorMessage: stringValue(row.errorMessage, stringValue(row.error_message)) || undefined,
  };
}

export function mapServerTTSCacheItem(row: JsonRecord): TTSCacheItem {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    chapterId: stringValue(row.chapterId, stringValue(row.chapter_id)),
    cacheKey: stringValue(row.cacheKey, stringValue(row.cache_key)),
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    providerModel: stringValue(row.providerModel, stringValue(row.provider_model)) || undefined,
    providerVersion: stringValue(row.providerVersion, stringValue(row.provider_version)) || undefined,
    voiceProfileId: stringValue(row.voiceProfileId, stringValue(row.voice_profile_id)),
    speakerId: stringValue(row.speakerId, stringValue(row.speaker_id)) || undefined,
    segmentIds: Array.isArray(row.segmentIds)
      ? row.segmentIds.filter((id): id is string => typeof id === 'string')
      : Array.isArray(row.segment_ids)
        ? row.segment_ids.filter((id): id is string => typeof id === 'string')
        : [],
    inputTextHash: stringValue(row.inputTextHash, stringValue(row.input_text_hash)),
    optionsHash: stringValue(row.optionsHash, stringValue(row.options_hash)),
    audioObjectKey: stringValue(row.audioObjectKey, stringValue(row.audio_object_key)),
    contentType: stringValue(row.contentType, stringValue(row.content_type)) || undefined,
    byteSize: optionalNumberValue(row.byteSize, row.byte_size),
    audioHash: stringValue(row.audioHash, stringValue(row.audio_hash)) || undefined,
    durationMs: optionalNumberValue(row.durationMs, row.duration_ms),
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at, new Date(0).toISOString())),
  };
}

export function mapProviderSettings(row: JsonRecord): RemoteProviderSettings {
  const providerOptions =
    row.providerOptionsByProvider &&
    typeof row.providerOptionsByProvider === 'object' &&
    !Array.isArray(row.providerOptionsByProvider)
      ? (row.providerOptionsByProvider as Record<string, JsonRecord>)
      : {};
  return {
    scope: stringValue(row.scope, 'llm_labeling') as RemoteProviderSettings['scope'],
    defaultProviderId: stringValue(row.defaultProviderId) || undefined,
    enabledProviderIds: Array.isArray(row.enabledProviderIds)
      ? row.enabledProviderIds.filter((providerId): providerId is string => typeof providerId === 'string')
      : [],
    modelByProvider:
      row.modelByProvider && typeof row.modelByProvider === 'object' && !Array.isArray(row.modelByProvider)
        ? Object.fromEntries(
            Object.entries(row.modelByProvider).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {},
    providerOptionsByProvider: providerOptions,
    updatedAt: stringValue(row.updatedAt) || undefined,
  };
}

export function mapProviderSettingsBundle(row: JsonRecord): RemoteProviderSettingsBundle {
  return {
    llmLabeling: mapProviderSettings(
      row.llmLabeling && typeof row.llmLabeling === 'object' ? (row.llmLabeling as JsonRecord) : {},
    ),
    ttsSynthesis: mapProviderSettings(
      row.ttsSynthesis && typeof row.ttsSynthesis === 'object' ? (row.ttsSynthesis as JsonRecord) : {},
    ),
  };
}

export interface RemoteApiClientOptions {
  getAuthToken?: () => string | undefined;
  onUnauthorized?: () => void;
  requestTimeoutMs?: number;
}

export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_LARGE_UPLOAD_TIMEOUT_MS = 15 * 60_000;

export class RemoteApiClient {
  private readonly bookTransport: RemoteBookTransport;
  private readonly searchTransport: RemoteSearchTransport;
  private readonly syncTransport: RemoteSyncTransport;

  constructor(
    private readonly baseUrl: string,
    private readonly options: RemoteApiClientOptions = {},
  ) {
    const request = <T>(path: string, init?: RequestInit) => this.request<T>(path, init);
    this.bookTransport = new RemoteBookTransport(request);
    this.searchTransport = new RemoteSearchTransport(request);
    this.syncTransport = new RemoteSyncTransport({ request });
  }

  private async fetch(path: string, init: RequestInit, requestedTimeoutMs?: number): Promise<Response> {
    const timeoutMs = Math.max(
      1,
      Math.floor(requestedTimeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS),
    );
    const controller = new AbortController();
    const callerSignal = init.signal;
    let timedOut = false;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        credentials: 'same-origin',
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut && !callerSignal?.aborted) throw new RemoteApiRequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const authToken = this.options.getAuthToken?.()?.trim();
    const response = await this.fetch(
      path,
      {
        ...init,
        headers: {
          ...(typeof init.body === 'string' && init.body.length > 0 ? { 'Content-Type': 'application/json' } : {}),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...init.headers,
        },
      },
      timeoutMs,
    );
    if (!response.ok) {
      if (response.status === 401) this.options.onUnauthorized?.();
      throw await remoteError(response);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async requestBlob(path: string, init: RequestInit = {}): Promise<{ blob: Blob; headers: Headers; status: number }> {
    const authToken = this.options.getAuthToken?.()?.trim();
    const response = await this.fetch(path, {
      ...init,
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      if (response.status === 401) this.options.onUnauthorized?.();
      throw await remoteError(response);
    }
    return { blob: await response.blob(), headers: response.headers, status: response.status };
  }

  negotiateSyncContract(): Promise<NegotiatedSyncContract> {
    return this.syncTransport.negotiateSyncContract();
  }

  getSyncCapabilities(): Promise<SyncCapabilities> {
    return this.syncTransport.getSyncCapabilities();
  }

  listBooks(options?: { includeTrash?: boolean }): Promise<{ books: JsonRecord[] }> {
    return this.bookTransport.listBooks(undefined, options);
  }

  listTrashBooks(): Promise<{ books: JsonRecord[] }> {
    return this.request('/trash/books');
  }

  getBookSourceMetadata(bookId: string): Promise<{ source: JsonRecord }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/source/metadata`);
  }

  getBookSource(bookId: string): Promise<{ blob: Blob; headers: Headers; status: number }> {
    return this.requestBlob(`/books/${encodeURIComponent(bookId)}/source`);
  }

  saveDocumentTextPage(
    bookId: string,
    revision: DocumentTextRevision,
    blocks: readonly DocumentTextBlock[],
    signal?: AbortSignal,
  ): Promise<{ revisionId: string; blockCount: number }> {
    return this.request(
      `/books/${encodeURIComponent(bookId)}/document-text/pages/${encodeURIComponent(String(revision.pageIndex))}`,
      {
        method: 'PUT',
        signal,
        body: JSON.stringify({ revision, blocks }),
      },
    );
  }

  getBookSourceRange(
    bookId: string,
    startInclusive: number,
    endExclusive: number,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; headers: Headers; status: number }> {
    return this.requestBlob(`/books/${encodeURIComponent(bookId)}/source`, {
      headers: { Range: `bytes=${startInclusive}-${Math.max(startInclusive, endExclusive - 1)}` },
      signal,
    });
  }

  reselectBookSource(
    bookId: string,
    source: Blob,
    metadata: { fileName: string; contentType: string },
  ): Promise<{ source: JsonRecord }> {
    return this.request(
      `/books/${encodeURIComponent(bookId)}/source`,
      {
        method: 'PUT',
        body: source,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Source-File-Name': encodeURIComponent(metadata.fileName),
          'X-Source-Content-Type': metadata.contentType || 'text/plain',
        },
      },
      DEFAULT_REMOTE_LARGE_UPLOAD_TIMEOUT_MS,
    );
  }

  getBookCoverMetadata(bookId: string): Promise<{ cover: JsonRecord }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/cover/metadata`);
  }

  async getBookCover(bookId: string): Promise<{ blob: Blob; headers: Headers; status: number; metadata?: JsonRecord }> {
    const response = await this.requestBlob(`/books/${encodeURIComponent(bookId)}/cover`);
    return { ...response, metadata: coverMetadataFromHeaders(bookId, response.headers) };
  }

  getBookResource(bookId: string, assetId: string): Promise<{ blob: Blob; headers: Headers; status: number }> {
    return this.requestBlob(`/books/${encodeURIComponent(bookId)}/resources/${encodeURIComponent(assetId)}`);
  }

  saveBookCover(
    bookId: string,
    cover: Blob,
    metadata: {
      fileName: string;
      contentType: string;
      contentHash: string;
      pixelWidth: number;
      pixelHeight: number;
      fit: 'crop' | 'contain';
      positionX: number;
      positionY: number;
      expectedMetadataRevision?: number;
      provenance?: 'user_supplied' | 'approved_enrichment' | 'generated_preview';
    },
  ): Promise<{ cover: JsonRecord; previousCover?: JsonRecord; metadataRevision?: number }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/cover`, {
      method: 'PUT',
      body: cover,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Cover-File-Name': encodeURIComponent(metadata.fileName),
        'X-Cover-Content-Type': metadata.contentType,
        'X-Cover-Content-Hash': metadata.contentHash,
        'X-Cover-Width': String(metadata.pixelWidth),
        'X-Cover-Height': String(metadata.pixelHeight),
        'X-Cover-Fit': metadata.fit,
        'X-Cover-Position-X': String(metadata.positionX),
        'X-Cover-Position-Y': String(metadata.positionY),
        'X-Cover-Provenance': metadata.provenance ?? 'user_supplied',
        ...(metadata.expectedMetadataRevision === undefined
          ? {}
          : { 'X-Expected-Metadata-Revision': String(metadata.expectedMetadataRevision) }),
      },
    });
  }

  saveApprovedEnrichmentBookCover(
    bookId: string,
    cover: Blob,
    metadata: {
      fileName: string;
      contentType: string;
      contentHash: string;
      pixelWidth: number;
      pixelHeight: number;
      fit: 'crop' | 'contain';
      positionX: number;
      positionY: number;
      expectedMetadataRevision: number;
    },
  ): Promise<{ cover: JsonRecord; previousCover: JsonRecord | null; metadataRevision: number }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/cover/approved-enrichment`, {
      method: 'PUT',
      body: cover,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Cover-File-Name': encodeURIComponent(metadata.fileName),
        'X-Cover-Content-Type': metadata.contentType,
        'X-Cover-Content-Hash': metadata.contentHash,
        'X-Cover-Width': String(metadata.pixelWidth),
        'X-Cover-Height': String(metadata.pixelHeight),
        'X-Cover-Fit': metadata.fit,
        'X-Cover-Position-X': String(metadata.positionX),
        'X-Cover-Position-Y': String(metadata.positionY),
        'X-Expected-Metadata-Revision': String(metadata.expectedMetadataRevision),
      },
    });
  }

  restoreApprovedEnrichmentBookCover(
    bookId: string,
    input: {
      expectedMetadataRevision: number;
      expectedActiveAssetId: string;
      expectedActiveContentHash: string;
      previousAssetId?: string;
      previousContentHash?: string;
      previousFit: 'crop' | 'contain';
      previousPositionX: number;
      previousPositionY: number;
    },
  ): Promise<{ cover: JsonRecord | null; metadataRevision: number }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/cover/approved-enrichment/restore`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  removeBookCover(bookId: string, expectedMetadataRevision?: number): Promise<{ ok: true }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/cover`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: expectedMetadataRevision }),
    });
  }

  exportBackup(): Promise<{ blob: Blob; headers: Headers; status: number }> {
    return this.requestBlob('/backups/export');
  }

  inspectBackup(archive: Blob): Promise<BackupInspection> {
    return this.request(
      '/backups/inspect',
      {
        method: 'POST',
        body: archive,
        headers: { 'Content-Type': 'application/zip' },
      },
      DEFAULT_REMOTE_LARGE_UPLOAD_TIMEOUT_MS,
    );
  }

  restoreBackup(archive: Blob, options: BackupRestoreOptions): Promise<BackupRestoreResult> {
    return this.request(
      '/backups/restore',
      {
        method: 'POST',
        body: archive,
        headers: {
          'Content-Type': 'application/zip',
          'X-Backup-Default-Resolution': options.defaultConflictResolution,
          ...(options.conflictResolutions
            ? { 'X-Backup-Conflict-Resolutions': JSON.stringify(options.conflictResolutions) }
            : {}),
        },
      },
      DEFAULT_REMOTE_LARGE_UPLOAD_TIMEOUT_MS,
    );
  }

  getChapterStructureEditor(bookId: string): Promise<{ editor: ChapterStructureEditorState }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/chapter-structure`);
  }

  previewChapterStructure(
    bookId: string,
    commands: readonly ChapterStructureCommand[],
  ): Promise<{ preview: ChapterStructurePreview }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/chapter-structure/preview`, {
      method: 'POST',
      body: JSON.stringify({ commands }),
    });
  }

  applyChapterStructure(draftId: string): Promise<{ receipt: ChapterStructureReceipt }> {
    return this.request(`/chapter-structure/drafts/${encodeURIComponent(draftId)}/apply`, { method: 'POST' });
  }

  rollbackChapterStructure(receiptId: string): Promise<{ receipt: ChapterStructureReceipt }> {
    return this.request(`/chapter-structure/receipts/${encodeURIComponent(receiptId)}/rollback`, { method: 'POST' });
  }

  listChapterStructureReview(bookId: string): Promise<{ items: ChapterStructureReviewItem[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/chapter-structure/review`);
  }

  getBookManifest(bookId: string, sourceRevision?: string): Promise<RemoteBookManifestResponse> {
    return this.bookTransport.getBookManifest(bookId, sourceRevision);
  }

  listChapters(bookId: string, sourceRevision?: string): Promise<RemoteChapterListResponse> {
    return this.bookTransport.listChapters(bookId, sourceRevision);
  }

  getChapter(chapterId: string, signal?: AbortSignal): Promise<{ chapter: JsonRecord }> {
    return this.bookTransport.getChapter(chapterId, signal);
  }

  listPages(
    chapterId: string,
    from = 0,
    count = 5,
    sourceRevision?: string,
    signal?: AbortSignal,
  ): Promise<RemotePageListResponse> {
    return this.bookTransport.listPages(chapterId, from, count, sourceRevision, signal);
  }

  getParagraph(paragraphId: string, signal?: AbortSignal): Promise<{ paragraph: Paragraph }> {
    return this.bookTransport.getParagraph(paragraphId, signal);
  }

  searchParagraphPage(input: ReaderSearchPageRequest): Promise<ReaderSearchPage> {
    return this.searchTransport.searchParagraphPage(input);
  }

  getSettings(): Promise<{ settings: ReaderSettings }> {
    return this.request('/settings');
  }

  saveSettings(settings: ReaderSettings): Promise<{ ok: true }> {
    return this.request('/settings', { method: 'PUT', body: JSON.stringify({ ...defaultSettings, ...settings }) });
  }

  getIntegrationSettings(since?: string): Promise<{ settings?: SelfHostIntegrationSettingsV1 }> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    return this.request(`/integration-settings${query}`);
  }

  saveIntegrationSettings(
    settings: SelfHostIntegrationSettingsV1,
  ): Promise<{ ok: true; settings: SelfHostIntegrationSettingsV1 }> {
    return this.request('/integration-settings', { method: 'PUT', body: JSON.stringify(settings) });
  }

  patchBook(
    bookId: string,
    body: BookMetadataPatch & Pick<Partial<Novel>, 'analysisStatus'> & { expectedRevision?: number },
  ): Promise<{ ok: true; metadataRevision: number }> {
    return this.request(`/books/${encodeURIComponent(bookId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  listShelves(): Promise<{ shelves: JsonRecord[]; memberships: JsonRecord[] }> {
    return this.request('/shelves');
  }

  createShelf(input: { name: string; color?: string }): Promise<{ shelf: JsonRecord }> {
    return this.request('/shelves', { method: 'POST', body: JSON.stringify(input) });
  }

  updateShelf(
    shelfId: string,
    patch: { name?: string; color?: string | null; sortOrder?: number; expectedRevision?: number },
  ): Promise<{ shelf: JsonRecord }> {
    return this.request(`/shelves/${encodeURIComponent(shelfId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  deleteShelf(shelfId: string, expectedRevision?: number): Promise<{ shelf: JsonRecord }> {
    return this.request(`/shelves/${encodeURIComponent(shelfId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision }),
    });
  }

  setShelfMembership(shelfId: string, bookId: string, included: boolean): Promise<{ ok: true }> {
    return this.request(`/shelves/${encodeURIComponent(shelfId)}/books/${encodeURIComponent(bookId)}`, {
      method: included ? 'PUT' : 'DELETE',
    });
  }

  applyLibraryBatch(
    command: BatchLibraryCommand,
    targets: readonly BatchLibraryTarget[],
    idempotencyKey: string,
  ): Promise<{ receipt: BatchLibraryReceipt }> {
    return this.request('/library/batch', {
      method: 'POST',
      body: JSON.stringify({ command, targets, idempotencyKey }),
    });
  }

  deleteBook(
    bookId: string,
    deviceId?: string,
    expectedRevision?: number,
  ): Promise<{ ok: true; metadataRevision: number }> {
    return this.request(`/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ deviceId, expectedRevision }),
    });
  }

  restoreBook(bookId: string, expectedRevision?: number): Promise<{ ok: true; metadataRevision: number }> {
    return this.request(`/trash/books/${encodeURIComponent(bookId)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision }),
    });
  }

  purgeBook(bookId: string, expectedRevision?: number): Promise<{ ok: true }> {
    return this.request(`/trash/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision }),
    });
  }

  emptyTrash(): Promise<{ ok: true; purged: number }> {
    return this.request('/trash/books', { method: 'DELETE' });
  }

  saveReadingPosition(
    bookId: string,
    position: Omit<ReadingPosition, 'id' | 'novelId'> & { readonly documentSectionId?: string },
  ): Promise<RemoteMutationResult> {
    return this.request(`/books/${encodeURIComponent(bookId)}/reading-position`, {
      method: 'PATCH',
      body: JSON.stringify({
        chapterId: position.chapterId,
        documentSectionId: position.documentSectionId,
        paragraphId: position.paragraphId,
        paragraphIndex: position.paragraphIndex,
        offsetInParagraph: position.offsetInParagraph,
        chapterProgress: position.chapterProgress,
        scrollTop: position.scrollTop,
        deviceId: position.deviceId,
        updatedAt: position.updatedAt,
      }),
    });
  }

  deleteReadingPosition(bookId: string, body: { deviceId?: string; updatedAt: string }): Promise<RemoteMutationResult> {
    return this.request(`/books/${encodeURIComponent(bookId)}/reading-position`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  }

  listBookmarks(bookId: string): Promise<{ bookmarks: JsonRecord[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/bookmarks`);
  }

  saveBookmark(bookmark: Bookmark, options?: ResourceMutationOptions): Promise<RemoteMutationResult> {
    return this.request(`/books/${encodeURIComponent(bookmark.novelId)}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify({ ...bookmark, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  deleteBookmark(id: string, options?: ResourceMutationOptions): Promise<{ ok: true }> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(options ?? {}),
    });
  }

  listHighlights(bookId: string): Promise<{ highlights: JsonRecord[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/highlights`);
  }

  saveHighlight(highlight: ReaderHighlight, options?: ResourceMutationOptions): Promise<RemoteMutationResult> {
    return this.request(`/books/${encodeURIComponent(highlight.novelId)}/highlights`, {
      method: 'POST',
      body: JSON.stringify({ ...highlight, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  deleteHighlight(id: string, options?: ResourceMutationOptions): Promise<{ ok: true }> {
    return this.request(`/highlights/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(options ?? {}),
    });
  }

  listNotes(bookId: string): Promise<{ notes: JsonRecord[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/notes`);
  }

  saveNote(note: ReaderNote, options?: ResourceMutationOptions): Promise<RemoteMutationResult> {
    return this.request(`/books/${encodeURIComponent(note.novelId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ ...note, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  deleteNote(id: string, options?: ResourceMutationOptions): Promise<{ ok: true }> {
    return this.request(`/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(options ?? {}),
    });
  }

  listProviders(): Promise<RemoteProviderCatalog> {
    return this.request('/providers');
  }

  async getProviderSettings(): Promise<RemoteProviderSettingsResponse> {
    const response = await this.request<{
      settings: JsonRecord;
      catalog: RemoteProviderCatalog;
      secretStatuses?: ProviderSecretStatus[];
    }>('/provider-settings');
    return {
      settings: mapProviderSettingsBundle(response.settings),
      catalog: response.catalog,
      secretStatuses: response.secretStatuses ?? [],
    };
  }

  async saveProviderSettings(
    scope: RemoteProviderSettings['scope'],
    input: Partial<Omit<RemoteProviderSettings, 'scope' | 'updatedAt'>>,
  ): Promise<{
    settings: RemoteProviderSettings;
    catalog: RemoteProviderCatalog;
    secretStatuses: ProviderSecretStatus[];
  }> {
    const response = await this.request<{
      settings: JsonRecord;
      catalog: RemoteProviderCatalog;
      secretStatuses?: ProviderSecretStatus[];
    }>(`/provider-settings/${encodeURIComponent(scope)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    return {
      settings: mapProviderSettings(response.settings),
      catalog: response.catalog,
      secretStatuses: response.secretStatuses ?? [],
    };
  }

  async saveProviderSecret(
    scope: RemoteProviderSettings['scope'],
    providerId: string,
    secretName: string,
    secretValue: string,
  ): Promise<RemoteProviderSecretResponse> {
    return this.request(
      `/provider-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(providerId)}/${encodeURIComponent(secretName)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ secretValue }),
      },
    );
  }

  async deleteProviderSecret(
    scope: RemoteProviderSettings['scope'],
    providerId: string,
    secretName: string,
  ): Promise<RemoteProviderSecretResponse> {
    return this.request(
      `/provider-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(providerId)}/${encodeURIComponent(secretName)}`,
      {
        method: 'DELETE',
      },
    );
  }

  async testProviderSecret(
    scope: RemoteProviderSettings['scope'],
    providerId: string,
    secretName: string,
  ): Promise<RemoteProviderSecretResponse & { ok?: true; message?: string }> {
    return this.request(
      `/provider-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(providerId)}/${encodeURIComponent(secretName)}/test`,
      {
        method: 'POST',
      },
    );
  }

  async listTTSProviderVoices(
    providerId: string,
  ): Promise<{ voices: Array<{ id: string; label: string; lang: string }> }> {
    return this.request(`/tts-providers/${encodeURIComponent(providerId)}/voices`);
  }

  async listCharacters(bookId: string): Promise<{ characters: Character[] }> {
    const response = await this.request<{ characters: JsonRecord[] }>(
      `/books/${encodeURIComponent(bookId)}/characters`,
    );
    return { characters: response.characters.map(mapServerCharacter) };
  }

  async listCharacterGraph(bookId: string): Promise<{ graph: CharacterGraph }> {
    const response = await this.request<{
      graph: JsonRecord & { characters?: JsonRecord[]; relations?: JsonRecord[] };
    }>(`/books/${encodeURIComponent(bookId)}/character-graph`);
    return {
      graph: {
        novelId: stringValue(response.graph.novelId, stringValue(response.graph.book_id, bookId)),
        characters: Array.isArray(response.graph.characters) ? response.graph.characters.map(mapServerCharacter) : [],
        relations: Array.isArray(response.graph.relations)
          ? response.graph.relations.map(mapServerCharacterRelation)
          : [],
      },
    };
  }

  async getCharacterGraphKnowledgeV2(
    bookId: string,
  ): Promise<{ knowledge: import('../../providers/character-graph-v2').CharacterGraphKnowledgeV2 }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/character-graph-v2`);
  }

  async saveCharacterGraphObservationsV2(
    bookId: string,
    knowledge: import('../../providers/character-graph-v2').CharacterGraphKnowledgeV2,
  ): Promise<{ ok: true }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/character-graph-v2/observations`, {
      method: 'POST',
      body: JSON.stringify({ knowledge }),
    });
  }

  async applyCharacterIdentityCommandV2(
    bookId: string,
    command: import('../../providers/character-graph-v2').CharacterIdentityCommandV2,
  ): Promise<{ result: import('../../providers/character-graph-v2').CharacterIdentityOperationResultV2 }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/character-identity-operations`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  }

  saveCharacters(
    bookId: string,
    characters: Character[],
    options?: ResourceMutationOptions,
  ): Promise<{ ok: true; characters: Character[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/characters`, {
      method: 'PUT',
      body: JSON.stringify({ characters, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  async saveCharacterGraph(
    bookId: string,
    graph: CharacterGraph,
    options?: ResourceMutationOptions,
  ): Promise<{ ok: true; graph: CharacterGraph }> {
    const response = await this.request<{
      ok: true;
      graph: JsonRecord & { characters?: JsonRecord[]; relations?: JsonRecord[] };
    }>(`/books/${encodeURIComponent(bookId)}/character-graph`, {
      method: 'PUT',
      body: JSON.stringify({ graph, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
    return {
      ok: true,
      graph: {
        novelId: stringValue(response.graph.novelId, stringValue(response.graph.book_id, bookId)),
        characters: Array.isArray(response.graph.characters) ? response.graph.characters.map(mapServerCharacter) : [],
        relations: Array.isArray(response.graph.relations)
          ? response.graph.relations.map(mapServerCharacterRelation)
          : [],
      },
    };
  }

  async listVoiceProfiles(bookId: string): Promise<{ voiceProfiles: VoiceProfile[] }> {
    const response = await this.request<{ voiceProfiles: JsonRecord[] }>(
      `/books/${encodeURIComponent(bookId)}/voice-profiles`,
    );
    return { voiceProfiles: response.voiceProfiles.map(mapServerVoiceProfile) };
  }

  saveVoiceProfiles(
    bookId: string,
    voiceProfiles: VoiceProfile[],
    options?: ResourceMutationOptions,
  ): Promise<{ ok: true; voiceProfiles: VoiceProfile[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/voice-profiles`, {
      method: 'PUT',
      body: JSON.stringify({ voiceProfiles, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  getVoiceProductState(
    bookId: string,
  ): Promise<{ state: import('../../providers/voice-product').VoiceProductStateV1 }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/voice-product`);
  }

  saveVoiceProductState(
    bookId: string,
    state: import('../../providers/voice-product').VoiceProductStateV1,
  ): Promise<{ ok: true; state: import('../../providers/voice-product').VoiceProductStateV1 }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/voice-product`, {
      method: 'PUT',
      body: JSON.stringify({ state }),
    });
  }

  getVoiceCastingState(bookId: string): Promise<{
    revision: number;
    state: import('../../providers/voice-casting').VoiceCastingStateV1 | null;
    userArtifacts: import('../../providers/voice-casting').VoiceCastingWorkspaceUserArtifactsV1 | null;
    derivedArtifacts: Omit<
      import('../../providers/voice-casting').VoiceCastingWorkspaceDerivedArtifactsV1,
      'utterances' | 'state'
    > | null;
  }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/voice-casting`);
  }

  saveVoiceCastingState(input: {
    readonly bookId: string;
    readonly expectedRevision: number;
    readonly state: import('../../providers/voice-casting').VoiceCastingStateV1;
    readonly userArtifacts: import('../../providers/voice-casting').VoiceCastingWorkspaceUserArtifactsV1;
    readonly derivedArtifacts: Omit<
      import('../../providers/voice-casting').VoiceCastingWorkspaceDerivedArtifactsV1,
      'utterances' | 'state'
    >;
  }): Promise<{
    revision: number;
    state: import('../../providers/voice-casting').VoiceCastingStateV1;
  }> {
    return this.request(`/books/${encodeURIComponent(input.bookId)}/voice-casting`, {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: input.expectedRevision,
        state: input.state,
        userArtifacts: input.userArtifacts,
        derivedArtifacts: input.derivedArtifacts,
      }),
    });
  }

  listVoiceCastingSource(
    bookId: string,
  ): Promise<{ utterances: import('../../providers/voice-casting').AcceptedSpeakerUtteranceV1[] }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/voice-casting/source`);
  }

  async listSegments(chapterId: string): Promise<{ segments: LabeledSegment[] }> {
    const response = await this.request<{ segments: JsonRecord[] }>(
      `/chapters/${encodeURIComponent(chapterId)}/segments`,
    );
    return { segments: response.segments.map(mapServerSegment) };
  }

  saveSegments(
    chapterId: string,
    segments: LabeledSegment[],
    options?: ResourceMutationOptions,
  ): Promise<{ ok: true; segments: LabeledSegment[] }> {
    return this.request(`/chapters/${encodeURIComponent(chapterId)}/segments`, {
      method: 'PUT',
      body: JSON.stringify({ segments, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  async listCorrections(
    bookId: string,
    input: { chapterId?: string } = {},
  ): Promise<{ corrections: UserCorrection[] }> {
    const search = input.chapterId ? `?chapterId=${encodeURIComponent(input.chapterId)}` : '';
    const response = await this.request<{ corrections: JsonRecord[] }>(
      `/books/${encodeURIComponent(bookId)}/corrections${search}`,
    );
    return { corrections: response.corrections.map(mapServerCorrection) };
  }

  saveCorrection(
    correction: UserCorrection,
    options?: ResourceMutationOptions,
  ): Promise<{ ok: true; correction: UserCorrection }> {
    return this.request(`/books/${encodeURIComponent(correction.novelId)}/corrections`, {
      method: 'POST',
      body: JSON.stringify({ ...correction, ...(options ? { expectedRevision: options.expectedRevision } : {}) }),
    });
  }

  deleteCorrection(
    bookId: string,
    correctionId: string,
    options?: ResourceMutationOptions,
  ): Promise<{ ok: true; id: string; deletedAt: string }> {
    return this.request(`/books/${encodeURIComponent(bookId)}/corrections/${encodeURIComponent(correctionId)}`, {
      method: 'DELETE',
      body: JSON.stringify(options ?? {}),
    });
  }

  applyLabelCorrections(command: ApplyLabelCorrectionsCommandV2): Promise<ApplyLabelCorrectionsResultV2> {
    return this.request(`/books/${encodeURIComponent(command.bookId)}/label-mutations`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
  }

  getBookAIWorkflowPlan(
    bookId: string,
    options: GetBookAIWorkflowPlanOptions = {},
  ): Promise<{ plan: BookAIWorkflowPlan }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        params.set(key, String(Math.floor(value)));
      }
    }
    const search = params.toString();
    return this.request(`/books/${encodeURIComponent(bookId)}/analysis-workflow-plan${search ? `?${search}` : ''}`);
  }

  async startBookAIWorkflow(input: StartBookAIWorkflowInput): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/books/${encodeURIComponent(input.bookId)}/analysis-workflows`,
      {
        method: 'POST',
        body: JSON.stringify({
          providerId: input.providerId,
          modelId: input.modelId,
          workflowDefinitionId: input.workflowDefinitionId,
          workflowVersion: input.workflowVersion,
          planOptions: input.planOptions,
          force: input.force,
        }),
      },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async getBookAIWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}`,
      { signal },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  listBookAIWorkflowReviews(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<{ reviews: ChapterLabelAnalysisReviewArtifact[] }> {
    return this.request(`/analysis-workflows/${encodeURIComponent(workflowId)}/reviews`, { signal });
  }

  getAnalysisReviewArtifact(
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}`, { signal });
  }

  saveAnalysisReviewDraft(
    reviewId: string,
    input: {
      expectedReviewRevision: number;
      candidate: ChapterLabelAnalysisReviewArtifact['candidate'];
      editIntents?: AnalysisReviewEditIntentMap;
    },
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'save_draft', ...input }),
      signal,
    });
  }

  rejectAnalysisReviewArtifact(
    reviewId: string,
    input: { expectedReviewRevision: number; reason?: string },
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reject', ...input }),
      signal,
    });
  }

  approveAnalysisReviewArtifact(
    reviewId: string,
    expectedReviewRevision: number,
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', expectedReviewRevision }),
      signal,
    });
  }

  async retryBookAIWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}/retry`,
      {
        method: 'POST',
        body: JSON.stringify({ action: 'retry_same_request' }),
        signal,
      },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async cancelBookAIWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}/cancel`,
      {
        method: 'POST',
        signal,
      },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async refreshBookAIWorkflowTTSCacheReadiness(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}/tts-cache-readiness`,
      { method: 'POST', signal },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async enqueueAnalysisJob(input: EnqueueAnalysisJobInput): Promise<{ job: RemoteProviderJob }> {
    const response = await this.request<{ job: JsonRecord }>(
      `/books/${encodeURIComponent(input.bookId)}/analysis-jobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          chapterId: input.chapterId,
          chapterIds: input.chapterIds,
          providerId: input.providerId,
          modelId: input.modelId,
          jobType: input.jobType,
          discoveredGraph: input.discoveredGraph,
          sourceContext: input.sourceContext,
          force: input.force,
        }),
      },
    );
    return { job: mapServerProviderJob(response.job) };
  }

  async getProviderJob(jobId: string, signal?: AbortSignal): Promise<{ job: RemoteProviderJob }> {
    const response = await this.request<{ job: JsonRecord }>(`/provider-jobs/${encodeURIComponent(jobId)}`, { signal });
    return { job: mapServerProviderJob(response.job) };
  }

  async cancelProviderJob(jobId: string, signal?: AbortSignal): Promise<{ job: RemoteProviderJob }> {
    const response = await this.request<{ job: JsonRecord }>(`/provider-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      signal,
    });
    return { job: mapServerProviderJob(response.job) };
  }

  async resolveTTSCache(
    chapterId: string,
    input: TTSCacheResolveInput,
    signal?: AbortSignal,
  ): Promise<TTSCacheResolveResult> {
    const response = await this.request<{
      cacheHit: boolean;
      cacheKey: string;
      optionsHash: string;
      cacheItem?: JsonRecord;
      job?: JsonRecord;
    }>(`/chapters/${encodeURIComponent(chapterId)}/tts-cache/resolve`, {
      method: 'POST',
      signal,
      body: JSON.stringify(input),
    });
    return {
      cacheHit: response.cacheHit,
      cacheKey: response.cacheKey,
      optionsHash: response.optionsHash,
      cacheItem: response.cacheItem ? mapServerTTSCacheItem(response.cacheItem) : undefined,
      job: response.job ? mapServerProviderJob(response.job) : undefined,
    };
  }

  ttsCacheAudioUrl(chapterId: string, cacheKey: string): string {
    return `${this.baseUrl}/chapters/${encodeURIComponent(chapterId)}/tts-cache/${encodeURIComponent(cacheKey)}/audio`;
  }

  async fetchTTSCacheAudio(chapterId: string, cacheKey: string, signal?: AbortSignal): Promise<Blob> {
    const authToken = this.options.getAuthToken?.()?.trim();
    const path = `/chapters/${encodeURIComponent(chapterId)}/tts-cache/${encodeURIComponent(cacheKey)}/audio`;
    const response = await this.fetch(path, {
      signal,
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    });
    if (!response.ok) {
      if (response.status === 401) this.options.onUnauthorized?.();
      throw await remoteError(response);
    }
    return response.blob();
  }

  async pullSync(since = 0, requestedContract?: ResolvedSyncContract): Promise<PullSyncResult> {
    return this.syncTransport.pullSync(since, requestedContract);
  }

  async pushSync(events: SyncEvent[], requestedContract?: ResolvedSyncContract): Promise<PushSyncResult> {
    return this.syncTransport.pushSync(events, requestedContract);
  }

  async getBookSnapshotStream(bookId: string): Promise<RemoteBookSnapshotStream | undefined> {
    return getRemoteBookSnapshotStream(this, bookId, remoteSnapshotNotFound);
  }

  async getBookSnapshot(bookId: string): Promise<RemoteBookSnapshot | undefined> {
    return getRemoteBookSnapshot(this, bookId, remoteSnapshotNotFound);
  }

  initUpload(
    input: {
      fileName: string;
      sizeBytes: number;
      contentType: string;
      encoding: EncodingMode;
      chapterSplitMode?: ChapterSplitMode;
      importMode?: 'replace_book' | 'append_image_series';
      baseActiveContentRevisionId?: string;
      totalChunks: number;
      clientBookId?: string;
      sourceContentHash?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ uploadId: string; chunkUrlTemplate: string }> {
    return this.request('/uploads/init', { method: 'POST', body: JSON.stringify(input), signal });
  }

  getUpload(uploadId: string, signal?: AbortSignal): Promise<RemoteUploadStatus> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}`, { signal });
  }

  putUploadChunk(
    uploadId: string,
    chunkIndex: number,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<{ ok: true; upload?: RemoteUploadStatus }> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`, {
      method: 'PUT',
      body: chunk,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    });
  }

  completeUpload(uploadId: string, signal?: AbortSignal): Promise<{ jobId: string; statusUrl: string }> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', signal });
  }

  cancelUpload(
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; cancellationState?: 'requested' | 'cancelled'; upload?: RemoteUploadStatus }> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', signal });
  }

  getImportJob(jobId: string, signal?: AbortSignal): Promise<RemoteImportJob> {
    return this.request(`/import-jobs/${encodeURIComponent(jobId)}`, { signal });
  }
}
