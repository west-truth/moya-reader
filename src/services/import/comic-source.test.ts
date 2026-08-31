import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { materializeStreamingImageArchiveImport, openImageArchiveStream } from '@noveldesk/fixed-document-core';
import { buildSeriesImageArchive } from './series-image-archive';
import {
  assertComicSourceManifest,
  comicPageAssetId,
  flattenComicSource,
  materializeComicSource,
  packageComicSource,
  planComicSourceAppend,
  readComicSourceManifest,
  unpackComicSource,
  type ComicSourceManifest,
} from '@noveldesk/fixed-document-core/comic-source';

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);
const signal = () => new AbortController().signal;
const hash = async (blob: Blob) => integrityHash(new Uint8Array(await blob.arrayBuffer()));

async function archive(number: number, revision = 'v1') {
  const writer = new ZipWriter(new BlobWriter());
  await writer.add('001.png', new Uint8ArrayReader(PNG));
  return buildSeriesImageArchive({
    collection: { remoteId: 'work', title: '작품' },
    targetBookId: 'book',
    chapters: [
      {
        remoteId: `chapter:${number}`,
        release: { title: `${number}화`, chapterNumber: number },
        sourceContentHash: `${number}:${revision}`,
        file: await writer.close(),
      },
    ],
    signal: signal(),
  });
}

async function append(existing: Blob, delta: Blob) {
  return planComicSourceAppend({
    bookId: 'book',
    existingSource: existing,
    existingSourceHash: await hash(existing),
    delta,
    deltaHash: await hash(delta),
    signal: signal(),
  });
}

function largeManifest(chapters = 100, pagesPerChapter = 60): ComicSourceManifest {
  const sourceParts = Array.from({ length: chapters }, (_, index) => ({
    contentHash: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
    byteLength: 20 * 1024 * 1024,
    fileName: `${index + 1}.cbz`,
    contentType: 'application/vnd.comicbook+zip',
  }));
  const sourcePages = sourceParts.flatMap((part) =>
    Array.from({ length: pagesPerChapter }, (_, index) => ({
      partHash: part.contentHash,
      entryName: `${index + 1}.png`,
      sourcePageIndex: index,
      contentType: 'image/png',
    })),
  );
  return {
    schemaVersion: 1,
    storageVersion: 1,
    collection: { remoteId: 'work', title: '작품' },
    sourceParts,
    sourcePages,
    chapters: sourceParts.map((part, index) => ({
      remoteId: `chapter:${index + 1}`,
      title: `${index + 1}화`,
      chapterNumber: index + 1,
      sourceContentHash: part.contentHash,
      pageCount: pagesPerChapter,
      entryNames: sourcePages
        .slice(index * pagesPerChapter, (index + 1) * pagesPerChapter)
        .map((page) => `${page.partHash.slice(7)}/${page.entryName}`),
    })),
  };
}

async function manifestZip(manifest: unknown) {
  const writer = new ZipWriter(new BlobWriter(), { level: 0 });
  await writer.add('moya-series.json', new TextReader(JSON.stringify(manifest)));
  return writer.close();
}

