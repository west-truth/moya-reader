import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { ParsedNovelImportAsset } from '@noveldesk/contracts';
import {
  inspectPdf,
  detectImageArchiveFormat,
  materializeImageArchiveImport,
  materializePdfImport,
  materializeStreamingImageArchiveImport,
  openImageArchiveStream,
  parseImageArchive,
  parseComicInfoXml,
} from '@noveldesk/fixed-document-core';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { runBrowserFixedDocumentImportPipeline } from '../services/import/browser-import-pipeline';
import type { ImportProgress } from '../services/import/import-service';
import { openReaderDb, resetReaderDbForTests, saveParsedNovelImport } from '../storage/db';
import { integrityHash } from '../domain/id-hash-contract';

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

const ENCRYPTED_7Z_1X1 = Uint8Array.from(
  Buffer.from(
    'N3q8ryccAAR31+w1vQAAAAAAAAAUAAAAAAAAAOY6VvNtfbnu7DsWA9bQEo2OeNW6EW0z/bqMuMKDoLxIJL8w9swSYvO1RV+Awk6kZwRMV0HcjpMOPbQzcnZi66f+HFt4ZW063/UAKJluOjY7aj/3OAEAaAEEBgABCVAKAdN9LSkABwsBAAIkBvEHARJTD7tQoSAINDdhgZerm1o1yjkhIQEYAQAMSkQACAoBMzMKcQAABQEREQAwADAAMQAuAHAAbgBnAAAAFAoBAHCcyUSQId0BFQYBACCAgIEAAAAXBlABCW0ABwsBAAEhIQEYDGkAAA==',
    'base64',
  ),
);

const HEADER_ENCRYPTED_7Z_1X1 = Uint8Array.from(
  Buffer.from(
    'N3q8ryccAATXhAdwwAAAAAAAAAAoAAAAAAAAAA+f6ARPcXEJs8uVLgN5o/uyZsgjGF5f6z0kjU0eYus5lvqGr2S/UdmcBdE5rhVM09Wi5Hz/IUYGtybso3TPjPpVSIhz7n9tgDXFu5W6UdBffTsp/M90u6hzVtriTCQNnKKZm4kdZunCoPny3B68V+3CP7fMEAf4GHeg1lZ9eUrJHwuqoHolZPliQcUm2bqFe4haihiwGkR12wUgUg1L4LK4OODdLxJZ7uL023jujkw7GmOexFJR+lWpRj2OqaeTe5oAlq4XBlABCXAABwsBAAEkBvEHARJTDw7RHOjYCgjrB4h7SeAx3kcMaQAA',
    'base64',
  ),
);

const ENCRYPTED_RAR5_1X1 = Uint8Array.from(
  Buffer.from(
    'UmFyIRoHAQAzkrXlCgEFBgAFAQGAgABRsbpYVAIDPNAABMQAIFUvOASAAAAHMDAxLnBuZzABAAMPCDjn/99BmGfaduXgJLyHoxOu+gtFAwMK9bgcGG4CvupSYc0l5L3m7Fz4V4wKAwI/pf1WkiHdAa4/a5SgxLtTsYakN5HL75kvyXZU2a8mThbQZf6TvEKBhA7aE7Hqd68/ulU2ck/krD1vtGpo155wJcYlx0PKzpfaEU4u2QaGiZPSGXOOo+5oHXdWUQMFBAA=',
    'base64',
  ),
);

const HEADER_ENCRYPTED_RAR5_1X1 = Uint8Array.from(
  Buffer.from(
    'UmFyIRoHAQA31RqvIQQAAAEPwpnDLHjbz66nuKpOfciHKZyoe7s86fbsHf8FL1fty/Hr49sLQHURplpkEFK6Gpu9GpYc/tA1nRUe3WLBzDBajnev9oYLLR3y10MnxfIQWuWfK0pr/7bh9jFb80JnsyMKnbV+DyqHVfRaC1PsjhEQU61iX//o0lohYbqd1sQmjG+IIhTkufgEmeKeMfAoL0/kLwGeIgMSeDHM5rUsvhD6Fntk416OOKr5zW9ART1F+tF0QdwWpBo/nWGJt4BdiJxbo/K0q38VlV7X5W8ZOCxx662Amq64ZaU8ZFyL4Brvva2pvyF9pZKaeJ78+LNfAXJ+L989L8kJTwxX1N4lHIetTWhvpFDjC7CCmSHSgUPxVeTF+VnABZfu6KXPfjw=',
    'base64',
  ),
);

