import type {
  BackupInspection,
  BackupManifestV1,
  BackupRepository,
  BackupRestoreOptions,
  BackupRestoreResult,
} from './backup-repository';
import type { RemoteApiClient } from '../services/remote/remote-api-client';

const MAX_EXPORTED_MANIFEST_BYTES = 8 * 1024 * 1024;

function exportedManifest(value: unknown): BackupManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Backup manifest is invalid');
  const manifest = value as Partial<BackupManifestV1>;
  if (
    manifest.format !== 'noveldesk-backup' ||
    manifest.version !== 1 ||
    typeof manifest.exportedAt !== 'string' ||
    typeof manifest.appVersion !== 'string' ||
    !Array.isArray(manifest.books) ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.assetBlobs)
  ) {
    throw new Error('Backup export did not include a supported manifest');
  }
  return manifest as BackupManifestV1;
}

async function readExportedManifest(archive: Blob): Promise<BackupManifestV1> {
  // The export response is already a self-describing ZIP. Read only its small
  // manifest entry locally instead of uploading the entire archive back to the
  // server through /backups/inspect.
  const { BlobReader, TextWriter, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(archive));
  try {
    const entries = await reader.getEntries();
    const entry = entries.find((candidate) => candidate.filename === 'manifest.json');
    if (!entry || entry.directory || !entry.getData) throw new Error('Backup export manifest is missing');
    if (Number(entry.uncompressedSize ?? 0) > MAX_EXPORTED_MANIFEST_BYTES) {
      throw new Error('Backup export manifest is too large');
    }
    return exportedManifest(JSON.parse(await entry.getData(new TextWriter())));
  } finally {
    await reader.close();
  }
}

export class RemoteBackupRepository implements BackupRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async exportBackup(): Promise<{ blob: Blob; manifest: BackupManifestV1 }> {
    const { blob } = await this.client.exportBackup();
    return { blob, manifest: await readExportedManifest(blob) };
  }

  inspectBackup(archive: Blob): Promise<BackupInspection> {
    return this.client.inspectBackup(archive);
  }

  restoreBackup(archive: Blob, options: BackupRestoreOptions): Promise<BackupRestoreResult> {
    return this.client.restoreBackup(archive, options);
  }
}
