import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupStagedBookAsset,
  exportBookSource,
  getActiveBookCover,
  getActiveBookCoverMetadata,
  reconstructCanonicalBookSource,
  removeBookCover,
  reselectOriginalBookSource,
  saveBookCover,
  saveGeneratedBookCover,
  stageOriginalSourceAsset,
} from './book-asset-store';
import { BOOK_ASSET_STORES } from './book-asset-schema';
import { openReaderDb, resetReaderDbForTests } from './reader-database';
import { integrityHash } from '../domain/id-hash-contract';
import { OriginalSourceMismatchError } from '../repositories/book-asset-repository';
import { parseNovelTextForSample } from '../domain/parser';
import { saveImportedNovel } from './db';
import type { SyncTombstone } from './sync-event-store';

async function blobCount(): Promise<number> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ASSET_STORES.blobs, 'readonly');
  return new Promise((resolve, reject) => {
    const request = tx.objectStore(BOOK_ASSET_STORES.blobs).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function lifecycleTombstones(): Promise<SyncTombstone[]> {
  const db = await openReaderDb();
  const tx = db.transaction('sync_tombstones', 'readonly');
  return new Promise((resolve, reject) => {
    const request = tx.objectStore('sync_tombstones').getAll();
    request.onsuccess = () => resolve(request.result as SyncTombstone[]);
    request.onerror = () => reject(request.error);
  });
}

function generatedInput(fingerprint: string, byte: number) {
  return {
    blob: new Blob([new Uint8Array([byte])], { type: 'image/jpeg' }),
    fileName: 'generated-pdf-cover.jpg',
    contentType: 'image/jpeg' as const,
    contentHash: `sha256:${byte.toString(16).padStart(2, '0').repeat(32)}`,
    pixelWidth: 320,
    pixelHeight: 480,
    fit: 'contain' as const,
    positionX: 50,
    positionY: 50,
    derivationFingerprint: fingerprint,
  };
}

describe('book asset store', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('keeps a shared physical blob until the final staged reference is removed', async () => {
    const common = {
      contentHash: 'sha256:shared-source',
      fileName: 'shared.txt',
      contentType: 'text/plain',
      encoding: 'utf-8' as const,
      blob: new Blob(['same source'], { type: 'text/plain' }),
    };
    const first = await stageOriginalSourceAsset({
      ...common,
      bookId: 'book-a',
      contentRevisionId: 'revision-a',
    });
    const second = await stageOriginalSourceAsset({
      ...common,
      bookId: 'book-b',
      contentRevisionId: 'revision-b',
    });

    expect(await blobCount()).toBe(1);
    await cleanupStagedBookAsset(first.id);
    expect(await blobCount()).toBe(1);
    await cleanupStagedBookAsset(second.id);
    expect(await blobCount()).toBe(0);
  });

  it('attaches a reselected byte-identical source and rejects another file', async () => {
    const source = new Blob(['exact original'], { type: 'text/plain' });
    const bytes = await source.arrayBuffer();
    const db = await openReaderDb();
    const tx = db.transaction('novels', 'readwrite');
    tx.objectStore('novels').put({
      id: 'book-legacy',
      activeContentRevisionId: 'revision-legacy',
      title: 'Legacy',
      sourceFileName: 'legacy.txt',
      sourceEncoding: 'utf-8',
      rawText: '',
      normalizedText: '',
      rawTextHash: integrityHash(bytes),
      normalizedTextHash: integrityHash('exact original'),
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      totalChapters: 1,
      totalCharacters: 14,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const attached = await reselectOriginalBookSource('book-legacy', {
      fileName: 'selected.txt',
      contentType: 'text/plain',
      blob: source,
      expectedContentRevisionId: 'revision-legacy',
    });
    expect(attached).toMatchObject({ provenance: 'original', status: 'active', contentHash: integrityHash(bytes) });
    await expect(
      reselectOriginalBookSource('book-legacy', {
        fileName: 'selected.txt',
        contentType: 'text/plain',
        blob: source,
        expectedContentRevisionId: 'revision-stale',
      }),
    ).rejects.toThrow('content revision changed');
    await expect(exportBookSource('book-legacy', { activeContentRevisionId: 'revision-stale' })).rejects.toThrow(
      'content revision changed',
    );
    await expect(
      reselectOriginalBookSource('book-legacy', {
        fileName: 'wrong.txt',
        contentType: 'text/plain',
        blob: new Blob(['different']),
      }),
    ).rejects.toBeInstanceOf(OriginalSourceMismatchError);
  });

  it('creates an explicitly marked canonical reconstruction from stored paragraph pages', async () => {
    const parsed = await parseNovelTextForSample('재구성 책', '1화 시작\n\n첫 문단입니다.\n\n둘째 문단입니다.');
    await saveImportedNovel(parsed);

    const metadata = await reconstructCanonicalBookSource(parsed.novel.id);
    const exported = await exportBookSource(parsed.novel.id);

    expect(metadata).toMatchObject({ provenance: 'canonical_reconstruction', encoding: 'utf-8', status: 'active' });
    expect(exported?.metadata.id).toBe(metadata.id);
    expect(await exported?.blob.text()).toContain('첫 문단입니다.');
  });

  it('replaces and removes a content-addressed cover while updating book metadata', async () => {
    const parsed = await parseNovelTextForSample('표지 책', '1화 시작\n\n본문입니다.');
    await saveImportedNovel(parsed);
    const blob = new Blob(['normalized-cover'], { type: 'image/webp' });
    const contentHash = integrityHash(await blob.arrayBuffer());
    const metadata = await saveBookCover(parsed.novel.id, {
      blob,
      fileName: 'cover.webp',
      contentType: 'image/webp',
      contentHash,
      pixelWidth: 800,
      pixelHeight: 1200,
      fit: 'crop',
      positionX: 40,
      positionY: 60,
      expectedMetadataRevision: 0,
      expectedContentRevisionId: parsed.novel.activeContentRevisionId,
    });
    expect(metadata).toMatchObject({ kind: 'cover', contentHash, pixelWidth: 800, pixelHeight: 1200 });
    expect(await getActiveBookCoverMetadata(parsed.novel.id)).toMatchObject({ id: metadata.id, contentHash });
    expect(await getActiveBookCover(parsed.novel.id)).toMatchObject({ metadata: { id: metadata.id }, blob });

    await removeBookCover(parsed.novel.id, {
      metadataRevision: 1,
      activeContentRevisionId: parsed.novel.activeContentRevisionId,
    });
    expect(await getActiveBookCoverMetadata(parsed.novel.id)).toBeUndefined();
    expect(await getActiveBookCover(parsed.novel.id)).toBeUndefined();
    expect(await lifecycleTombstones()).toContainEqual(
      expect.objectContaining({
        id: `cover:${parsed.novel.id}`,
        entityType: 'cover',
        vaultBookId: parsed.novel.id,
        bookHash: parsed.novel.normalizedTextHash,
      }),
    );

    await saveBookCover(parsed.novel.id, {
      blob,
      fileName: 'cover.webp',
      contentType: 'image/webp',
      contentHash,
      pixelWidth: 800,
      pixelHeight: 1200,
      fit: 'crop',
      positionX: 40,
      positionY: 60,
      expectedMetadataRevision: 2,
      expectedContentRevisionId: parsed.novel.activeContentRevisionId,
    });
    expect((await lifecycleTombstones()).find((item) => item.id === `cover:${parsed.novel.id}`)).toBeUndefined();
  });

  it('does not attach an older-incarnation cover mutation to the active content revision', async () => {
    const parsed = await parseNovelTextForSample('Revision fenced cover', '1화\n\n본문');
    await saveImportedNovel(parsed);
    const blob = new Blob(['cover'], { type: 'image/webp' });
    const input = {
      blob,
      fileName: 'cover.webp',
      contentType: 'image/webp' as const,
      contentHash: integrityHash(await blob.arrayBuffer()),
      pixelWidth: 800,
      pixelHeight: 1200,
      fit: 'crop' as const,
      positionX: 50,
      positionY: 50,
      expectedMetadataRevision: 0,
      expectedContentRevisionId: 'stale-revision',
    };

    await expect(saveBookCover(parsed.novel.id, input)).rejects.toThrow('content revision changed');
    await expect(
      saveGeneratedBookCover(parsed.novel.id, {
        ...generatedInput('stale-generated', 0x55),
        expectedContentRevisionId: 'stale-revision',
      }),
    ).rejects.toThrow('content revision changed');
    await expect(
      removeBookCover(parsed.novel.id, {
        metadataRevision: 0,
        activeContentRevisionId: 'stale-revision',
      }),
    ).rejects.toThrow('content revision changed');
    expect(await getActiveBookCover(parsed.novel.id)).toBeUndefined();
  });

  it('replaces stale generated previews but never overwrites a user cover', async () => {
    const parsed = await parseNovelTextForSample('자동 표지 책', '1화 시작\n\n본문입니다.');
    await saveImportedNovel(parsed);

    const first = await saveGeneratedBookCover(parsed.novel.id, generatedInput('source-v1', 0x11));
    expect(first).toMatchObject({ provenance: 'generated_preview', kind: 'cover' });
    const second = await saveGeneratedBookCover(parsed.novel.id, generatedInput('source-v2', 0x22));
    expect(second?.id).not.toBe(first?.id);
    expect(await getActiveBookCover(parsed.novel.id)).toMatchObject({
      metadata: { id: second?.id, provenance: 'generated_preview' },
    });

    const user = await saveBookCover(parsed.novel.id, {
      blob: new Blob([new Uint8Array([0x33])], { type: 'image/png' }),
      fileName: 'user.png',
      contentType: 'image/png',
      contentHash: `sha256:${'33'.repeat(32)}`,
      pixelWidth: 300,
      pixelHeight: 450,
      fit: 'crop',
      positionX: 42,
      positionY: 58,
      expectedMetadataRevision: 0,
    });
    await expect(saveGeneratedBookCover(parsed.novel.id, generatedInput('source-v3', 0x44))).resolves.toBeUndefined();
    expect(await getActiveBookCover(parsed.novel.id)).toMatchObject({
      metadata: { id: user.id, provenance: 'user_supplied' },
    });
  });
});