// Generated from PNG_1X1 with the official RAR 6.24 command-line trial:
// `rar a -ma4 -pnoveldesk-test`, `-hpnoveldesk-test`, and `-s -ds`.
const ENCRYPTED_RAR4_1X1 = Uint8Array.from(
  Buffer.from(
    'UmFyIRoHAM+QcwAADQAAAAAAAABV0XQklDQAYAAAAEQAAAACMzMKcRWSAV0dMwcAIAAAADAwMS5wbmcQfperMXYjJACwKKcVnSURhM00xErMgLuwjKrX2LWHYPitF7SifTho4mIYWG9SqM1cxAYUjmQdpHUNPQmnu0vVnk25pag4clGtLIA73HZpUQhE2VG7alnT3AJNfJEzEvYEbM4TOnZ91UqObwcixD17AEAHAA==',
    'base64',
  ),
);

const HEADER_ENCRYPTED_RAR4_1X1 = Uint8Array.from(
  Buffer.from(
    'UmFyIRoHAM6Zc4AADQAAAAAAAAD9HUxj1cqLVtIASx1HVPrTwEgBpZRmvaddnpjPykrro2Y7SPZGEU8nffQKimyqVuhVMJEDDjwJn2yj+PAWZE+e3s1F9eGYqloh6eLmxTBn0mXx5HYIfiUKb0k5GgihLAtFzrdo9F/2l0KZRUT2BDyOvX5GGnudL9saJMeMJGgD0mErzSAR04D55z/+Nlezcl4tfRfuQZIoEu16TiLLp86Ete+2yuKsqdj9HUxj1cqLVpRxfdseISaFw2hg2zvKwz8=',
    'base64',
  ),
);

const SOLID_RAR4_TWO_PAGES = Uint8Array.from(
  Buffer.from(
    'UmFyIRoHADvQcwgADQAAAAAAAADzJ3SAkCwAWgAAAEQAAAACMzMKcRWSAV0dMwcAIAAAADAxMC5wbmcAsCMJFglVVMvkzn0UEiwbURvcOU+i/pgiOAIKODNzW4y1uMtrhLY1wJT+YPL/e6HaO5JwOY9zgu5SaEoYKK8cTIO0cJ/3TLAYkIa8t/NNfpmxEAVT+7G5BWrHqzPj8E9bdJCQLAADAAAARAAAAAIzMwpxFZIBXR0zBwAgAAAAMDAyLnBuZwCwHOIVeM/oxD17AEAHAA==',
    'base64',
  ),
);

const SOLID_RAR5_TWO_PAGES = Uint8Array.from(
  Buffer.from(
    'UmFyIRoHAQAJ78hvCwEFBwQGAQGAgIAAlKbBqiMCAwvbAATEACAzMwpxgBsABzAwMi5wbmcKAwI/pf1WkiHdAcPBWCVURC+TPdRQTl4ZURnaOU1F2HhEaAQUaGZmNpljaZZWieoLt6huo/M+GYH6o8Hqt7yZgtVSgAFniWaEXyWNL9rniQTGVunP227aHcSCNlP/CbAd7C8u16BVne6iIwIDC4UABMQAIDMzCnHAGwAHMDEwLnBuZwoDAj+l/VaSId0BRBwCgSgdd1ZRAwUEAA==',
    'base64',
  ),
);

