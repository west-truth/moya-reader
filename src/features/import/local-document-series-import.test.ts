import { describe, expect, it, vi } from 'vitest';
import { inspectDocumentSeriesSource, materializeDocumentSeriesArchive } from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import { BlobReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import type { Chapter, Novel } from '../../domain/types';
import type { BookAssetRepository, ExportedBookSource } from '../../repositories/book-asset-repository';
import {
  buildLocalDocumentSeriesImportFile,
  inspectLocalDocumentSeriesImport,
  planLocalDocumentSeriesImport,
} from './local-document-series-import';

function novel(title: string, source: File, totalChapters: number): Novel {
  const now = '2026-08-26T00:00:00.000Z';
  return {
    id: 'book-local-text',
    format: 'txt',
    title,
    sourceFileName: source.name,
    sourceEncoding: 'utf-8',
    rawText: '',
    normalizedText: '',
    rawTextHash: integrityHash(new Uint8Array()),
    normalizedTextHash: integrityHash(new Uint8Array()),
    createdAt: now,
    updatedAt: now,
    totalChapters,
    totalCharacters: 0,
    totalParagraphs: 0,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function storedSource(book: Novel, file: File, contentHash: string): ExportedBookSource {
  return {
    metadata: {
      id: 'source-asset',
      bookId: book.id,
      kind: 'source',
      provenance: 'original',
      status: 'active',
      storageKey: 'source-asset',
      fileName: file.name,
      contentType: 'text/plain',
      contentHash,
      byteLength: file.size,
      encoding: 'utf-8',
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    blob: file,
  };
}

async function documentBundle(name: string, files: readonly File[]): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const file of files) await writer.add(`회차/${file.name}`, new BlobReader(file));
  return new File([await writer.close()], name, { type: 'application/zip' });
}

async function epubFile(name: string, title: string, body: string): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
  await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await writer.add(
    'META-INF/container.xml',
    new TextReader(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  await writer.add(
    'OEBPS/content.opf',
    new TextReader(`<?xml version="1.0"?><package version="3.0" unique-identifier="id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:language>ko</dc:language></metadata>
      <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="chapter"/></spine></package>`),
  );
  await writer.add(
    'OEBPS/chapter.xhtml',
    new TextReader(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`,
    ),
  );
  return new File([await writer.close()], name, { type: 'application/epub+zip' });
}

describe('local document series import', () => {
  it('imports naturally ordered text files inside one ZIP as a serialized work', async () => {
    const bundle = await documentBundle('압축 소설.zip', [
      new File(['제2화\n\n두 번째 본문입니다.'], '02화.txt', { type: 'text/plain' }),
      new File(['제1화\n\n첫 번째 본문입니다.'], '01화.txt', { type: 'text/plain' }),
    ]);
    const inspection = await inspectLocalDocumentSeriesImport([bundle], [], {
      encoding: 'utf-8',
      chapterSplitMode: 'auto',
    });

    expect(inspection).toMatchObject({ workTitle: '압축 소설', format: 'txt' });
    expect(inspection?.sources.map((source) => source.file.name)).toEqual(['01화.txt', '02화.txt']);
    const plan = await planLocalDocumentSeriesImport(inspection!, undefined, [], undefined);
    const aggregate = await buildLocalDocumentSeriesImportFile(plan, new AbortController().signal);
    const parsed = await materializeDocumentSeriesArchive(aggregate!, { fileName: aggregate!.name });
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['1화', '2화']);
  });

  it('imports multiple EPUB originals inside one ZIP without flattening their chapters', async () => {
    const bundle = await documentBundle('EPUB 연재.zip', [
      await epubFile('EPUB 연재 1권.epub', '첫 장', '첫 EPUB 본문'),
      await epubFile('EPUB 연재 2권.epub', '둘째 장', '둘째 EPUB 본문'),
    ]);
    const inspection = await inspectLocalDocumentSeriesImport([bundle], [], {
      encoding: 'utf-8',
      chapterSplitMode: 'auto',
    });

    expect(inspection).toMatchObject({ workTitle: 'EPUB 연재', format: 'epub' });
    expect(inspection?.sources).toHaveLength(2);
    const plan = await planLocalDocumentSeriesImport(inspection!, undefined, [], undefined);
    const aggregate = await buildLocalDocumentSeriesImportFile(plan, new AbortController().signal);
    const parsed = await materializeDocumentSeriesArchive(aggregate!, { fileName: aggregate!.name });
    expect(parsed.chapters).toHaveLength(2);
  });

  it('asks for separate bundles when EPUB and text sources are mixed', async () => {
    const bundle = await documentBundle('혼합 작품.zip', [
      new File(['제1화\n\n본문'], '혼합 작품 1화.txt', { type: 'text/plain' }),
      await epubFile('혼합 작품 2화.epub', '제2화', 'EPUB 본문'),
    ]);

    await expect(
      inspectLocalDocumentSeriesImport([bundle], [], { encoding: 'utf-8', chapterSplitMode: 'auto' }),
    ).rejects.toThrow('EPUB과 TXT/Markdown은 서로 분리해서 회차를 추가해 주세요.');
  });

  it('keeps the legacy source and adds only new chapters from a later text file', async () => {
    const existingFile = new File(['제1화\n\n첫 번째 본문입니다.'], '작품 1화.txt', { type: 'text/plain' });
    const incomingFile = new File(['제1화\n\n첫 번째 본문입니다.\n\n제2화\n\n두 번째 본문입니다.'], '작품 2화.txt', {
      type: 'text/plain',
    });
    const existingPreview = await inspectDocumentSeriesSource({
      fileName: existingFile.name,
      blob: existingFile,
      format: 'txt',
      encoding: 'utf-8',
      chapterSplitMode: 'auto',
    });
    const target = novel('작품', existingFile, existingPreview.chapters.length);
    const chapters: Chapter[] = existingPreview.chapters.map((chapter) => ({
      ...chapter,
      id: `chapter-${chapter.index}`,
      novelId: target.id,
      normalizedText: '',
      rawStartOffset: 0,
      rawEndOffset: chapter.characterCount,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    }));
    const exported = storedSource(
      target,
      existingFile,
      integrityHash(new Uint8Array(await existingFile.arrayBuffer())),
    );
    const assets = { exportSource: vi.fn(async () => exported) } as unknown as BookAssetRepository;
    const inspection = await inspectLocalDocumentSeriesImport([incomingFile], [target], {
      targetNovel: target,
      encoding: 'utf-8',
      chapterSplitMode: 'auto',
    });
    expect(inspection?.chapters).toHaveLength(2);
    const plan = await planLocalDocumentSeriesImport(inspection!, target, chapters, assets);
    expect(plan).toMatchObject({ addCount: 1, duplicateCount: 1, conflictCount: 0 });

    const aggregate = await buildLocalDocumentSeriesImportFile(plan, new AbortController().signal);
    const parsed = await materializeDocumentSeriesArchive(aggregate!, {
      fileName: aggregate!.name,
      clientBookId: target.id,
    });
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제1화', '제2화']);
  });
});
