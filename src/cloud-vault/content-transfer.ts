import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Novel } from '../domain/types';
import type { BookAssetRepository, ExportedBookCover, ExportedBookSource } from '../repositories/book-asset-repository';
import type { ReaderRepository } from '../repositories/reader-repository';
import type { ImportService } from '../services/import/import-service';
import type {
  CloudVaultBookV1,
  CloudVaultContentObjectV1,
  CloudVaultContentProvider,
  CloudVaultSnapshotV1,
} from './contracts';

const HASH_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

function hexHash(value: string): string {
  const match = HASH_PATTERN.exec(value.trim());
  if (!match) throw new Error('Cloud Vault content hash is invalid.');
  return match[1]!.toLowerCase();
}

export function cloudVaultContentObjectKey(contentHash: string): string {
  return `content/v1/sha256/${hexHash(contentHash)}`;
}

async function hashBlob(blob: Blob): Promise<string> {
  const digest = sha256Digest.create();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer());
    digest.update(bytes);
    if (offset > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
  return `sha256:${bytesToHex(digest.digest())}`;
}

function descriptor(
  kind: CloudVaultContentObjectV1['kind'],
  exported: ExportedBookSource,
  novel: Novel,
): CloudVaultContentObjectV1 {
  const { metadata } = exported;
  return {
    kind,
    objectKey: cloudVaultContentObjectKey(metadata.contentHash),
    contentHash: `sha256:${hexHash(metadata.contentHash)}`,
    byteLength: metadata.byteLength,
    contentType: metadata.contentType || exported.blob.type || 'application/octet-stream',
    fileName: metadata.fileName || (kind === 'cover' ? 'cover' : novel.sourceFileName),
    encoding: kind === 'source' ? metadata.encoding : undefined,
    provenance: metadata.provenance,
    pixelWidth: kind === 'cover' ? metadata.pixelWidth : undefined,
    pixelHeight: kind === 'cover' ? metadata.pixelHeight : undefined,
    fit: kind === 'cover' ? (novel.coverFit ?? 'crop') : undefined,
    positionX: kind === 'cover' ? (novel.coverPositionX ?? 50) : undefined,
    positionY: kind === 'cover' ? (novel.coverPositionY ?? 50) : undefined,
  };
}

function validateDownloadedObject(value: Blob, content: CloudVaultContentObjectV1): Promise<void> {
  if (value.size !== content.byteLength) {
    throw new Error(`Cloud Vault ${content.kind} size does not match its manifest.`);
  }
  return hashBlob(value).then((actualHash) => {
    if (actualHash !== `sha256:${hexHash(content.contentHash)}`) {
      throw new Error(`Cloud Vault ${content.kind} hash does not match its manifest.`);
    }
  });
}

async function uploadObject(
  provider: CloudVaultContentProvider,
  content: CloudVaultContentObjectV1,
  blob: Blob,
): Promise<{ created: boolean; bytes: number }> {
  if (blob.size !== content.byteLength) throw new Error(`Local ${content.kind} size changed during sync.`);
  const result = await provider.putObject(content.objectKey, blob, { byteLength: content.byteLength });
  return { created: result.created, bytes: result.created ? blob.size : 0 };
}

export interface CloudVaultContentTransferReport {
  readonly uploadedSourceFiles: number;
  readonly restoredSourceFiles: number;
  readonly uploadedContentBytes: number;
  readonly downloadedContentBytes: number;
  readonly contentFailures: readonly string[];
}

const EMPTY_REPORT: CloudVaultContentTransferReport = {
  uploadedSourceFiles: 0,
  restoredSourceFiles: 0,
  uploadedContentBytes: 0,
  downloadedContentBytes: 0,
  contentFailures: [],
};

function metadataWasSelectedFromLocal(book: CloudVaultBookV1, localBook: CloudVaultBookV1 | undefined): boolean {
  if (!localBook) return false;
  return (
    book.revisions.metadataAt === localBook.revisions.metadataAt &&
    book.identity.updatedAt === localBook.identity.updatedAt &&
    book.identity.metadataRevision === localBook.identity.metadataRevision
  );
}

function contentClock(book: CloudVaultBookV1): string {
  return book.revisions.contentAt ?? book.revisions.metadataAt;
}

function contentOwner(book: CloudVaultBookV1): string {
  return book.revisions.contentDeviceId ?? book.identity.vaultBookId ?? book.identity.bookId;
}

function contentWasSelectedFromLocal(book: CloudVaultBookV1, localBook: CloudVaultBookV1 | undefined): boolean {
  if (!localBook || book.identity.normalizedTextHash !== localBook.identity.normalizedTextHash) return false;
  return contentClock(book) === contentClock(localBook) && contentOwner(book) === contentOwner(localBook);
}

function activeSourceMatches(
  current: Awaited<ReturnType<BookAssetRepository['getActiveSource']>>,
  expected: CloudVaultContentObjectV1,
): boolean {
  if (!current) return false;
  return (
    `sha256:${hexHash(current.contentHash)}` === `sha256:${hexHash(expected.contentHash)}` &&
    current.byteLength === expected.byteLength &&
    current.contentType === expected.contentType &&
    current.fileName === expected.fileName &&
    current.encoding === expected.encoding
  );
}