const SOLID_7Z_TWO_PAGES = Uint8Array.from(
  Buffer.from(
    'N3q8ryccAASiRhXStgAAAAAAAAAUAAAAAAAAAAZvBLjgAIcARV0ARJQFxHon9vfuiY5QkIizqtVQIJYzd/bA+R3S6X3j6LA0wcEm9qxgZhygXLrtAspRWBWCb0v5vuaTyUFO1ZPne0GkbAAAAOAAeABhXQAAgTMHrg/Smro9QLuUZBx+62Jj9rmXkirhou0cgAXX0LIWYeuwwgCSw4KzY0GQy3h5tvq8YS9lP7c6zTxTCHsGQPV4nq1jxhg0Rs/hIQ7zleMngmTI+EidkwXxRJglwAAAABcGTQEJaQAHCwEAASEhARgMeQAA',
    'base64',
  ),
);

async function imageArchive(entries: readonly string[]): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const path of entries) await writer.add(path, new Uint8ArrayReader(PNG_1X1));
  return writer.close();
}

async function comicInfoArchive(xml: string): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('001.png', new Uint8ArrayReader(PNG_1X1));
  await writer.add('002.png', new Uint8ArrayReader(PNG_1X1));
  await writer.add('ComicInfo.xml', new TextReader(xml));
  return writer.close();
}

async function encryptedImageArchive(password: string): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('001.png', new Uint8ArrayReader(PNG_1X1), { password });
  return writer.close();
}

async function partiallyInvalidImageArchive(): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('001.png', new Uint8ArrayReader(PNG_1X1));
  await writer.add('002.png', new Uint8ArrayReader(Uint8Array.of(1, 2, 3, 4)));
  return writer.close();
}

function minimalPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
    '<< /Title (Fixture PDF) /Author (NovelDesk) >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

afterEach(() => resetReaderDbForTests());

