import {
  CloudVaultWriteConflictError,
  type CloudVaultArtifactRepository,
  type CloudVaultContentProvider,
  type CloudVaultFileProvider,
  type CloudVaultSyncReport,
  type CloudVaultSyncScope,
} from './contracts';
import type { CloudVaultContentTransferService } from './content-transfer';
import { canonicalJson } from '../domain/canonical-json';
import { CloudVaultAiTtsTransferService, EMPTY_AI_TTS_TRANSFER_REPORT } from './ai-tts-transfer';
import { decryptCloudVault, encryptCloudVault } from './crypto';
import { mergeCloudVaultSnapshots } from './merge';

export class CloudVaultService {
  constructor(
    private readonly artifacts: CloudVaultArtifactRepository,
    private readonly content?: CloudVaultContentTransferService,
    private readonly aiTts = new CloudVaultAiTtsTransferService(),
  ) {}

  async sync(input: {
    readonly provider: CloudVaultFileProvider;
    readonly passphrase: string;
    readonly deviceId: string;
    readonly scope: CloudVaultSyncScope;
    readonly backupOnly?: boolean;
    readonly knownAiTtsObjectKeys?: Readonly<Record<string, string>>;
  }): Promise<CloudVaultSyncReport> {
    if (input.scope.sourceFiles && !this.content) {
      throw new Error('현재 런타임은 Cloud Vault 작품 파일 동기화를 지원하지 않습니다.');
    }
    let conflict: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remoteObject = await input.provider.read();
      const remoteCore = remoteObject ? await decryptCloudVault(remoteObject.bytes, input.passphrase) : undefined;
      const local = await this.artifacts.capture({ deviceId: input.deviceId, scope: input.scope });
      let uploadedContent = {
        uploadedSourceFiles: 0,
        restoredSourceFiles: 0,
        uploadedContentBytes: 0,
        downloadedContentBytes: 0,
        contentFailures: [] as readonly string[],
      };
      const contentProvider = input.scope.sourceFiles
        ? asContentProvider(input.provider)
        : asOptionalContentProvider(input.provider);
      const hydratedAi =
        input.scope.aiTtsArtifacts && contentProvider
          ? await this.aiTts.hydrateRemote(
              remoteCore,
              local,
              contentProvider,
              input.passphrase,
              input.knownAiTtsObjectKeys,
            )
          : { snapshot: remoteCore, report: EMPTY_AI_TTS_TRANSFER_REPORT };
      let merged = mergeCloudVaultSnapshots(local, hydratedAi.snapshot);
      if (contentProvider && this.content && input.scope.sourceFiles) {
        const prepared = await this.content.uploadLocalContent(merged, contentProvider, local, remoteCore);
        merged = prepared.snapshot;
        uploadedContent = prepared.report;
      }
      const externalizedAi =
        input.scope.aiTtsArtifacts && contentProvider
          ? await this.aiTts.externalize(
              merged,
              contentProvider,
              input.passphrase,
              hydratedAi.report.aiTtsObjectKeys,
              new Set(local.books.map((book) => book.identity.normalizedTextHash)),
            )
          : { snapshot: merged, report: EMPTY_AI_TTS_TRANSFER_REPORT };
      const syncedAt = new Date().toISOString();
      const unchanged = Boolean(remoteCore && equivalentSnapshot(externalizedAi.snapshot, remoteCore));
      let remoteRevision = remoteObject?.revision;
      let uploadedBytes = 0;
      try {
        if (!unchanged) {
          const bytes = await encryptCloudVault(
            { ...externalizedAi.snapshot, generatedAt: syncedAt, deviceId: input.deviceId },
            input.passphrase,
          );
          const written = await input.provider.write(bytes, remoteObject?.revision);
          remoteRevision = written.revision;
          uploadedBytes = bytes.byteLength;
        }
      } catch (error) {
        if (!(error instanceof CloudVaultWriteConflictError)) throw error;
        conflict = error;
        continue;
      }

      if (unchanged) {
        // A no-op sync intentionally avoids rewriting the encrypted manifest,
        // but hydration and sidecar work may have taken long enough for another
        // device to advance it. Probe again before applying the old read.
        const latestRemoteRevision = input.provider.getRevision
          ? await input.provider.getRevision()
          : (await input.provider.read())?.revision;
        if (latestRemoteRevision !== remoteObject?.revision) {
          conflict = new CloudVaultWriteConflictError('Cloud vault changed during no-op synchronization.');
          continue;
        }
      }

      // The manifest is now durably committed. Refuse to apply the earlier
      // snapshot over edits made locally while network work was in flight.
      const localAfterCommit = await this.artifacts.capture({ deviceId: input.deviceId, scope: input.scope });
      if (!equivalentSnapshot(local, localAfterCommit)) {
        conflict = new CloudVaultWriteConflictError('Local library changed during Cloud Vault sync.');
        continue;
      }

      const restoredContent =
        contentProvider && this.content && !input.backupOnly
          ? await this.content.restoreMissingContent(externalizedAi.snapshot, contentProvider)
          : emptyContentReport();
      const applied = input.backupOnly ? emptyApplyReport() : await this.artifacts.apply(merged);
      if (!remoteRevision) throw new Error('Cloud Vault provider did not return a revision.');
      return {
        ...applied,
        provider: input.provider.kind,
        uploadedBytes,
        remoteRevision,
        syncedAt,
        uploadedSourceFiles: uploadedContent.uploadedSourceFiles,
        restoredSourceFiles: restoredContent.restoredSourceFiles,
        uploadedContentBytes: uploadedContent.uploadedContentBytes,
        downloadedContentBytes: restoredContent.downloadedContentBytes,
        uploadedAiTtsFiles: externalizedAi.report.uploadedAiTtsFiles,
        restoredAiTtsFiles: hydratedAi.report.restoredAiTtsFiles,
        uploadedAiTtsBytes: externalizedAi.report.uploadedAiTtsBytes,
        downloadedAiTtsBytes: hydratedAi.report.downloadedAiTtsBytes,
        aiTtsObjectKeys: externalizedAi.report.aiTtsObjectKeys,
        contentFailures: [
          ...uploadedContent.contentFailures,
          ...restoredContent.contentFailures,
          ...hydratedAi.report.contentFailures,
          ...externalizedAi.report.contentFailures,
        ],
      };
    }
    throw conflict instanceof Error ? conflict : new CloudVaultWriteConflictError();
  }
}