function activeCoverMatches(novel: Novel, current: ExportedBookCover, expected: CloudVaultContentObjectV1): boolean {
  return (
    `sha256:${hexHash(current.metadata.contentHash)}` === `sha256:${hexHash(expected.contentHash)}` &&
    current.metadata.byteLength === expected.byteLength &&
    (novel.coverFit ?? 'crop') === (expected.fit ?? 'crop') &&
    (novel.coverPositionX ?? 50) === (expected.positionX ?? 50) &&
    (novel.coverPositionY ?? 50) === (expected.positionY ?? 50)
  );
}

export class CloudVaultContentTransferService {
  constructor(
    private readonly repository: ReaderRepository,
    private readonly assets: BookAssetRepository,
    private readonly importer: ImportService,
  ) {}

  async uploadLocalContent(
    snapshot: CloudVaultSnapshotV1,
    provider: CloudVaultContentProvider,
    localSnapshot?: CloudVaultSnapshotV1,
  ): Promise<{ snapshot: CloudVaultSnapshotV1; report: CloudVaultContentTransferReport }> {
    if (!snapshot.scope.sourceFiles) return { snapshot, report: EMPTY_REPORT };
    const novels = await this.repository.listNovels();
    const novelById = new Map(novels.map((novel) => [novel.id, novel]));
    const novelByHash = new Map(novels.map((novel) => [novel.normalizedTextHash, novel]));
    const novelByVaultId = new Map(
      novels.flatMap((novel) => (novel.cloudVaultBookId ? [[novel.cloudVaultBookId, novel] as const] : [])),
    );
    const localBooks = localSnapshot?.books ?? [];
    let uploadedSourceFiles = 0;
    let uploadedContentBytes = 0;
    const contentFailures: string[] = [];

    const books: CloudVaultBookV1[] = [];
    for (const book of snapshot.books) {
      const localBook = localBooks.find(
        (candidate) =>
          (book.identity.vaultBookId && candidate.identity.vaultBookId === book.identity.vaultBookId) ||
          candidate.identity.normalizedTextHash === book.identity.normalizedTextHash,
      );
      const novel =
        (book.identity.vaultBookId ? novelByVaultId.get(book.identity.vaultBookId) : undefined) ??
        novelById.get(book.identity.bookId) ??
        novelByHash.get(book.identity.normalizedTextHash);
      if (!novel) {
        books.push(book);
        continue;
      }
      let sourceObject = book.sourceObject;
      let coverObject = book.coverObject;
      const localMatchesSelectedBody = novel.normalizedTextHash === book.identity.normalizedTextHash;
      const maySupplySource =
        localMatchesSelectedBody &&
        (!localSnapshot || contentWasSelectedFromLocal(book, localBook) || sourceObject === undefined);
      if (maySupplySource) {
        try {
          const exported = await this.assets.exportSource(novel.id, {
            activeContentRevisionId: novel.activeContentRevisionId,
          });
          if (exported) {
            const nextObject = descriptor('source', exported, novel);
            if (
              sourceObject?.contentHash !== nextObject.contentHash ||
              sourceObject.byteLength !== nextObject.byteLength
            ) {
              const uploaded = await uploadObject(provider, nextObject, exported.blob);
              if (uploaded.created) uploadedSourceFiles += 1;
              uploadedContentBytes += uploaded.bytes;
            }
            sourceObject = nextObject;
          }
        } catch (error) {
          contentFailures.push(`${novel.title}: ${error instanceof Error ? error.message : '원본 업로드 실패'}`);
        }
      }
      const localOwnsMetadata = !localSnapshot || metadataWasSelectedFromLocal(book, localBook);
      if (localOwnsMetadata) {
        try {
          const exported = await this.assets.getActiveCover(novel.id);
          if (exported) {
            const nextObject = descriptor('cover', exported, novel);
            if (
              coverObject?.contentHash !== nextObject.contentHash ||
              coverObject.byteLength !== nextObject.byteLength
            ) {
              const uploaded = await uploadObject(provider, nextObject, exported.blob);
              uploadedContentBytes += uploaded.bytes;
            }
            coverObject = nextObject;
          }
        } catch (error) {
          contentFailures.push(`${novel.title}: ${error instanceof Error ? error.message : '표지 업로드 실패'}`);
        }
      }
      books.push({ ...book, sourceObject, coverObject });
    }

    return {
      snapshot: { ...snapshot, books },
      report: {
        ...EMPTY_REPORT,
        uploadedSourceFiles,
        uploadedContentBytes,
        contentFailures,
      },
    };
  }