describe('fixed document import', () => {
  it('natural-sorts image archive pages and persists source, cover and page assets', async () => {
    const source = await imageArchive(['scan/10.png', 'scan/2.png', 'scan/1.png']);
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    const document = await parseImageArchive(source);
    expect(document.pages.map((page) => page.fileName)).toEqual(['scan/1.png', 'scan/2.png', 'scan/10.png']);

    const parsed = materializeImageArchiveImport({
      fileName: 'volume.cbz',
      sourceBytes,
      document,
      now: '2026-08-01T00:00:00.000Z',
    });
    await saveParsedNovelImport(parsed, {
      sourceAsset: {
        blob: source,
        fileName: 'volume.cbz',
        contentType: 'application/vnd.comicbook+zip',
        contentHash: parsed.novel.rawTextHash,
      },
    });

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const chapters = await reader.listChapters(parsed.novel.id);
    const firstPage = await reader.getParagraphPage(chapters[0].id, 0);
    const pageAssetId = firstPage?.paragraphs[0]?.assetId;

    expect(await reader.getNovel(parsed.novel.id)).toMatchObject({
      format: 'image_archive',
      totalChapters: 3,
      coverFit: 'contain',
    });
    expect(await assets.exportSource(parsed.novel.id)).toMatchObject({
      metadata: { contentType: 'application/vnd.comicbook+zip' },
    });
    expect(await assets.getEmbeddedResource(parsed.novel.id, pageAssetId!)).toMatchObject({
      metadata: { kind: 'document_page', provenance: 'archive_embedded', pageIndex: 0 },
    });
  });

  it('streams ZIP pages from the source Blob without a whole-file worker buffer', async () => {
    const source = await imageArchive(['scan/3.png', 'scan/1.png', 'scan/2.png']);
    const progress: ImportProgress[] = [];
    const result = await runBrowserFixedDocumentImportPipeline({
      jobId: 'streaming-cbz',
      fileName: 'streaming.cbz',
      buffer: new ArrayBuffer(0),
      sourceBlob: source,
      totalBytes: source.size,
      encoding: 'utf-8',
      onProgress: (event) => progress.push(event),
      yieldControl: async () => undefined,
    });

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const chapters = await reader.listChapters(result.novel.id);
    const firstPage = await reader.getParagraphPage(chapters[0]!.id, 0);
    expect(result.novel.rawTextHash).toBe(integrityHash(new Uint8Array(await source.arrayBuffer())));
    expect(chapters).toHaveLength(3);
    expect(firstPage?.paragraphs[0]).toMatchObject({ sourceHref: 'scan/1.png', documentKind: 'image' });
    await expect(
      assets.getEmbeddedResource(result.novel.id, firstPage!.paragraphs[0]!.assetId!),
    ).resolves.toMatchObject({ metadata: { kind: 'document_page', pageIndex: 0 } });
    expect(progress.some((event) => event.message?.includes('이미지 페이지를 저장하는 중'))).toBe(true);
    expect(progress.at(-1)).toMatchObject({ status: 'ready', paragraphsWritten: 3 });
  });

  it('maps streamed archive-order pages back to their natural-order descriptors', async () => {
    const parsed = materializeStreamingImageArchiveImport({
      fileName: 'archive-order.cb7',
      sourceContentHash: 'sha256:archive-order',
      document: {
        pages: [
          { fileName: 'scan/1.png', contentType: 'image/png' },
          { fileName: 'scan/2.png', contentType: 'image/png' },
        ],
        async *consumePages() {
          for (const fileName of ['scan/2.png', 'scan/1.png']) {
            yield {
              fileName,
              contentType: 'image/png',
              contentHash: integrityHash(PNG_1X1),
              bytes: PNG_1X1,
            };
          }
        },
      },
    });

    const assets: ParsedNovelImportAsset[] = [];
    for await (const asset of parsed.consumeEmbeddedAssets!()) assets.push(asset);
    expect(
      assets
        .filter((asset) => asset.kind === 'document_page')
        .map(({ fileName, pageIndex }) => ({ fileName, pageIndex })),
    ).toEqual([
      { fileName: 'scan/2.png', pageIndex: 1 },
      { fileName: 'scan/1.png', pageIndex: 0 },
    ]);
    const sourceHrefs: Array<string | undefined> = [];
    for await (const chapter of parsed.consumeChapterParagraphs()) {
      sourceHrefs.push(Array.from(chapter.paragraphs)[0]?.sourceHref);
    }
    expect(sourceHrefs).toEqual(['scan/1.png', 'scan/2.png']);
  });

  it('cleans already streamed page assets when a later ZIP page is invalid', async () => {
    const source = await partiallyInvalidImageArchive();
    await expect(
      runBrowserFixedDocumentImportPipeline({
        jobId: 'streaming-cbz-failure',
        fileName: 'broken.cbz',
        buffer: new ArrayBuffer(0),
        sourceBlob: source,
        totalBytes: source.size,
        encoding: 'utf-8',
        onProgress: () => undefined,
        yieldControl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'invalid_archive' });

    const db = await openReaderDb();
    const transaction = db.transaction(['book_assets', 'book_asset_blobs'], 'readonly');
    await expect(
      Promise.all([
        new Promise<number>((resolve) => {
          const request = transaction.objectStore('book_assets').count();
          request.onsuccess = () => resolve(request.result);
        }),
        new Promise<number>((resolve) => {
          const request = transaction.objectStore('book_asset_blobs').count();
          request.onsuccess = () => resolve(request.result);
        }),
      ]),
    ).resolves.toEqual([0, 0]);
  });

  it('rejects archive traversal and inspects a basic PDF without rewriting it', async () => {
    const unsafe = await imageArchive(['../escape.png']);
    await expect(parseImageArchive(unsafe)).rejects.toMatchObject({ code: 'unsafe_archive' });

    await expect(inspectPdf(minimalPdf())).resolves.toMatchObject({
      pageCount: 1,
      title: 'Fixture PDF',
      author: 'NovelDesk',
    });

    const sourceBytes = minimalPdf();
    const parsed = await materializePdfImport({
      fileName: 'fixture.pdf',
      sourceBytes,
      now: '2026-08-01T00:00:00.000Z',
    });
    await saveParsedNovelImport(parsed, {
      sourceAsset: {
        blob: new Blob([sourceBytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }),
        fileName: 'fixture.pdf',
        contentType: 'application/pdf',
        contentHash: parsed.novel.rawTextHash,
      },
    });

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    expect(await reader.getNovel(parsed.novel.id)).toMatchObject({
      format: 'pdf',
      title: 'Fixture PDF',
      author: 'NovelDesk',
      totalChapters: 1,
    });
    expect(await assets.exportSource(parsed.novel.id)).toMatchObject({
      metadata: { contentType: 'application/pdf', fileName: 'fixture.pdf' },
    });
    const randomAccess = await assets.openSource(parsed.novel.id);
    expect(await randomAccess?.readRange(0, 8)).toEqual(sourceBytes.slice(0, 8));
  });

  it('uses safe ComicInfo metadata without changing verified page order', async () => {
    const source = await comicInfoArchive(`<?xml version="1.0"?>
      <ComicInfo>
        <Title>밤의 기록</Title><Series>기록</Series><Number>2</Number><Writer>서윤</Writer>
        <Summary>두 번째 권</Summary><LanguageISO>ko</LanguageISO><Genre>미스터리, 드라마</Genre>
        <Manga>YesAndRightToLeft</Manga>
        <Pages><Page Image="0" Type="FrontCover"/><Page Image="1" DoublePageSize="true"/></Pages>
      </ComicInfo>`);
    const document = await parseImageArchive(source);
    expect(document.comicInfo).toMatchObject({
      title: '밤의 기록',
      series: '기록',
      number: 2,
      writer: '서윤',
      readingDirection: 'rtl',
      pages: [
        { image: 0, type: 'FrontCover', doublePage: false },
        { image: 1, doublePage: true },
      ],
    });
    const parsed = materializeImageArchiveImport({
      fileName: 'fallback.cbz',
      sourceBytes: new Uint8Array(await source.arrayBuffer()),
      document,
    });
    expect(parsed.novel).toMatchObject({
      title: '밤의 기록',
      author: '서윤',
      seriesTitle: '기록',
      seriesIndex: 2,
      language: 'ko',
      readingDirection: 'rtl',
    });
    const importedChapters = Array.from(
      parsed.consumeChapterParagraphs() as Iterable<{ paragraphs: Iterable<unknown> }>,
    );
    expect(Array.from(importedChapters[1].paragraphs)).toEqual([expect.objectContaining({ documentPageDouble: true })]);
  });

  it('rejects external entities in ComicInfo', () => {
    expect(() =>
      parseComicInfoXml(new TextEncoder().encode('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><ComicInfo/>')),
    ).toThrow(/외부 엔터티/);
  });

  it('dispatches archive signatures and keeps ZIP passwords request-scoped', async () => {
    expect(detectImageArchiveFormat(Uint8Array.of(0x50, 0x4b, 0x03, 0x04))).toBe('zip');
    expect(detectImageArchiveFormat(Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00))).toBe('rar4');
    expect(detectImageArchiveFormat(Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00))).toBe('rar5');
    expect(detectImageArchiveFormat(Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))).toBe('7z');

    const encrypted = await encryptedImageArchive('correct horse');
    await expect(parseImageArchive(encrypted)).rejects.toMatchObject({ code: 'password_required' });
    await expect(parseImageArchive(encrypted, { password: 'wrong' })).rejects.toMatchObject({ code: 'wrong_password' });
    await expect(parseImageArchive(encrypted, { password: 'correct horse' })).resolves.toMatchObject({
      pages: [expect.objectContaining({ fileName: '001.png' })],
    });
  });

  it('decrypts encrypted 7z content and headers with a request-scoped password', async () => {
    for (const bytes of [ENCRYPTED_7Z_1X1, HEADER_ENCRYPTED_7Z_1X1]) {
      const encrypted = new Blob([bytes], { type: 'application/x-7z-compressed' });
      await expect(parseImageArchive(encrypted)).rejects.toMatchObject({ code: 'password_required' });
      await expect(parseImageArchive(encrypted, { password: 'wrong' })).rejects.toMatchObject({
        code: 'wrong_password',
      });
      await expect(parseImageArchive(encrypted, { password: 'correct horse' })).resolves.toMatchObject({
        pages: [expect.objectContaining({ fileName: '001.png', bytes: PNG_1X1 })],
      });
    }
  });

  it('decrypts encrypted RAR5 content and headers with a request-scoped password', async () => {
    for (const bytes of [ENCRYPTED_RAR5_1X1, HEADER_ENCRYPTED_RAR5_1X1]) {
      const encrypted = new Blob([bytes], { type: 'application/vnd.rar' });
      await expect(parseImageArchive(encrypted)).rejects.toMatchObject({ code: 'password_required' });
      await expect(parseImageArchive(encrypted, { password: 'wrong' })).rejects.toMatchObject({
        code: 'wrong_password',
      });
      await expect(parseImageArchive(encrypted, { password: 'correct horse' })).resolves.toMatchObject({
        pages: [expect.objectContaining({ fileName: '001.png', bytes: PNG_1X1 })],
      });
    }
  });

  it('decrypts encrypted RAR4 content and headers with a request-scoped password', async () => {
    for (const bytes of [ENCRYPTED_RAR4_1X1, HEADER_ENCRYPTED_RAR4_1X1]) {
      const encrypted = new Blob([bytes], { type: 'application/vnd.rar' });
      await expect(parseImageArchive(encrypted)).rejects.toMatchObject({ code: 'password_required' });
      await expect(parseImageArchive(encrypted, { password: 'wrong' })).rejects.toMatchObject({
        code: 'wrong_password',
      });
      await expect(parseImageArchive(encrypted, { password: 'noveldesk-test' })).resolves.toMatchObject({
        pages: [expect.objectContaining({ fileName: '001.png', bytes: PNG_1X1 })],
      });
    }
  });

  it('returns naturally ordered pages from solid RAR4, RAR5 and 7z archives', async () => {
    for (const bytes of [SOLID_RAR4_TWO_PAGES, SOLID_RAR5_TWO_PAGES, SOLID_7Z_TWO_PAGES]) {
      const document = await parseImageArchive(new Blob([bytes]));
      expect(document.pages.map((page) => page.fileName)).toEqual(['002.png', '010.png']);
      expect(document.pages.every((page) => page.bytes.byteLength === PNG_1X1.byteLength)).toBe(true);
    }
  });

  it('rejects CRC-damaged solid RAR4 and RAR5 archives', async () => {
    for (const bytes of [SOLID_RAR4_TWO_PAGES, SOLID_RAR5_TWO_PAGES]) {
      const corrupted = bytes.slice();
      corrupted[100] ^= 0xff;
      await expect(parseImageArchive(new Blob([corrupted]))).rejects.toMatchObject({ code: 'invalid_archive' });
    }
  });

  it('rejects a truncated 7z next header as a corrupt archive', async () => {
    const truncated = SOLID_7Z_TWO_PAGES.slice(0, -1);
    await expect(parseImageArchive(new Blob([truncated]))).rejects.toMatchObject({ code: 'invalid_archive' });
  });

  it('aborts solid RAR4, RAR5 and 7z streams between staged pages', async () => {
    for (const bytes of [SOLID_RAR4_TWO_PAGES, SOLID_RAR5_TWO_PAGES, SOLID_7Z_TWO_PAGES]) {
      const controller = new AbortController();
      const stream = await openImageArchiveStream(new Blob([bytes]), { signal: controller.signal });
      const pages = stream.consumePages()[Symbol.asyncIterator]();
      await expect(pages.next()).resolves.toMatchObject({ done: false });
      controller.abort();
      await expect(pages.next()).rejects.toMatchObject({ name: 'AbortError' });
    }
  });
});
