import type {
  BackupInspection,
  BackupManifestV1,
  BackupRepository,
  BackupRestoreOptions,
  BackupRestoreResult,
} from './backup-repository';
import type { RemoteApiClient } from '../services/remote/remote-api-client';

export class RemoteBackupRepository implements BackupRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async exportBackup(): Promise<{ blob: Blob; manifest: BackupManifestV1 }> {
    const { blob } = await this.client.exportBackup();
    const inspection = await this.client.inspectBackup(blob);
    return { blob, manifest: inspection.manifest };
  }

  inspectBackup(archive: Blob): Promise<BackupInspection> {
    return this.client.inspectBackup(archive);
  }

  restoreBackup(archive: Blob, options: BackupRestoreOptions): Promise<BackupRestoreResult> {
    return this.client.restoreBackup(archive, options);
  }
}
