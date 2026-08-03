import type pg from 'pg';

export const ID_V2_CONTRACT = 'v2-sha256-128';
export const HASH_V2_CONTRACT = 'v2-sha256-tagged';
export const ID_V2_COMPATIBILITY_RELEASE = 'id-v2-compat-1';

export type MigrationRunStatus =
  'pending' | 'running' | 'deferred' | 'staged' | 'activated' | 'quarantined' | 'failed' | 'rolled_back';

export type BookEntityType =
  | 'book'
  | 'object'
  | 'chapter'
  | 'paragraph'
  | 'page'
  | 'paragraph_search'
  | 'bookmark'
  | 'highlight'
  | 'note'
  | 'character'
  | 'character_alias'
  | 'character_relation'
  | 'analysis_run'
  | 'chapter_context'
  | 'voice_profile'
  | 'labeled_segment'
  | 'user_correction'
  | 'sync_event'
  | 'book_ai_workflow'
  | 'provider_job'
  | 'book_ai_workflow_job'
  | 'workflow_plan_item';

export type GlobalEntityType = 'provider_settings' | 'provider_secret' | 'sync_event';

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface SourceBookObject {
  readonly id: string;
  readonly rawTextHash: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface BookSourceLoader {
  load(object: SourceBookObject): Promise<Buffer>;
}

export interface AnnotationIdentityInput {
  readonly bookId: string;
  readonly chapterId: string;
  readonly paragraphId?: string;
  readonly createdAt: string;
  readonly sourceId: string;
}

export interface CharacterIdentityInput {
  readonly bookId: string;
  readonly canonicalName: string;
  readonly sourceId: string;
}

export interface AnalysisRunIdentityInput {
  readonly bookId: string;
  readonly providerJobId?: string;
  readonly inputHash: string;
  readonly outputHash?: string;
  readonly runType: string;
  readonly sourceId: string;
}

export interface VoiceProfileIdentityInput {
  readonly bookId: string;
  readonly characterId?: string;
  readonly role: string;
  readonly providerId: string;
  readonly providerVoiceId: string;
  readonly sourceId: string;
}

export interface SegmentIdentityInput {
  readonly bookId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly segmentIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly segmentTextHash: string;
  readonly sourceId: string;
}

export interface CorrectionIdentityInput {
  readonly bookId: string;
  readonly chapterId?: string;
  readonly paragraphId?: string;
  readonly segmentId?: string;
  readonly correctionType: string;
  readonly createdAt: string;
  readonly sourceId: string;
}

export interface SyncEventIdentityInput {
  readonly userId: string;
  readonly deviceId?: string;
  readonly type: string;
  readonly bookId?: string;
  readonly entityId?: string;
  readonly createdAt: string;
  readonly payloadHash: string;
  readonly sourceId: string;
}

export interface WorkflowIdentityInput {
  readonly userId: string;
  readonly bookId: string;
  readonly workflowType: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly planHash: string;
  readonly startedAt: string;
  readonly sourceId: string;
}

export interface ProviderJobIdentityInput {
  readonly userId: string;
  readonly bookId: string;
  readonly chapterId?: string;
  readonly jobType: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly inputHash: string;
  readonly sourceId: string;
}

/**
 * Adapter over the shared domain identity factories. The migration service owns
 * no tuple algorithms; it only supplies canonical row fields to this boundary.
 */
export interface IdV2IdentityFactory {
  book(sourceFileName: string, normalizedTextHash: string): string;
  object(rawTextHash: string): string;
  chapter(bookId: string, chapterIndex: number, title: string): string;
  paragraph(bookId: string, chapterId: string, paragraphIndex: number, text: string): string;
  page(bookId: string, chapterId: string, pageIndex: number): string;
  paragraphSearch(bookId: string, chapterId: string, paragraphId: string): string;
  bookmark(input: AnnotationIdentityInput): string;
  highlight(input: AnnotationIdentityInput): string;
  note(input: AnnotationIdentityInput): string;
  character(input: CharacterIdentityInput): string;
  characterAlias(bookId: string, characterId: string, alias: string): string;
  characterRelation(bookId: string, sourceCharacterId: string, targetCharacterId: string, label: string): string;
  analysisRun(input: AnalysisRunIdentityInput): string;
  chapterContext(bookId: string, chapterId: string): string;
  voiceProfile(input: VoiceProfileIdentityInput): string;
  labeledSegment(input: SegmentIdentityInput): string;
  userCorrection(input: CorrectionIdentityInput): string;
  syncEvent(input: SyncEventIdentityInput): string;
  bookAIWorkflow(input: WorkflowIdentityInput): string;
  providerJob(input: ProviderJobIdentityInput): string;
  workflowJob(workflowId: string, stage: string, planItemId: string): string;
  workflowPlanItem(input: {
    readonly bookId: string;
    readonly kind: 'bundle' | 'labeling';
    readonly sequence: number;
    readonly startIndex: number | 'chapter';
    readonly endIndex: number | 'chapter';
    readonly chapterId?: string;
    readonly chapterIds: readonly string[];
    readonly paragraphIds: readonly string[];
    readonly textHashFingerprint: string;
    readonly sourceId: string;
  }): string;
  providerSettings(userId: string, scope: string): string;
  providerSecret(userId: string, scope: string, providerId: string, secretName: string): string;
}

export interface EntityAlias {
  readonly entityType: BookEntityType;
  readonly sourceId: string;
  readonly canonicalId: string;
}

export interface BookMigrationPlan {
  readonly runId: string;
  readonly userId: string;
  readonly sourceBookId: string;
  readonly canonicalBookId: string;
  readonly sourceFileName: string;
  readonly sourceNormalizedTextHash: string;
  readonly canonicalNormalizedTextHash: string;
  readonly sourceObjectId?: string;
  readonly canonicalObjectId?: string;
  readonly sourceFingerprint: Record<string, unknown>;
  readonly aliases: readonly EntityAlias[];
  readonly rows: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly quarantinedTtsRows: readonly Record<string, unknown>[];
  readonly report: Record<string, unknown>;
}

export interface BookMigrationResult {
  readonly runId: string;
  readonly sourceBookId: string;
  readonly canonicalBookId?: string;
  readonly status: MigrationRunStatus;
  readonly report: Record<string, unknown>;
}

export interface MigrateBookOptions {
  readonly userId: string;
  readonly sourceBookId: string;
  readonly stopAfterStage?: 'planned';
}

export interface RollbackBookOptions {
  readonly userId: string;
  readonly sourceBookId: string;
}

export interface IdV2MigrationDependencies {
  readonly pool: pg.Pool;
  readonly identities: IdV2IdentityFactory;
  readonly sourceLoader: BookSourceLoader;
  readonly logger?: MigrationLogger;
}

export interface RollbackProviderOptions {
  readonly userId: string;
}

export class IdV2MigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IdV2MigrationError';
  }
}
