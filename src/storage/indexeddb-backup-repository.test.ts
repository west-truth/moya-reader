import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../domain/hash';
import { runBrowserImportPipeline } from '../services/import/browser-import-pipeline';
import {
  getBookmarks,
  getChapters,
  getNovels,
  getParagraphs,
  getSettings,
  resetReaderDbForTests,
  saveBookmark,
  saveReadingPosition,
  saveSettings,
} from './db';
import { exportBookSource } from './book-asset-store';
import { IndexedDbBackupRepository } from './indexeddb-backup-repository';
import { createEmptyVoiceCastingWorkspace } from '../providers/voice-casting';
import { getVoiceCastingWorkspace, saveVoiceCastingWorkspace } from './voice-casting-store';
import { getListeningPosition, saveListeningPosition } from './listening-position-store';
import { IndexedDbDocumentTextRepository } from './document-text-store';

const source = `제1화 시작

첫 번째 문단입니다.

두 번째 문단입니다.`;

async function importFixture() {
  const bytes = new TextEncoder().encode(source);
  return runBrowserImportPipeline({
    jobId: 'backup-import',
    fileName: 'backup-source.txt',
    buffer: bytes.buffer as ArrayBuffer,
    sourceBlob: new Blob([bytes], { type: 'text/plain' }),
    totalBytes: bytes.byteLength,
    encoding: 'utf-8',
    chapterSplitMode: 'mixed',
    onProgress: () => undefined,
    yieldControl: async () => undefined,
  });
}

async function rewriteManifest(archive: Blob, mutate: (manifest: Record<string, unknown>) => void): Promise<Blob> {
  const { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } = await import('@zip.js/zip.js');
  const source = new ZipReader(new BlobReader(archive));
  const output = new BlobWriter('application/zip');
  const target = new ZipWriter(output);
  try {
    for (const entry of await source.getEntries()) {
      if (entry.directory) continue;
      if (entry.filename === 'manifest.json') {
        const manifest = JSON.parse(await entry.getData(new TextWriter())) as Record<string, unknown>;
        mutate(manifest);
        await target.add(entry.filename, new TextReader(JSON.stringify(manifest)));
      } else {
        await target.add(entry.filename, new BlobReader(await entry.getData(new BlobWriter())));
      }
    }
    await target.close();
    return output.getData();
  } finally {
    await source.close();
  }
}

