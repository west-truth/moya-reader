import { describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import {
  buildDocumentSeriesArchive,
  materializeDocumentSeriesArchive,
  readDocumentSeriesArchive,
  type DocumentSeriesSourceInput,
} from './index';

function textSource(
  id: string,
  fileName: string,
  title: string,
  text: string,
  sourceOrder: number,
): DocumentSeriesSourceInput {
  const blob = new Blob([text], { type: 'text/plain' });
  return {
    id,
    title,
    fileName,
    contentType: 'text/plain',
    contentHash: integrityHash(new TextEncoder().encode(text)),
    sourceOrder,
    format: 'txt',
    encoding: 'utf-8',
    chapterSplitMode: 'auto',
    includedChapterIndices: [1],
    blob,
  };
}

async function chapterRows(parsed: Awaited<ReturnType<typeof materializeDocumentSeriesArchive>>) {
  const rows = [];
  for await (const row of parsed.consumeChapterParagraphs()) {
    rows.push({ chapter: row.chapter, paragraphs: [...row.paragraphs] });
  }
  return rows;
}

async function epubSource(title: string, chapterTitle: string, body: string): Promise<Blob> {
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
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapterTitle}</title></head><body><h1>${chapterTitle}</h1><p>${body}</p></body></html>`,
    ),
  );
  return writer.close();
}

describe('document series archive', () => {
  it('preserves source files and stable chapter identities while appending a source', async () => {
    const first = textSource('source-1', '작품 1화.txt', '1화', '첫 번째 본문입니다.', 1);
    const second = textSource('source-2', '작품 2화.txt', '2화', '두 번째 본문입니다.', 2);
    const initial = await buildDocumentSeriesArchive({
      collection: { id: 'series-1', title: '작품', format: 'txt' },
      sources: [first, second],
    });
    const parsedInitial = await materializeDocumentSeriesArchive(initial, {
      fileName: initial.name,
      clientBookId: 'book-1',
    });
    const initialRows = await chapterRows(parsedInitial);
    expect(initialRows.map((row) => row.chapter.title)).toEqual(['1화', '2화']);
    expect(initialRows.map((row) => row.paragraphs[0]?.text)).toEqual(['첫 번째 본문입니다.', '두 번째 본문입니다.']);

    const stored = await readDocumentSeriesArchive(initial);
    expect(await stored?.sources.get('source-1')?.text()).toBe('첫 번째 본문입니다.');
    const third = textSource('source-3', '작품 3화.txt', '3화', '세 번째 본문입니다.', 3);
    const appended = await buildDocumentSeriesArchive({
      collection: stored!.manifest.collection,
      sources: [
        ...stored!.manifest.sources.map((descriptor) => {
          const { entryName: _entryName, byteLength: _byteLength, ...source } = descriptor;
          return { ...source, blob: stored!.sources.get(descriptor.id)! };
        }),
        third,
      ],
    });
    const parsedAppended = await materializeDocumentSeriesArchive(appended, {
      fileName: appended.name,
      clientBookId: 'book-1',
    });
    expect(parsedAppended.chapters).toHaveLength(3);
    expect(parsedAppended.chapters.slice(0, 2).map((chapter) => chapter.id)).toEqual(
      initialRows.map((row) => row.chapter.id),
    );
  });

  it('keeps EPUB chapter semantics while combining multiple EPUB originals', async () => {
    const firstBlob = await epubSource('작품 1권', '첫 장', '첫 EPUB 본문');
    const secondBlob = await epubSource('작품 2권', '둘째 장', '둘째 EPUB 본문');
    const source = (
      id: string,
      title: string,
      fileName: string,
      blob: Blob,
      contentHash: string,
      order: number,
    ): DocumentSeriesSourceInput => ({
      id,
      title,
      fileName,
      contentType: 'application/epub+zip',
      contentHash,
      sourceOrder: order,
      format: 'epub',
      includedChapterIndices: [1],
      blob,
    });
    const first = source(
      'epub-1',
      '1권',
      '작품 1권.epub',
      firstBlob,
      integrityHash(new Uint8Array(await firstBlob.arrayBuffer())),
      1,
    );
    const second = source(
      'epub-2',
      '2권',
      '작품 2권.epub',
      secondBlob,
      integrityHash(new Uint8Array(await secondBlob.arrayBuffer())),
      2,
    );
    const aggregate = await buildDocumentSeriesArchive({
      collection: { id: 'epub-series', title: '작품', format: 'epub' },
      sources: [first, second],
    });
    const parsed = await materializeDocumentSeriesArchive(aggregate, {
      fileName: aggregate.name,
      clientBookId: 'epub-book',
    });
    const rows = await chapterRows(parsed);

    expect(parsed.novel).toMatchObject({ format: 'epub', title: '작품', totalChapters: 2 });
    expect(rows.map((row) => row.chapter.title)).toEqual(['1권', '2권']);
    expect(rows.map((row) => row.paragraphs.at(-1)?.text)).toEqual(['첫 EPUB 본문', '둘째 EPUB 본문']);
  });
});
