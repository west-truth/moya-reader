import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeEpubImport, type EpubDocument } from '@noveldesk/epub-core';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { RepositoryBackedReaderDocumentRepository } from '../repositories/reader-document-repository';
import { IndexedDbBackupRepository } from '../storage/indexeddb-backup-repository';
import { resetReaderDbForTests } from '../storage/db';
import { saveParsedNovelImport } from '../storage/db';

afterEach(() => resetReaderDbForTests());

describe('local EPUB import persistence', () => {
  it('activates source, semantic blocks, document manifest and embedded resource together', async () => {
    const sourceBytes = new TextEncoder().encode('epub-source');
    const resourceBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const document: EpubDocument = {
      title: '로컬 EPUB',
      author: '작성자',
      language: 'ko',
      coverHref: 'OEBPS/cover.png',
      sections: [
        {
          href: 'OEBPS/chapter.xhtml',
          title: '첫 장',
          blocks: [
            { kind: 'heading', plainText: '첫 장', sourceLocator: 'epubcfi(/6/2!/4/2)' },
            {
              kind: 'image',
              plainText: '표지',
              resourceHref: 'OEBPS/cover.png',
              sourceLocator: 'epubcfi(/6/2!/4/4)',
            },
          ],
        },
      ],
      resources: [
        {
          href: 'OEBPS/cover.png',
          mediaType: 'image/png',
          contentHash: 'sha256:72f0f04a4f840b1a6a0f4db3d16475d7295a6d369a1ad75c1e4023f23dbf4f9b',
          bytes: resourceBytes,
        },
      ],
    };
    const parsed = materializeEpubImport(document, {
      fileName: 'local.epub',
      sourceBytes,
      now: '2026-07-13T00:00:00.000Z',
    });
    await saveParsedNovelImport(parsed, {
      sourceAsset: {
        blob: new Blob([sourceBytes], { type: 'application/epub+zip' }),
        fileName: 'local.epub',
        contentType: 'application/epub+zip',
        contentHash: parsed.novel.rawTextHash,
      },
    });

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const documents = new RepositoryBackedReaderDocumentRepository(reader);
    const stored = await reader.getNovel(parsed.novel.id);
    const manifest = await documents.getDocumentManifest(parsed.novel.id);
    const page = await documents.getBlockPage(parsed.chapters[0].id, 0);
    const imageAssetId = page?.blocks.find((block) => block.kind === 'image')?.assetId;

    expect(stored).toMatchObject({ format: 'epub', title: '로컬 EPUB' });
    expect(stored?.coverAssetId).not.toBe(imageAssetId);
    expect(manifest).toMatchObject({ format: 'epub', sections: [{ title: '첫 장', blockCount: 2 }] });
    expect(page?.blocks.map((block) => block.kind)).toEqual(['heading', 'image']);
    expect(await assets.exportSource(parsed.novel.id)).toMatchObject({
      metadata: { contentType: 'application/epub+zip' },
    });
    expect(await assets.getEmbeddedResource(parsed.novel.id, imageAssetId!)).toMatchObject({
      metadata: { kind: 'epub_resource', provenance: 'epub_embedded' },
    });

    const userCover = await assets.saveCover(parsed.novel.id, {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      fileName: 'custom-cover.png',
      contentType: 'image/png',
      contentHash: `sha256:${'11'.repeat(32)}`,
      pixelWidth: 3,
      pixelHeight: 4,
      fit: 'crop',
      positionX: 50,
      positionY: 50,
    });
    const reimport = materializeEpubImport(
      {
        ...document,
        sections: [
          {
            ...document.sections[0],
            blocks: [
              ...document.sections[0].blocks,
              { kind: 'paragraph', plainText: '추가 본문', sourceLocator: 'epubcfi(/6/2!/4/6)' },
            ],
          },
        ],
      },
      {
        fileName: 'local.epub',
        sourceBytes: new TextEncoder().encode('epub-source-v2'),
        clientBookId: parsed.novel.id,
        now: '2026-07-13T01:00:00.000Z',
      },
    );
    await saveParsedNovelImport(reimport);

    expect(await reader.getNovel(parsed.novel.id)).toMatchObject({ coverAssetId: userCover.id });
    expect(await assets.getActiveCover(parsed.novel.id)).toMatchObject({
      metadata: { id: userCover.id, provenance: 'user_supplied' },
    });
    expect(await assets.getEmbeddedResource(parsed.novel.id, imageAssetId!)).toMatchObject({
      metadata: { kind: 'epub_resource', status: 'active' },
    });

    const backup = new IndexedDbBackupRepository();
    const archive = await backup.exportBackup();
    await resetReaderDbForTests();
    await backup.restoreBackup(archive.blob, { defaultConflictResolution: 'replace' });
    const restoredAsset = await new IndexedDbBookAssetRepository().getEmbeddedResource(parsed.novel.id, imageAssetId!);
    expect(restoredAsset?.blob.size).toBe(resourceBytes.byteLength);
  });
});
