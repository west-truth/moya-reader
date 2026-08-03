import type { Novel } from '../../domain/types';

export const ID_V2_MIGRATION_GENERATION = 1;

export const ID_V2_MIGRATION_STORES = {
  runs: 'id_migration_runs',
  mappings: 'id_mappings',
  stage: 'id_migration_stage',
  quarantine: 'id_migration_quarantine',
} as const;

export type IdV2MigrationStoreName = (typeof ID_V2_MIGRATION_STORES)[keyof typeof ID_V2_MIGRATION_STORES];

export type IdV2MigrationRunStatus = 'pending' | 'staging' | 'ready' | 'completed' | 'quarantined' | 'rolled_back';

export type IdV2EntityType =
  | 'novel'
  | 'content_revision'
  | 'chapter'
  | 'paragraph'
  | 'page'
  | 'search_row'
  | 'reading_position'
  | 'bookmark'
  | 'highlight'
  | 'note'
  | 'character'
  | 'character_relation'
  | 'segment'
  | 'correction'
  | 'voice_profile'
  | 'sync_event'
  | 'sync_outbox'
  | 'sync_tombstone';

export interface IdV2MigrationRun {
  id: string;
  generation: number;
  oldNovelId: string;
  newNovelId: string;
  sourceFileName: string;
  normalizedTextHash: string;
  identityKey: string;
  status: IdV2MigrationRunStatus;
  sourceFingerprint?: string;
  stagedRecordCount: number;
  backupRecordCount: number;
  mappingCount: number;
  checkpoint: number;
  totalRecords: number;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  rolledBackAt?: string;
  rollbackSafe: boolean;
  errorCode?: string;
}

export interface IdV2MigrationLease {
  id: '__id_v2_migration_lease__';
  status: 'lease';
  owner: string;
  leaseExpiresAt: string;
  updatedAt: string;
}

export type IdV2MigrationRunStoreRecord = IdV2MigrationRun | IdV2MigrationLease;

export interface IdV2MappingRecord {
  id: string;
  runId: string;
  generation: number;
  oldNovelId: string;
  newNovelId: string;
  entityType: IdV2EntityType;
  revisionScope: string;
  oldId: string;
  newId: string;
  sourceFileName?: string;
  normalizedTextHash?: string;
  identityKey?: string;
  createdAt: string;
}

export interface IdV2StageRecord {
  id: string;
  runId: string;
  kind: 'target' | 'rollback';
  storeName: string;
  recordKey: string;
  value: Record<string, unknown>;
  valueHash: string;
}

export interface IdV2QuarantineRecord {
  id: string;
  runId: string;
  oldNovelId: string;
  entityType: IdV2EntityType | 'book';
  entityId?: string;
  code: string;
  message: string;
  createdAt: string;
}

export interface IdV2MigrationProgress {
  runId?: string;
  oldNovelId?: string;
  newNovelId?: string;
  status: 'idle' | 'locked' | 'scanning' | 'cancelled' | 'deferred' | IdV2MigrationRunStatus;
  completedRecords: number;
  totalRecords: number;
  migratedBooks: number;
  quarantinedBooks: number;
}

export interface RunIdV2MigrationOptions {
  signal?: AbortSignal;
  batchSize?: number;
  leaseDurationMs?: number;
  onProgress?: (progress: IdV2MigrationProgress) => void | Promise<void>;
}

export interface IdV2MigrationSummary {
  status: 'idle' | 'locked' | 'completed' | 'cancelled' | 'deferred';
  migratedBooks: number;
  quarantinedBooks: number;
  skippedBooks: number;
}

export interface IdV2SourceRecord {
  storeName: string;
  recordKey: string;
  value: Record<string, unknown>;
}

export interface IdV2BookSource {
  novel: Novel;
  records: IdV2SourceRecord[];
}

export interface IdV2MigrationPlan {
  run: IdV2MigrationRun;
  mappings: IdV2MappingRecord[];
  targets: IdV2StageRecord[];
  backups: IdV2StageRecord[];
}
