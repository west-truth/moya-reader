import type { IdV2MigrationProgress } from './contracts';

const initialProgress: IdV2MigrationProgress = {
  status: 'idle',
  completedRecords: 0,
  totalRecords: 0,
  migratedBooks: 0,
  quarantinedBooks: 0,
};

let currentProgress = initialProgress;
const listeners = new Set<() => void>();

export function publishIdV2MigrationProgress(progress: IdV2MigrationProgress): void {
  currentProgress = { ...progress };
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Observability callbacks must not affect a data migration.
    }
  });
}

export function getIdV2MigrationProgress(): IdV2MigrationProgress {
  return { ...currentProgress };
}

export function subscribeIdV2MigrationProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetIdV2MigrationProgressForTests(): void {
  currentProgress = initialProgress;
  listeners.clear();
}
