export const BACKUP_RESTORE_RUNS_STORE = 'backup_restore_runs' as const;

export interface BackupRestoreRunRecord {
  id: string;
  status: 'validated' | 'applying' | 'completed' | 'failed';
  manifestVersion: number;
  archiveHash: string;
  archiveByteLength: number;
  summary?: Record<string, number>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export function upgradeBackupStores(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(BACKUP_RESTORE_RUNS_STORE)) return;
  const store = db.createObjectStore(BACKUP_RESTORE_RUNS_STORE, { keyPath: 'id' });
  store.createIndex('status', 'status');
  store.createIndex('updatedAt', 'updatedAt');
}