  async restoreMissingContent(
    snapshot: CloudVaultSnapshotV1,
    provider: CloudVaultContentProvider,
  ): Promise<CloudVaultContentTransferReport> {
    if (!snapshot.scope.sourceFiles) return EMPTY_REPORT;
    const novels = await this.repository.listNovels();
    const novelByHash = new Map(novels.map((novel) => [novel.normalizedTextHash, novel]));
    const novelByVaultId = new Map(
      novels.flatMap((novel) => (novel.cloudVaultBookId ? [[novel.cloudVaultBookId, novel] as const] : [])),
    );
    let restoredSourceFiles = 0;
    let downloadedContentBytes = 0;
    const contentFailures: string[] = [];

    for (const book of snapshot.books) {
      let localNovel =
        (book.identity.vaultBookId ? novelByVaultId.get(book.identity.vaultBookId) : undefined) ??
        novelByHash.get(book.identity.normalizedTextHash);
      let needsReplacement = Boolean(localNovel && localNovel.normalizedTextHash !== book.identity.normalizedTextHash);
      if (localNovel && book.sourceObject && !needsReplacement) {
        try {
          const localSource = await this.assets.getActiveSource(localNovel.id, {
            activeContentRevisionId: localNovel.activeContentRevisionId,
          });
          needsReplacement = !activeSourceMatches(localSource, book.sourceObject);
        } catch (error) {
          contentFailures.push(
            `${book.identity.title}: ${error instanceof Error ? error.message : '로컬 원본 확인 실패'}`,
          );
          continue;
        }
      }
      if ((!localNovel || needsReplacement) && book.sourceObject) {
        try {
          if (needsReplacement && this.importer.supportsExpectedNormalizedTextHash !== true) {
            throw new Error('현재 가져오기 런타임은 Cloud Vault 본문 교체의 사전 검증을 지원하지 않습니다.');
          }
          const stored = await provider.getObject(book.sourceObject.objectKey);
          if (!stored) throw new Error('클라우드에 원본 파일이 없습니다.');
          await validateDownloadedObject(stored.blob, book.sourceObject);
          const file = new File([stored.blob], book.sourceObject.fileName, {
            type: book.sourceObject.contentType,
            lastModified: Date.now(),
          });
          const imported = await this.importer.importFile(
            {
              file,
              encoding: book.sourceObject.encoding ?? 'auto',
              chapterSplitMode: 'auto',
              clientBookId: localNovel?.id,
              expectedNormalizedTextHash:
                this.importer.supportsExpectedNormalizedTextHash === true
                  ? book.identity.normalizedTextHash
                  : undefined,
            },
            () => undefined,
          ).promise;
          if (imported.novel.normalizedTextHash !== book.identity.normalizedTextHash) {
            if (!localNovel) await this.repository.deleteNovel(imported.novel.id).catch(() => undefined);
            throw new Error('복원한 원본의 본문 식별자가 Vault 기록과 다릅니다.');
          }
          if (localNovel) novelByHash.delete(localNovel.normalizedTextHash);
          localNovel = imported.novel;
          novelByHash.set(localNovel.normalizedTextHash, localNovel);
          if (book.identity.vaultBookId) novelByVaultId.set(book.identity.vaultBookId, localNovel);
          restoredSourceFiles += 1;
          downloadedContentBytes += stored.blob.size;
        } catch (error) {
          contentFailures.push(`${book.identity.title}: ${error instanceof Error ? error.message : '원본 복원 실패'}`);
        }
      } else if (needsReplacement && !book.sourceObject) {
        contentFailures.push(`${book.identity.title}: Cloud Vault에 최신 본문 원본 파일이 없습니다.`);
      }

      if (localNovel && book.coverObject) {
        try {
          const currentCover = await this.assets.getActiveCover(localNovel.id);
          if (!currentCover || !activeCoverMatches(localNovel, currentCover, book.coverObject)) {
            const stored = await provider.getObject(book.coverObject.objectKey);
            if (!stored) throw new Error('클라우드에 표지 파일이 없습니다.');
            await validateDownloadedObject(stored.blob, book.coverObject);
            const contentType = book.coverObject.contentType;
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
              throw new Error('지원하지 않는 표지 형식입니다.');
            }
            await this.assets.saveCover(localNovel.id, {
              blob: stored.blob,
              fileName: book.coverObject.fileName,
              contentType: contentType as 'image/jpeg' | 'image/png' | 'image/webp',
              contentHash: book.coverObject.contentHash,
              pixelWidth: book.coverObject.pixelWidth ?? 0,
              pixelHeight: book.coverObject.pixelHeight ?? 0,
              fit: book.coverObject.fit ?? 'crop',
              positionX: book.coverObject.positionX ?? 50,
              positionY: book.coverObject.positionY ?? 50,
              expectedMetadataRevision: localNovel.metadataRevision ?? 0,
              expectedContentRevisionId: localNovel.activeContentRevisionId,
            });
            downloadedContentBytes += stored.blob.size;
          }
        } catch (error) {
          contentFailures.push(`${book.identity.title}: ${error instanceof Error ? error.message : '표지 복원 실패'}`);
        }
      }
    }

    return {
      ...EMPTY_REPORT,
      restoredSourceFiles,
      downloadedContentBytes,
      contentFailures,
    };
  }
}
