import { describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import {
  buildDocumentSeriesArchive,
  materializeDocumentSeriesArchive,
  readDocumentSeriesArchive,
  isDocumentSeriesManifest,
  isRemoteDocumentSeriesImport,
  documentSeriesConfigurationFingerprint,
  REMOTE_DOCUMENT_IDENTITY_SCHEME,
  REMOTE_DOCUMENT_LIMITS,
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

describe('remote TXT single identity', () => {
  const collection = { id: 'remote-series', title: 'Remote work', format: 'txt' as const };
  function remoteSource(id: string, body: string, order = 1): DocumentSeriesSourceInput {
    return {
      ...textSource(id, `${id}.txt`, id, body, order),
      chapterSplitMode: 'single',
      extractionVersion: 'utf8-txt-v1',
    };
  }
  async function materialize(sources: DocumentSeriesSourceInput[]) {
    const file = await buildDocumentSeriesArchive({
      collection,
      sources,
      identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
    });
    const parsed = await materializeDocumentSeriesArchive(file, { fileName: file.name, clientBookId: 'remote-book' });
    return { file, parsed, rows: await chapterRows(parsed) };
  }

  it('keeps logical chapter and unique paragraph IDs through edits, insertion, title and filename changes', async () => {
    const body = 'Unique first.\n\nRepeated text.\n\nRepeated text.\n\nOriginal last.';
    const first = remoteSource('release-1', body);
    const initial = await materialize([first]);
    const revised = await materialize([
      remoteSource(
        'release-1',
        'Inserted paragraph.\n\nUnique first.\n\nRepeated text.\n\nRepeated text.\n\nRevised last.',
        5,
      ),
    ]);
    expect(initial.parsed.chapters[0]!.id).toBe(revised.parsed.chapters[0]!.id);
    expect(revised.rows[0]!.paragraphs.find((paragraph) => paragraph.text === 'Unique first.')!.id).toBe(
      initial.rows[0]!.paragraphs[0]!.id,
    );
    const oldRepeated = initial.rows[0]!.paragraphs.filter((paragraph) => paragraph.text === 'Repeated text.').map(
      (paragraph) => paragraph.id,
    );
    expect(
      revised.rows[0]!.paragraphs.filter((paragraph) => paragraph.text === 'Repeated text.').every(
        (paragraph) => !oldRepeated.includes(paragraph.id),
      ),
    ).toBe(true);
    const renamed = await materialize([
      { ...first, title: 'Renamed release', fileName: 'renamed.txt', sourceOrder: 7 },
    ]);
    expect(renamed.rows[0]!.paragraphs.map((paragraph) => paragraph.id)).toEqual(
      initial.rows[0]!.paragraphs.map((paragraph) => paragraph.id),
    );
    expect(renamed.parsed.chapters[0]).toMatchObject({
      id: initial.parsed.chapters[0]!.id,
      documentSectionId: 'release-1',
      documentSectionTitle: 'Renamed release',
      documentSectionIndex: 7,
      documentSectionSourceContentHash: first.contentHash,
    });
    expect(isRemoteDocumentSeriesImport(renamed.parsed)).toBe(true);
    expect(await (await readDocumentSeriesArchive(renamed.file))!.sources.get('release-1')!.text()).toBe(body);
  });

  it('keeps schema 1 packages on their legacy identities and requires explicit supported identity metadata', async () => {
    const first = remoteSource('release-1', 'First paragraph.\n\nOther paragraph.');
    const legacy = await buildDocumentSeriesArchive({ collection, sources: [first] });
    const parsedLegacy = await materializeDocumentSeriesArchive(legacy, {
      fileName: legacy.name,
      clientBookId: 'remote-book',
    });
    expect(isRemoteDocumentSeriesImport(parsedLegacy)).toBe(false);
    expect(parsedLegacy.chapters[0]!.documentSectionId).toBeUndefined();
    const remote = await materialize([first]);
    expect(remote.parsed.chapters[0]!.id).not.toBe(parsedLegacy.chapters[0]!.id);
    const manifest = (await readDocumentSeriesArchive(remote.file))!.manifest;
    expect(manifest.schemaVersion).toBe(2);
    expect(isDocumentSeriesManifest({ ...manifest, identityScheme: 'unknown' })).toBe(false);
    expect(isDocumentSeriesManifest({ ...manifest, schemaVersion: 1 })).toBe(false);
    expect(isDocumentSeriesManifest({ ...manifest, configurationFingerprint: first.contentHash })).toBe(false);
  });

  it('fingerprints interpreted ordering and titles, with deterministic ties and no delivery filename dependency', async () => {
    const first = remoteSource('release-a', 'First.', 1);
    const second = remoteSource('release-b', 'Second.', 1);
    const fingerprint = (sources: DocumentSeriesSourceInput[]) =>
      documentSeriesConfigurationFingerprint({ collection, sources, identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME });
    expect(fingerprint([first, second])).toBe(fingerprint([second, { ...first, fileName: 'delivery.txt' }]));
    expect(fingerprint([first, second])).not.toBe(fingerprint([{ ...first, sourceOrder: 2 }, second]));
    expect(fingerprint([first, second])).not.toBe(fingerprint([{ ...first, title: 'Updated title' }, second]));
    expect(fingerprint([first])).toBe(fingerprint([remoteSource('release-a', 'Updated exact bytes.', 1)]));
    expect((await materialize([second, first])).parsed.chapters.map((chapter) => chapter.documentSectionId)).toEqual([
      'release-a',
      'release-b',
    ]);
  });

  it('keeps the legacy 512 limit and permits only bounded remote packages up to 1,000 sources', async () => {
    const sources = Array.from({ length: 1_000 }, (_, index) =>
      remoteSource(`release-${index}`, 'Small fixture.', index),
    );
    await expect(buildDocumentSeriesArchive({ collection, sources: sources.slice(0, 513) })).rejects.toThrow('원본 수');
    for (const count of [512, 513, 1_000]) {
      const file = await buildDocumentSeriesArchive({
        collection,
        sources: sources.slice(0, count),
        identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
      });
      expect((await readDocumentSeriesArchive(file))!.manifest.sources).toHaveLength(count);
    }
    await expect(
      buildDocumentSeriesArchive({
        collection,
        sources: [...sources, remoteSource('overflow', 'Over.')],
        identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
      }),
    ).rejects.toThrow('원본 수');
    await expect(
      buildDocumentSeriesArchive({
        collection,
        sources: [{ ...sources[0]!, blob: new Blob([new Uint8Array(REMOTE_DOCUMENT_LIMITS.sourceBytes + 1)]) }],
        identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
      }),
    ).rejects.toThrow('원본 크기');
  });

  it('still rejects corrupt archive bytes and changed hash claims when reusing verified remote bytes', async () => {
    const original = await materialize([remoteSource('release-1', 'Correct bytes.')]);
    const archive = (await readDocumentSeriesArchive(original.file))!;
    const descriptor = archive.manifest.sources[0]!;
    const writer = new ZipWriter(new BlobWriter());
    await writer.add(descriptor.entryName, new TextReader('Corrupt bytes.'));
    await writer.add('moya-document-series.json', new TextReader(JSON.stringify(archive.manifest)));
    await expect(readDocumentSeriesArchive(await writer.close())).rejects.toThrow('원본 해시');
    await expect(
      buildDocumentSeriesArchive({
        collection,
        identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
        sources: [
          { ...descriptor, blob: archive.sources.get(descriptor.id)!, contentHash: integrityHash('Corrupt bytes.') },
        ],
      }),
    ).rejects.toThrow('원본 해시');
  });
});