function emptyApplyReport() {
  return {
    matchedBooks: 0,
    waitingForSourceBooks: 0,
    appliedRecords: 0,
    quarantinedRecords: 0,
    waitingBookTitles: [] as string[],
  };
}

function emptyContentReport() {
  return {
    uploadedSourceFiles: 0,
    restoredSourceFiles: 0,
    uploadedContentBytes: 0,
    downloadedContentBytes: 0,
    contentFailures: [] as readonly string[],
  };
}

function asContentProvider(provider: CloudVaultFileProvider): CloudVaultContentProvider {
  const candidate = provider as Partial<CloudVaultContentProvider>;
  if (typeof candidate.getObject !== 'function' || typeof candidate.putObject !== 'function') {
    throw new Error('선택한 Cloud Vault 저장소는 작품 파일 동기화를 지원하지 않습니다.');
  }
  return provider as CloudVaultContentProvider;
}

function asOptionalContentProvider(provider: CloudVaultFileProvider): CloudVaultContentProvider | undefined {
  const candidate = provider as Partial<CloudVaultContentProvider>;
  return typeof candidate.getObject === 'function' && typeof candidate.putObject === 'function'
    ? (provider as CloudVaultContentProvider)
    : undefined;
}

function equivalentSnapshot(
  left: import('./contracts').CloudVaultSnapshotV1,
  right: import('./contracts').CloudVaultSnapshotV1,
) {
  const normalize = (value: import('./contracts').CloudVaultSnapshotV1) => ({
    ...value,
    generatedAt: '',
    deviceId: '',
  });
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}
