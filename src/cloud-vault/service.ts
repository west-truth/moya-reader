import {
  CloudVaultWriteConflictError,
  type CloudVaultArtifactRepository,
  type CloudVaultFileProvider,
  type CloudVaultSyncReport,
  type CloudVaultSyncScope,
} from './contracts';
import { decryptCloudVault, encryptCloudVault } from './crypto';
import { mergeCloudVaultSnapshots } from './merge';

export class CloudVaultService {
  constructor(private readonly artifacts: CloudVaultArtifactRepository) {}

  async sync(input: {
    readonly provider: CloudVaultFileProvider;
    readonly passphrase: string;
    readonly deviceId: string;
    readonly scope: CloudVaultSyncScope;
    readonly backupOnly?: boolean;
  }): Promise<CloudVaultSyncReport> {
    let conflict: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remoteObject = await input.provider.read();
      const remote = remoteObject ? await decryptCloudVault(remoteObject.bytes, input.passphrase) : undefined;
      const local = await this.artifacts.capture({ deviceId: input.deviceId, scope: input.scope });
      const merged = mergeCloudVaultSnapshots(local, remote);
      const applied = input.backupOnly
        ? {
            matchedBooks: 0,
            waitingForSourceBooks: 0,
            appliedRecords: 0,
            quarantinedRecords: 0,
            waitingBookTitles: [],
          }
        : await this.artifacts.apply(merged);
      const bytes = await encryptCloudVault(merged, input.passphrase);
      try {
        const written = await input.provider.write(bytes, remoteObject?.revision);
        return {
          ...applied,
          provider: input.provider.kind,
          uploadedBytes: bytes.byteLength,
          remoteRevision: written.revision,
          syncedAt: merged.generatedAt,
        };
      } catch (error) {
        if (!(error instanceof CloudVaultWriteConflictError)) throw error;
        conflict = error;
      }
    }
    throw conflict instanceof Error ? conflict : new CloudVaultWriteConflictError();
  }
}
