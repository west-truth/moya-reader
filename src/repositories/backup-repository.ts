export interface BackupManifestEntry {
  readonly path: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface BackupManifestBook {
  readonly id: string;
  readonly format: string;
  readonly activeContentRevisionId?: string;
  readonly title: string;
}

export interface BackupManifestAssetBlob {
  readonly storageKey: string;
  readonly path: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface BackupManifestV1 {
  readonly format: 'noveldesk-backup';
  readonly version: 1;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly books: BackupManifestBook[];
  readonly entries: BackupManifestEntry[];
  readonly assetBlobs: BackupManifestAssetBlob[];
}

export type BackupConflictResolution = 'skip' | 'replace' | 'copy';

export interface BackupConflict {
  readonly bookId: string;
  readonly title: string;
  readonly existingTitle: string;
}

export interface BackupInspection {
  readonly manifest: BackupManifestV1;
  readonly conflicts: BackupConflict[];
  readonly archiveByteLength: number;
  readonly totalUncompressedBytes: number;
  readonly warnings: string[];
}

export interface BackupRestoreOptions {
  readonly defaultConflictResolution: BackupConflictResolution;
  readonly conflictResolutions?: Readonly<Record<string, BackupConflictResolution>>;
}

export interface BackupRestoreResult {
  readonly restoredBooks: number;
  readonly skippedBooks: number;
  readonly copiedBooks: number;
  readonly restoredEntries: number;
}

export interface BackupRepository {
  exportBackup(): Promise<{ blob: Blob; manifest: BackupManifestV1 }>;
  inspectBackup(archive: Blob): Promise<BackupInspection>;
  restoreBackup(archive: Blob, options: BackupRestoreOptions): Promise<BackupRestoreResult>;
}
