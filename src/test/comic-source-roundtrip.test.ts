import 'fake-indexeddb/auto';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { IndexedDbBackupRepository } from '../repositories/indexeddb-backup-repository';
import { exportPortableBookSource } from '../repositories/comic-source-export';
import { runBrowserFixedDocumentImportPipeline } from '../services/import/browser-import-pipeline';
import type { ImportFileInput, ImportService } from '../services/import/import-service';
import { buildSeriesImageArchive } from '../services/import/series-image-archive';
import { getActiveComicAssetMetadata } from '../storage/book-asset-store';
import { resetReaderDbForTests } from '../storage/db';
import { readComicSourceManifest } from '@noveldesk/fixed-document-core/comic-source';
import { CloudVaultContentTransferService } from '../cloud-vault/content-transfer';
import { IndexedDbCloudVaultArtifactRepository } from '../cloud-vault/indexeddb-artifact-repository';
import { DEFAULT_CLOUD_VAULT_SCOPE, type CloudVaultContentProvider } from '../cloud-vault/contracts';
import { mergeCloudVaultSnapshots } from '../cloud-vault/merge';

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);
const reader = new IndexedDbReaderRepository();
const assets = new IndexedDbBookAssetRepository();
afterEach(() => resetReaderDbForTests());

async function chapter(number: number, bookId = 'comic') {
  const writer = new ZipWriter(new BlobWriter());
  await writer.add('001.png', new Uint8ArrayReader(PNG));
  return buildSeriesImageArchive({
    collection: { remoteId: 'work', title: '연재 작품' },
    targetBookId: bookId,
    chapters: [
      {
        remoteId: `chapter:${number}`,
        release: { title: `${number}화`, chapterNumber: number },
        sourceContentHash: `fixture-${number}`,
        file: await writer.close(),
      },
    ],
    signal: new AbortController().signal,
  });
}

async function importInput(input: ImportFileInput) {
  return runBrowserFixedDocumentImportPipeline({
    ...input,
    fileName: input.file.name,
    sourceBlob: input.file,
    buffer: new ArrayBuffer(0),
    totalBytes: input.file.size,
    jobId: 'fixture',
    onProgress: () => undefined,
  });
}

async function add(number: number, bookId = 'comic') {
  const current = await reader.getNovel(bookId);
  return importInput({
    file: await chapter(number, bookId),
    encoding: 'auto',
    clientBookId: bookId,
    importMode: current ? 'append_image_series' : 'replace_book',
    baseActiveContentRevisionId: current?.activeContentRevisionId,
  });
}

async function assertReadable(bookId: string, sectionCount: number) {
  const chapters = await reader.listChapters(bookId);
  expect(chapters).toHaveLength(sectionCount);
  for (const chapter of chapters) {
    const page = await reader.getParagraphPage(chapter.id, 0);
    expect(page?.paragraphs[0]?.assetId).toBeDefined();
    const resource = await assets.getEmbeddedResource(bookId, page!.paragraphs[0]!.assetId!);
    expect(resource?.metadata.kind).toBe('document_page');
    expect(resource!.blob.size).toBe(PNG.length);
  }
}