describe('IndexedDbBackupRepository', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('round-trips source, normalized content, annotations, position and settings', async () => {
    const imported = await importFixture();
    const [novel] = await getNovels();
    const [chapter] = await getChapters(novel.id);
    const [paragraph] = await getParagraphs(chapter.id);
    await saveBookmark({
      id: 'bookmark_backup',
      novelId: novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      label: '백업 위치',
      progress: 0.5,
      scrollTop: 120,
      createdAt: '2026-07-13T00:00:00.000Z',
    });
    await saveReadingPosition({
      novelId: novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index,
      chapterProgress: 0.5,
      scrollTop: 120,
    });
    await saveSettings({ ...(await getSettings()), theme: 'sepia', fontSize: 21 });
    await saveListeningPosition({
      bookId: novel.id,
      chapterId: chapter.id,
      contentRevisionId: novel.activeContentRevisionId!,
      queueItemFingerprint: 'queue_backup',
      settingsFingerprint: 'settings_backup',
      anchor: {
        kind: 'reflowable_text',
        paragraphId: paragraph.id,
        startOffset: 2,
        endOffset: 6,
        reader: {
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId!,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex: paragraph.index,
          offset: 2,
        },
      },
    });
    const voiceCasting = createEmptyVoiceCastingWorkspace({
      bookId: novel.id,
      contentRevisionId: novel.activeContentRevisionId!,
      storageRevision: 1,
    });
    await saveVoiceCastingWorkspace({ workspace: voiceCasting, expectedStorageRevision: 0 });
    const textRepository = new IndexedDbDocumentTextRepository();
    await textRepository.saveOrderOverride({
      id: 'reading-order-backup',
      bookId: novel.id,
      pageIndex: 3,
      pageHash: 'page-hash',
      sourceRevisionId: 'revision-backup',
      orderedBlockFingerprints: ['second', 'first'],
      excludedBlockFingerprints: ['footer'],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    const repository = new IndexedDbBackupRepository();
    const exported = await repository.exportBackup();
    expect(exported.manifest.books).toEqual([
      expect.objectContaining({ id: imported.novel.id, title: imported.novel.title }),
    ]);
    expect(exported.manifest.entries.some((entry) => entry.path.startsWith('assets/'))).toBe(true);
    expect(exported.manifest.entries.some((entry) => entry.path === 'stores/accepted_speaker_provenance.json')).toBe(
      true,
    );

    await resetReaderDbForTests();
    const inspection = await repository.inspectBackup(exported.blob);
    expect(inspection.conflicts).toEqual([]);
    const restored = await repository.restoreBackup(exported.blob, { defaultConflictResolution: 'replace' });

    expect(restored).toMatchObject({ restoredBooks: 1, skippedBooks: 0, copiedBooks: 0 });
    const [restoredNovel] = await getNovels();
    expect(restoredNovel).toMatchObject({ id: novel.id, sourceAssetId: expect.any(String) });
    expect(await getBookmarks(novel.id)).toEqual([expect.objectContaining({ id: 'bookmark_backup' })]);
    expect(await getSettings()).toMatchObject({ theme: 'sepia', fontSize: 21 });
    expect(await getListeningPosition(novel.id)).toMatchObject({
      queueItemFingerprint: 'queue_backup',
      anchor: { kind: 'reflowable_text', startOffset: 2, endOffset: 6 },
    });
    expect(await getVoiceCastingWorkspace(novel.id)).toEqual(voiceCasting);
    expect(await textRepository.getOrderOverride(novel.id, 3)).toMatchObject({
      id: 'reading-order-backup',
      orderedBlockFingerprints: ['second', 'first'],
      excludedBlockFingerprints: ['footer'],
    });
    const restoredSource = await exportBookSource(novel.id);
    expect(restoredSource?.metadata.contentHash).toBe(novel.sourceContentHash);
    expect(`sha256:${await sha256((await restoredSource!.blob.arrayBuffer()) as ArrayBuffer)}`).toBe(
      novel.sourceContentHash,
    );
  });

  it('supports skip, replace and copy conflict policies', async () => {
    await importFixture();
    const [original] = await getNovels();
    await saveVoiceCastingWorkspace({
      workspace: createEmptyVoiceCastingWorkspace({
        bookId: original.id,
        contentRevisionId: original.activeContentRevisionId!,
        storageRevision: 1,
      }),
      expectedStorageRevision: 0,
    });
    const repository = new IndexedDbBackupRepository();
    const exported = await repository.exportBackup();

    expect((await repository.inspectBackup(exported.blob)).conflicts).toHaveLength(1);
    await expect(repository.restoreBackup(exported.blob, { defaultConflictResolution: 'skip' })).resolves.toMatchObject(
      { restoredBooks: 0, skippedBooks: 1 },
    );
    expect(await getNovels()).toHaveLength(1);

    const copied = await repository.restoreBackup(exported.blob, { defaultConflictResolution: 'copy' });
    expect(copied).toMatchObject({ restoredBooks: 1, copiedBooks: 1 });
    const novels = await getNovels();
    expect(novels).toHaveLength(2);
    const copiedNovel = novels.find((novel) => novel.id !== original.id)!;
    expect(copiedNovel.title).toContain('복사본');
    expect(await exportBookSource(copiedNovel.id)).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ bookId: copiedNovel.id }) }),
    );
    expect(await getVoiceCastingWorkspace(copiedNovel.id)).toBeUndefined();

    await expect(
      repository.restoreBackup(exported.blob, { defaultConflictResolution: 'replace' }),
    ).resolves.toMatchObject({ restoredBooks: 1, skippedBooks: 0 });
    expect(await getNovels()).toHaveLength(2);
  });

  it('rejects an archive whose manifest hash does not match an entry', async () => {
    await importFixture();
    const repository = new IndexedDbBackupRepository();
    const exported = await repository.exportBackup();
    const tampered = await rewriteManifest(exported.blob, (manifest) => {
      const entries = manifest.entries as Array<Record<string, unknown>>;
      entries[0].contentHash = 'sha256:tampered';
    });

    await expect(repository.inspectBackup(tampered)).rejects.toThrow('integrity check failed');
  });
});