describe('comic source manifests', () => {
  it('appends to 100 chapters / 6,000 pages / 2GiB of references without reading any old part', async () => {
    const manifest = largeManifest();
    expect(() => assertComicSourceManifest(manifest)).not.toThrow();
    const plan = await append(await manifestZip(manifest), await archive(101));
    expect(plan.manifest.chapters).toHaveLength(101);
    expect(plan.manifest.sourcePages).toHaveLength(6001);
    expect(plan.newParts.size).toBe(1);
    expect(plan.retainedPartIds).toHaveLength(100);
    expect(await readComicSourceManifest(plan.source)).toEqual(plan.manifest);
    const parsed = await materializeComicSource({
      manifest: plan.manifest,
      sourceContentHash: plan.sourceContentHash,
      fileName: 'work.cbz',
      bookId: 'book',
      partsToStore: plan.newParts,
      pagePartsToRead: plan.newParts,
    });
    let writtenPages = 0;
    for await (const asset of parsed.consumeEmbeddedAssets!()) if (asset.kind === 'document_page') writtenPages++;
    expect(writtenPages).toBe(1);
  });

  it('bounds work indexes independently while retaining single-part and page-index safety limits', () => {
    expect(() => assertComicSourceManifest(largeManifest(2000, 10))).not.toThrow();
    expect(() => assertComicSourceManifest(largeManifest(2000, 11))).toThrow('20,000페이지');
    expect(() => assertComicSourceManifest(largeManifest(2001, 1))).toThrow('2,000개');
    const manifest = largeManifest(1, 1);
    expect(() =>
      assertComicSourceManifest({
        ...manifest,
        sourceParts: [{ ...manifest.sourceParts[0], byteLength: 1024 ** 3 + 1 }],
      }),
    ).toThrow('원본 참조');
    expect(() =>
      assertComicSourceManifest({ ...manifest, sourcePages: [{ ...manifest.sourcePages[0], sourcePageIndex: 5000 }] }),
    ).toThrow('페이지 참조');
  });

  it('retains the eager portable-package guard before fetching a multi-GiB work', async () => {
    const source = await manifestZip(largeManifest());
    let reads = 0;
    await expect(
      packageComicSource(source, async () => {
        reads++;
        return new Blob();
      }),
    ).rejects.toThrow('1GiB');
    expect(reads).toBe(0);
  });

  it('allows a reference manifest over 4MiB but rejects over 8MiB before loading parts', async () => {
    const manifest = largeManifest(1, 1);
    const large = { ...manifest, collection: { ...manifest.collection, description: 'x'.repeat(4 * 1024 * 1024) } };
    expect(await readComicSourceManifest(await manifestZip(large))).toEqual(large);
    await expect(readComicSourceManifest(await manifestZip({ ...large, storageVersion: undefined }))).rejects.toThrow(
      '크기',
    );
    await expect(
      readComicSourceManifest(
        await manifestZip({
          ...manifest,
          collection: { ...manifest.collection, description: 'x'.repeat(8 * 1024 * 1024) },
        }),
      ),
    ).rejects.toThrow('크기');
  });
  it('stores a multi-chapter upload as independent chapter originals', async () => {
    const delta = await buildSeriesImageArchive({
      collection: { remoteId: 'work', title: '작품' },
      targetBookId: 'book',
      chapters: await Promise.all(
        [2, 3].map(async (number) => ({
          remoteId: `chapter:${number}`,
          release: { title: `${number}화`, chapterNumber: number },
          sourceContentHash: `${number}:v1`,
          file: await archive(number),
        })),
      ),
      signal: signal(),
    });
    const plan = await append(await archive(1), delta);
    expect(plan.manifest.sourceParts).toHaveLength(3);
    expect(new Set(plan.manifest.sourcePages.map((page) => page.partHash))).toHaveLength(3);
    const parts = plan.manifest.sourceParts;
    const updated = await append(plan.source, await archive(2, 'v2'));
    expect(
      updated.manifest.sourceParts.filter((part) => parts.some((old) => old.contentHash === part.contentHash)),
    ).toHaveLength(2);
    expect(updated.newParts.size).toBe(1);
  });
  it('adopts an old CBZ without changing its page/chapter identity and never needs its bytes on later append', async () => {
    const original = await archive(2);
    const old = materializeStreamingImageArchiveImport({
      fileName: 'work.cbz',
      clientBookId: 'book',
      sourceContentHash: await hash(original),
      document: await openImageArchiveStream(original),
    });
    const oldAssets = [];
    for await (const asset of old.consumeEmbeddedAssets!())
      if (asset.kind === 'document_page') oldAssets.push(asset.id);
    const first = await append(original, await archive(1));
    expect(first.retainedPageIds).toEqual(oldAssets);
    expect(first.manifest.chapters.map((chapter) => chapter.remoteId)).toEqual(['chapter:1', 'chapter:2']);
    const second = await append(first.source, await archive(3));
    expect(second.newParts.size).toBe(1);
    expect(second.retainedPartIds).toHaveLength(2);
    expect(second.manifest.sourceParts).toHaveLength(3);
    const parsed = await materializeComicSource({
      manifest: second.manifest,
      sourceContentHash: second.sourceContentHash,
      fileName: 'work.cbz',
      bookId: 'book',
      partsToStore: second.newParts,
      pagePartsToRead: second.newParts,
    });
    expect(parsed.chapters[1]!.id).toBe(old.chapters[0]!.id);
    const emitted = [];
    for await (const asset of parsed.consumeEmbeddedAssets!()) emitted.push(asset);
    expect(emitted.filter((asset) => asset.kind === 'document_page')).toHaveLength(1);
    expect(emitted.filter((asset) => asset.kind === 'source_part')).toHaveLength(1);
    expect(emitted.some((asset) => asset.kind === 'cover')).toBe(false);
  });

  it('keeps duplicates byte-identical and releases an unreferenced replaced part', async () => {
    const original = await archive(1);
    const delta = await archive(2);
    const first = await append(original, delta);
    const duplicate = await append(first.source, delta);
    expect(duplicate.source).toBe(first.source);
    expect(duplicate.changedSectionIds).toEqual([]);
    const replacement = await append(first.source, await archive(2, 'v2'));
    expect(replacement.replacedSectionIds).toEqual(['chapter:2']);
    expect(replacement.manifest.sourceParts).toHaveLength(2);
    expect(
      replacement.manifest.sourceParts.some((part) => part.contentHash === first.manifest.sourceParts[1]!.contentHash),
    ).toBe(false);
  });

  it('round-trips exact source bytes via a portable package, and exports ordered ordinary CBZ pages', async () => {
    const first = await append(await archive(2), await archive(1));
    const second = await append(first.source, await archive(3));
    const parts = new Map([...first.newParts, ...second.newParts]);
    const packed = await packageComicSource(second.source, async (part) => parts.get(part.contentHash)!);
    const restored = await unpackComicSource(packed);
    expect(await hash(restored!.source)).toBe(second.sourceContentHash);
    expect(restored!.manifest).toEqual(second.manifest);
    expect(restored!.parts.size).toBe(3);
    const flat = await flattenComicSource(second.source, async (part) => parts.get(part.contentHash)!);
    expect(await readComicSourceManifest(flat)).toBeUndefined();
    const document = await openImageArchiveStream(flat);
    expect(document.moyaSeries?.chapters.flatMap((chapter) => chapter.entryNames)).toEqual(
      document.pages.map((page) => page.fileName),
    );
    expect(document.pages).toHaveLength(3);
    const parsed = await materializeComicSource({
      manifest: restored!.manifest,
      sourceContentHash: second.sourceContentHash,
      fileName: 'work.cbz',
      bookId: 'other-book',
      partsToStore: restored!.parts,
      pagePartsToRead: restored!.parts,
    });
    const emitted = [];
    for await (const asset of parsed.consumeEmbeddedAssets!()) emitted.push(asset);
    expect(
      emitted
        .filter((asset) => asset.kind === 'document_page')
        .map((asset) => asset.id)
        .sort(),
    ).toEqual(restored!.manifest.sourcePages.map((page) => comicPageAssetId('other-book', page)).sort());
  });

  it('rejects dangling references, path traversal, unexpected versions and corrupt part bytes', async () => {
    const plan = await append(await archive(1), await archive(2));
    expect(() => assertComicSourceManifest({ ...plan.manifest, storageVersion: 2 })).toThrow();
    expect(() => assertComicSourceManifest({ ...plan.manifest, sourcePages: [] })).toThrow();
    expect(() =>
      assertComicSourceManifest({
        ...plan.manifest,
        sourcePages: [{ ...plan.manifest.sourcePages[0], entryName: '../a.png' }],
      }),
    ).toThrow();
    await expect(packageComicSource(plan.source, async () => new Blob(['bad']))).rejects.toThrow('식별자');
  });
});