describe('comic part storage round trips', () => {
  it('refreshes reused page indexes when Vault restores earlier chapters into an existing device', async () => {
    await add(2);
    await add(3);
    const artifacts = new IndexedDbCloudVaultArtifactRepository(reader);
    const capture = () =>
      artifacts.capture({
        deviceId: 'fixture-device',
        scope: { ...DEFAULT_CLOUD_VAULT_SCOPE, aiTtsArtifacts: false, sourceFiles: true },
      });
    await artifacts.apply(await capture());
    const backup = new IndexedDbBackupRepository();
    const oldLibrary = await backup.exportBackup();
    const oldPages = (await getActiveComicAssetMetadata('comic')).filter((asset) => asset.kind === 'document_page');
    await add(1);
    const objects = new Map<string, Blob>();
    const provider: CloudVaultContentProvider = {
      kind: 'directory',
      label: 'fixture',
      read: async () => undefined,
      write: async () => ({ revision: 'fixture' }),
      getObject: async (key) => (objects.has(key) ? { blob: objects.get(key)! } : undefined),
      putObject: async (key, blob) => {
        const created = !objects.has(key);
        if (created) objects.set(key, blob);
        return { created };
      },
    };
    const importer: ImportService = {
      supportsExpectedNormalizedTextHash: true,
      importFile: (input) => ({ jobId: 'restore', promise: importInput(input), cancel: () => undefined }),
    };
    const service = new CloudVaultContentTransferService(reader, assets, importer);
    const remote = await service.uploadLocalContent(await capture(), provider);
    expect(remote.report.contentFailures).toEqual([]);
    // Return to the other device's older library without discarding its immutable assets.
    await backup.restoreBackup(oldLibrary.blob, { defaultConflictResolution: 'replace' });
    expect((await reader.getNovel('comic'))?.cloudVaultBookId).toBe('comic');
    expect(await service.restoreMissingContent(remote.snapshot, provider)).toMatchObject({
      contentFailures: [],
      restoredSourceFiles: 1,
    });
    const restoredPages = (await getActiveComicAssetMetadata('comic')).filter(
      (asset) => asset.kind === 'document_page',
    );
    expect(restoredPages.map((page) => page.pageIndex).sort()).toEqual([0, 1, 2]);
    for (const page of oldPages) {
      expect(restoredPages.find((asset) => asset.id === page.id)?.pageIndex).toBe(page.pageIndex! + 1);
    }
    await assertReadable('comic', 3);
    await add(4);
    await assertReadable('comic', 4);
  });

  it('retains exact pages and originals across reorder, backup replace/copy and later additions', async () => {
    await add(2);
    const originalPageIds = (await getActiveComicAssetMetadata('comic'))
      .filter((asset) => asset.kind === 'document_page')
      .map((asset) => asset.id);
    await add(1);
    await add(3);
    await assertReadable('comic', 3);
    const metadata = await getActiveComicAssetMetadata('comic');
    expect(metadata.filter((asset) => asset.kind === 'source_part')).toHaveLength(3);
    expect(metadata.find((asset) => asset.id === originalPageIds[0])?.pageIndex).toBe(1);
    const backup = new IndexedDbBackupRepository();
    const exported = await backup.exportBackup();
    await backup.restoreBackup(exported.blob, { defaultConflictResolution: 'replace' });
    await assertReadable('comic', 3);
    await backup.restoreBackup(exported.blob, { defaultConflictResolution: 'copy' });
    const copied = (await reader.listNovels()).find((book) => book.id !== 'comic')!;
    await assertReadable(copied.id, 3);
    const flat = await exportPortableBookSource(assets, copied.id);
    expect(flat?.metadata.contentType).toBe('application/vnd.comicbook+zip');
    expect(await readComicSourceManifest(flat!.blob)).toBeUndefined();
    await add(4, copied.id);
    await assertReadable(copied.id, 4);
    await assertReadable('comic', 3);
  });

  it('uploads only new immutable parts and restores a usable source on an empty second device', async () => {
    await add(1);
    await add(2);
    const objects = new Map<string, Blob>();
    const provider: CloudVaultContentProvider = {
      kind: 'directory',
      label: 'fixture',
      read: async () => undefined,
      write: async () => ({ revision: 'fixture' }),
      getObject: async (key) => (objects.has(key) ? { blob: objects.get(key)! } : undefined),
      putObject: vi.fn(async (key, blob) => {
        const created = !objects.has(key);
        if (created) objects.set(key, blob);
        return { created };
      }),
    };
    const importer: ImportService = {
      supportsExpectedNormalizedTextHash: true,
      importFile: (input) => ({ jobId: 'restore', promise: importInput(input), cancel: () => undefined }),
    };
    const service = new CloudVaultContentTransferService(reader, assets, importer);
    const artifacts = new IndexedDbCloudVaultArtifactRepository(reader);
    const capture = () =>
      artifacts.capture({
        deviceId: 'fixture-device',
        scope: { ...DEFAULT_CLOUD_VAULT_SCOPE, aiTtsArtifacts: false, sourceFiles: true },
      });
    const local = await capture();
    const first = await service.uploadLocalContent(local, provider, local);
    expect(first.report.contentFailures).toEqual([]);
    expect(first.snapshot.books[0]?.sourcePartObjects).toHaveLength(2);
    await add(3);
    const partReads = vi.spyOn(assets, 'getComicSourcePart');
    const nextLocal = await capture();
    const next = await service.uploadLocalContent(
      mergeCloudVaultSnapshots(nextLocal, first.snapshot),
      provider,
      nextLocal,
      first.snapshot,
    );
    expect(next.report.contentFailures).toEqual([]);
    expect(partReads).toHaveBeenCalledTimes(1);
    expect(next.snapshot.books[0]?.sourcePartObjects).toHaveLength(3);
    partReads.mockClear();
    const againLocal = await capture();
    const again = await service.uploadLocalContent(
      mergeCloudVaultSnapshots(againLocal, next.snapshot),
      provider,
      againLocal,
      next.snapshot,
    );
    expect(again.report.uploadedContentBytes).toBe(0);
    expect(partReads).not.toHaveBeenCalled();
    partReads.mockRestore();
    await resetReaderDbForTests();
    const restored = await service.restoreMissingContent(next.snapshot, provider);
    expect(restored.contentFailures).toEqual([]);
    expect(restored.restoredSourceFiles).toBe(1);
    const [novel] = await reader.listNovels();
    expect(novel!.normalizedTextHash).toBe(next.snapshot.books[0]!.identity.normalizedTextHash);
    await assertReadable(novel!.id, 3);
    const root = await assets.exportSource(novel!.id);
    expect(root?.metadata.contentType).toBe('application/vnd.moya.comic-manifest+zip');
    expect(await service.restoreMissingContent(next.snapshot, provider)).toMatchObject({
      restoredSourceFiles: 0,
      downloadedContentBytes: 0,
      contentFailures: [],
    });
  });
});
