import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../domain/hash';
import type { Novel } from '../domain/types';
import type { BookAssetRepository } from '../repositories/book-asset-repository';
import type { ReaderRepository } from '../repositories/reader-repository';
import type { ImportFileInput, ImportService } from '../services/import/import-service';
import {
  CloudVaultContentTransferService,
  cloudVaultContentObjectKey,
  type CloudVaultContentTransferReport,
} from './content-transfer';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_VERSION,
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultBookV1,
  type CloudVaultContentProvider,
  type CloudVaultSnapshotV1,
} from './contracts';

function novel(input: { id?: string; hash?: string; title?: string } = {}): Novel {
  return {
    id: input.id ?? 'book-local',
    format: 'txt',
    title: input.title ?? '동기화 작품',
    sourceFileName: '동기화 작품.txt',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'raw-hash',
    normalizedTextHash: input.hash ?? 'normalized-hash',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 2,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function book(item: Novel): CloudVaultBookV1 {
  return {
    identity: {
      bookId: item.id,
      normalizedTextHash: item.normalizedTextHash,
      format: 'txt',
      title: item.title,
      favorite: false,
      metadataRevision: 0,
      updatedAt: item.updatedAt,
    },
    revisions: {
      metadataAt: item.updatedAt,
      readerAt: item.updatedAt,
      annotationsAt: item.updatedAt,
      statisticsAt: item.updatedAt,
      aiTtsAt: item.updatedAt,
    },
    chapters: [],
    paragraphs: [],
    bookmarks: [],
    highlights: [],
    notes: [],
    readingSessions: [],
    characters: [],
    characterRelations: [],
    segments: [],
    voiceProfiles: [],
    corrections: [],
  };
}

function snapshot(item: CloudVaultBookV1): CloudVaultSnapshotV1 {
  return {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    generatedAt: '2026-08-28T00:00:00.000Z',
    deviceId: 'device-a',
    scope: { ...DEFAULT_CLOUD_VAULT_SCOPE, sourceFiles: true },
    books: [item],
    shelves: [],
    shelfMemberships: [],
    tombstones: [],
  };
}

function provider(): CloudVaultContentProvider & { readonly objects: Map<string, Blob> } {
  const objects = new Map<string, Blob>();
  return {
    kind: 'directory',
    label: 'memory',
    objects,
    read: async () => undefined,
    write: async () => ({ revision: 'rev' }),
    getObject: async (key) => {
      const blob = objects.get(key);
      return blob ? { blob } : undefined;
    },
    putObject: async (key, blob, expected) => {
      if (blob.size !== expected.byteLength) throw new Error('size mismatch');
      const created = !objects.has(key);
      if (created) objects.set(key, blob);
      return { created };
    },
  };
}

function reportDefaults(report: CloudVaultContentTransferReport) {
  return {
    uploadedSourceFiles: report.uploadedSourceFiles,
    restoredSourceFiles: report.restoredSourceFiles,
    uploadedContentBytes: report.uploadedContentBytes,
    downloadedContentBytes: report.downloadedContentBytes,
    contentFailures: report.contentFailures,
  };
}

describe('Cloud Vault content transfer', () => {
  it('uploads an original once and records only its content-addressed descriptor in the encrypted snapshot', async () => {
    const localNovel = novel();
    const blob = new Blob(['원본 본문'], { type: 'text/plain' });
    const contentHash = `sha256:${await sha256(await blob.arrayBuffer())}`;
    const store = provider();
    const assets = {
      exportSource: vi.fn(async () => ({
        metadata: {
          id: 'source-a',
          bookId: localNovel.id,
          contentRevisionId: 'revision-a',
          kind: 'source',
          provenance: 'original',
          status: 'active',
          storageKey: 'local-only',
          fileName: localNovel.sourceFileName,
          contentType: 'text/plain',
          byteLength: blob.size,
          contentHash,
          encoding: 'utf-8',
          createdAt: localNovel.createdAt,
        },
        blob,
      })),
      getActiveCover: vi.fn(async () => undefined),
    } as unknown as BookAssetRepository;
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      assets,
      {} as ImportService,
    );

    const first = await service.uploadLocalContent(snapshot(book(localNovel)), store);
    const second = await service.uploadLocalContent(first.snapshot, store);

    expect(first.snapshot.books[0]?.sourceObject).toMatchObject({
      objectKey: cloudVaultContentObjectKey(contentHash),
      contentHash,
      fileName: localNovel.sourceFileName,
      encoding: 'utf-8',
    });
    expect(first.report.uploadedSourceFiles).toBe(1);
    expect(second.report.uploadedSourceFiles).toBe(0);
    expect(store.objects.size).toBe(1);
  });

  it('restores a missing work through the normal importer and verifies the downloaded object hash first', async () => {
    const remoteNovel = novel({ id: 'remote-book' });
    const blob = new Blob(['원본 본문'], { type: 'text/plain' });
    const contentHash = `sha256:${await sha256(await blob.arrayBuffer())}`;
    const objectKey = cloudVaultContentObjectKey(contentHash);
    const remoteBook = {
      ...book(remoteNovel),
      sourceObject: {
        kind: 'source' as const,
        objectKey,
        contentHash,
        byteLength: blob.size,
        contentType: 'text/plain',
        fileName: '동기화 작품.txt',
        encoding: 'utf-8' as const,
      },
    };
    const store = provider();
    store.objects.set(objectKey, blob);
    const importedNovel = novel({ id: 'restored-book' });
    const importer = {
      importFile: vi.fn(() => ({
        jobId: 'restore-job',
        promise: Promise.resolve({ novel: importedNovel }),
        cancel: () => undefined,
      })),
    } as ImportService;
    const repository = {
      listNovels: vi.fn(async () => []),
      deleteNovel: vi.fn(async () => undefined),
    } as unknown as ReaderRepository;
    const assets = {
      getActiveCover: vi.fn(async () => undefined),
    } as unknown as BookAssetRepository;
    const service = new CloudVaultContentTransferService(repository, assets, importer);

    const result = await service.restoreMissingContent(snapshot(remoteBook), store);

    expect(importer.importFile).toHaveBeenCalledTimes(1);
    expect(reportDefaults(result)).toMatchObject({
      restoredSourceFiles: 1,
      downloadedContentBytes: blob.size,
      contentFailures: [],
    });
  });

  it('keeps the remotely selected cover descriptor and replaces an older cover already present locally', async () => {
    const localNovel = novel();
    const oldCover = new Blob(['old-cover'], { type: 'image/png' });
    const newCover = new Blob(['new-cover'], { type: 'image/png' });
    const oldHash = `sha256:${await sha256(await oldCover.arrayBuffer())}`;
    const newHash = `sha256:${await sha256(await newCover.arrayBuffer())}`;
    const remoteBook = {
      ...book(localNovel),
      identity: {
        ...book(localNovel).identity,
        metadataRevision: 2,
        updatedAt: '2026-08-29T00:00:00.000Z',
      },
      revisions: {
        ...book(localNovel).revisions,
        metadataAt: '2026-08-29T00:00:00.000Z',
      },
      coverObject: {
        kind: 'cover' as const,
        objectKey: cloudVaultContentObjectKey(newHash),
        contentHash: newHash,
        byteLength: newCover.size,
        contentType: 'image/png',
        fileName: 'new-cover.png',
        fit: 'contain' as const,
        positionX: 50,
        positionY: 50,
      },
    };
    const store = provider();
    store.objects.set(remoteBook.coverObject.objectKey, newCover);
    const saveCover = vi.fn(async () => ({ id: 'new-cover-asset' }));
    const assets = {
      exportSource: vi.fn(async () => undefined),
      getActiveCover: vi.fn(async () => ({
        metadata: {
          contentHash: oldHash,
          byteLength: oldCover.size,
          fileName: 'old-cover.png',
          contentType: 'image/png',
        },
        blob: oldCover,
      })),
      saveCover,
    } as unknown as BookAssetRepository;
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      assets,
      {} as ImportService,
    );

    const prepared = await service.uploadLocalContent(snapshot(remoteBook), store, snapshot(book(localNovel)));
    const restored = await service.restoreMissingContent(prepared.snapshot, store);

    expect(prepared.snapshot.books[0]?.coverObject).toEqual(remoteBook.coverObject);
    expect(store.objects.size).toBe(1);
    expect(saveCover).toHaveBeenCalledWith(
      localNovel.id,
      expect.objectContaining({ contentHash: newHash, fit: 'contain' }),
    );
    expect(restored.downloadedContentBytes).toBe(newCover.size);
    expect(restored.contentFailures).toEqual([]);
  });

  it('applies changed cover layout even when the image bytes are unchanged', async () => {
    const localNovel = novel();
    const cover = new Blob(['same-cover'], { type: 'image/png' });
    const contentHash = `sha256:${await sha256(await cover.arrayBuffer())}`;
    const remoteBook = {
      ...book(localNovel),
      coverObject: {
        kind: 'cover' as const,
        objectKey: cloudVaultContentObjectKey(contentHash),
        contentHash,
        byteLength: cover.size,
        contentType: 'image/png',
        fileName: 'cover.png',
        fit: 'contain' as const,
        positionX: 40,
        positionY: 60,
      },
    };
    const store = provider();
    store.objects.set(remoteBook.coverObject.objectKey, cover);
    const saveCover = vi.fn(async () => ({ id: 'layout-cover-asset' }));
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      {
        getActiveCover: async () => ({
          metadata: {
            contentHash,
            byteLength: cover.size,
            fileName: 'cover.png',
            contentType: 'image/png',
          },
          blob: cover,
        }),
        saveCover,
      } as unknown as BookAssetRepository,
      {} as ImportService,
    );

    await service.restoreMissingContent(snapshot(remoteBook), store);

    expect(saveCover).toHaveBeenCalledWith(
      localNovel.id,
      expect.objectContaining({ contentHash, fit: 'contain', positionX: 40, positionY: 60 }),
    );
  });

  it('does not import a corrupted remote object', async () => {
    const remoteNovel = novel({ id: 'remote-book' });
    const expected = new Blob(['expected'], { type: 'text/plain' });
    const contentHash = `sha256:${await sha256(await expected.arrayBuffer())}`;
    const objectKey = cloudVaultContentObjectKey(contentHash);
    const remoteBook = {
      ...book(remoteNovel),
      sourceObject: {
        kind: 'source' as const,
        objectKey,
        contentHash,
        byteLength: expected.size,
        contentType: 'text/plain',
        fileName: '동기화 작품.txt',
      },
    };
    const store = provider();
    store.objects.set(objectKey, new Blob(['corrupt!'], { type: 'text/plain' }));
    const importer = { importFile: vi.fn() } as unknown as ImportService;
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [] } as unknown as ReaderRepository,
      { getActiveCover: async () => undefined } as unknown as BookAssetRepository,
      importer,
    );

    const result = await service.restoreMissingContent(snapshot(remoteBook), store);

    expect(importer.importFile).not.toHaveBeenCalled();
    expect(result.restoredSourceFiles).toBe(0);
    expect(result.contentFailures).toHaveLength(1);
  });

  it('keeps the last committed descriptor when a replacement upload fails', async () => {
    const localNovel = novel();
    const previous = {
      kind: 'source' as const,
      objectKey: `content/v1/sha256/${'a'.repeat(64)}`,
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteLength: 3,
      contentType: 'text/plain',
      fileName: 'previous.txt',
    };
    const replacement = new Blob(['replacement'], { type: 'text/plain' });
    const replacementHash = `sha256:${await sha256(await replacement.arrayBuffer())}`;
    const assets = {
      exportSource: async () => ({
        metadata: {
          contentHash: replacementHash,
          byteLength: replacement.size,
          contentType: 'text/plain',
          fileName: 'replacement.txt',
        },
        blob: replacement,
      }),
      getActiveCover: async () => undefined,
    } as unknown as BookAssetRepository;
    const store = { ...provider(), putObject: vi.fn(async () => Promise.reject(new Error('offline'))) };
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      assets,
      {} as ImportService,
    );

    const prepared = await service.uploadLocalContent(snapshot({ ...book(localNovel), sourceObject: previous }), store);

    expect(prepared.snapshot.books[0]?.sourceObject).toEqual(previous);
    expect(prepared.report.contentFailures).toHaveLength(1);
  });

  it('does not let an older stable-id peer overwrite the selected source descriptor', async () => {
    const localNovel = { ...novel({ hash: 'old-body' }), cloudVaultBookId: 'vault-shared' };
    const localBook: CloudVaultBookV1 = {
      ...book(localNovel),
      identity: { ...book(localNovel).identity, vaultBookId: 'vault-shared' },
      revisions: {
        ...book(localNovel).revisions,
        contentAt: '2026-08-01T00:00:00.000Z',
        contentDeviceId: 'device-old',
      },
    };
    const selectedDescriptor = {
      kind: 'source' as const,
      objectKey: `content/v1/sha256/${'a'.repeat(64)}`,
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteLength: 10,
      contentType: 'text/plain',
      fileName: 'new.txt',
    };
    const selectedBook: CloudVaultBookV1 = {
      ...localBook,
      identity: { ...localBook.identity, normalizedTextHash: 'new-body' },
      revisions: {
        ...localBook.revisions,
        contentAt: '2026-08-02T00:00:00.000Z',
        contentDeviceId: 'device-new',
      },
      sourceObject: selectedDescriptor,
    };
    const assets = {
      exportSource: vi.fn(async () => {
        throw new Error('old source must not be read');
      }),
      getActiveCover: async () => undefined,
    } as unknown as BookAssetRepository;
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      assets,
      {} as ImportService,
    );

    const prepared = await service.uploadLocalContent(snapshot(selectedBook), provider(), snapshot(localBook));

    expect(assets.exportSource).not.toHaveBeenCalled();
    expect(prepared.snapshot.books[0]?.sourceObject).toEqual(selectedDescriptor);
    expect(prepared.report.contentFailures).toEqual([]);
  });

  it('replaces an existing stable-id book only through a pre-activation normalized-hash fence', async () => {
    const localNovel = { ...novel({ hash: 'old-body' }), cloudVaultBookId: 'vault-shared' };
    const remoteBlob = new Blob(['new source'], { type: 'text/plain' });
    const rawHash = `sha256:${await sha256(await remoteBlob.arrayBuffer())}`;
    const remoteBook: CloudVaultBookV1 = {
      ...book(localNovel),
      identity: {
        ...book(localNovel).identity,
        vaultBookId: 'vault-shared',
        normalizedTextHash: 'new-body',
      },
      revisions: {
        ...book(localNovel).revisions,
        contentAt: '2026-08-02T00:00:00.000Z',
        contentDeviceId: 'device-new',
      },
      sourceObject: {
        kind: 'source',
        objectKey: cloudVaultContentObjectKey(rawHash),
        contentHash: rawHash,
        byteLength: remoteBlob.size,
        contentType: 'text/plain',
        fileName: 'new.txt',
      },
    };
    const store = provider();
    store.objects.set(remoteBook.sourceObject!.objectKey, remoteBlob);
    const importFile = vi.fn((input: ImportFileInput) => ({
      jobId: 'replacement',
      cancel: () => undefined,
      promise: Promise.resolve({ novel: { ...localNovel, normalizedTextHash: input.expectedNormalizedTextHash! } }),
    }));
    const importer = {
      supportsExpectedNormalizedTextHash: true,
      importFile,
    } as unknown as ImportService;
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      { getActiveCover: async () => undefined } as unknown as BookAssetRepository,
      importer,
    );

    const report = await service.restoreMissingContent(snapshot(remoteBook), store);

    expect(importFile).toHaveBeenCalledWith(
      expect.objectContaining({
        clientBookId: localNovel.id,
        expectedNormalizedTextHash: 'new-body',
      }),
      expect.any(Function),
    );
    expect(report.restoredSourceFiles).toBe(1);
    expect(report.contentFailures).toEqual([]);
  });

  it('replaces the raw source when its bytes or format change even if normalized text is unchanged', async () => {
    const localNovel = { ...novel(), cloudVaultBookId: 'vault-shared' };
    const oldBlob = new Blob(['old container'], { type: 'text/plain' });
    const newBlob = new Blob(['new epub container'], { type: 'application/epub+zip' });
    const oldRawHash = `sha256:${await sha256(await oldBlob.arrayBuffer())}`;
    const newRawHash = `sha256:${await sha256(await newBlob.arrayBuffer())}`;
    const remoteBook: CloudVaultBookV1 = {
      ...book(localNovel),
      identity: {
        ...book(localNovel).identity,
        vaultBookId: 'vault-shared',
        format: 'epub',
      },
      revisions: {
        ...book(localNovel).revisions,
        contentAt: '2026-08-02T00:00:00.000Z',
        contentDeviceId: 'device-new',
      },
      sourceObject: {
        kind: 'source',
        objectKey: cloudVaultContentObjectKey(newRawHash),
        contentHash: newRawHash,
        byteLength: newBlob.size,
        contentType: 'application/epub+zip',
        fileName: 'new.epub',
      },
    };
    const store = provider();
    store.objects.set(remoteBook.sourceObject!.objectKey, newBlob);
    const importFile = vi.fn((input: ImportFileInput) => ({
      jobId: 'replacement',
      cancel: () => undefined,
      promise: Promise.resolve({
        novel: { ...localNovel, format: 'epub' as const, normalizedTextHash: input.expectedNormalizedTextHash! },
      }),
    }));
    const service = new CloudVaultContentTransferService(
      { listNovels: async () => [localNovel] } as ReaderRepository,
      {
        getActiveSource: async () => ({
          id: 'old-source',
          bookId: localNovel.id,
          kind: 'source',
          provenance: 'original',
          status: 'active',
          storageKey: 'old-source',
          fileName: 'old.txt',
          contentType: 'text/plain',
          byteLength: oldBlob.size,
          contentHash: oldRawHash,
          createdAt: localNovel.createdAt,
        }),
        getActiveCover: async () => undefined,
      } as unknown as BookAssetRepository,
      { supportsExpectedNormalizedTextHash: true, importFile } as ImportService,
    );

    const report = await service.restoreMissingContent(snapshot(remoteBook), store);

    expect(importFile).toHaveBeenCalledWith(
      expect.objectContaining({
        clientBookId: localNovel.id,
        expectedNormalizedTextHash: localNovel.normalizedTextHash,
      }),
      expect.any(Function),
    );
    expect(report.restoredSourceFiles).toBe(1);
    expect(report.contentFailures).toEqual([]);
  });
});
