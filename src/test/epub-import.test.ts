import { describe, expect, it } from 'vitest';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { EpubImportError, materializeEpubImport, parseEpub, stableEpubCoverSeed } from '@noveldesk/epub-core';

interface FixtureOptions {
  readonly version?: '2.0' | '3.0';
  readonly fixedLayout?: boolean;
  readonly body?: string;
  readonly manifestExtra?: string;
  readonly navTitle?: string;
  readonly extraEntries?: ReadonlyArray<{ path: string; text?: string; bytes?: Uint8Array }>;
}

async function epubFixture(options: FixtureOptions = {}): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
  await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await writer.add(
    'META-INF/container.xml',
    new TextReader(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  const metadata = options.fixedLayout ? '<meta property="rendition:layout">pre-paginated</meta>' : '';
  await writer.add(
    'OEBPS/content.opf',
    new TextReader(`<?xml version="1.0"?>
      <package version="${options.version ?? '3.0'}" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>EPUB 테스트</dc:title><dc:creator>테스터</dc:creator><dc:language>ko</dc:language>${metadata}
        </metadata>
        <manifest>
          <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
          <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
          ${options.navTitle ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
          ${options.manifestExtra ?? ''}
        </manifest>
        <spine${options.version === '2.0' ? ' toc="ncx"' : ''}><itemref idref="chapter"/></spine>
      </package>`),
  );
  await writer.add(
    'OEBPS/chapter.xhtml',
    new TextReader(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>첫 장</title></head><body>
      ${
        options.body ??
        '<h1>첫 장</h1><p>문장 <strong>하나</strong>와 <em>강조</em>.</p><blockquote><p>인용문</p></blockquote><ul><li>항목</li></ul><img src="images/cover.png" alt="표지"/><p><a href="chapter.xhtml#end">내부 링크</a></p>'
      }
    </body></html>`),
  );
  await writer.add('OEBPS/images/cover.png', new Uint8ArrayReader(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])));
  if (options.navTitle) {
    await writer.add(
      'OEBPS/nav.xhtml',
      new TextReader(
        `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="chapter.xhtml">${options.navTitle}</a></li></ol></nav></body></html>`,
      ),
    );
  }
  for (const entry of options.extraEntries ?? []) {
    await writer.add(entry.path, entry.bytes ? new Uint8ArrayReader(entry.bytes) : new TextReader(entry.text ?? ''));
  }
  return writer.close();
}

describe('EPUB import engine', () => {
  it('keeps deterministic cover seeds inside the PostgreSQL signed integer range', () => {
    expect(stableEpubCoverSeed('sha256:00000000ffffffff')).toBe(2_147_483_647);
    expect(stableEpubCoverSeed('sha256:0000000080000000')).toBe(0);
    expect(stableEpubCoverSeed('invalid')).toBe(0);
  });

  it('parses EPUB3 metadata, semantic blocks, marks, links and embedded images', async () => {
    const source = await epubFixture({ navTitle: '목차의 첫 장' });
    const document = await parseEpub(source);

    expect(document).toMatchObject({ title: 'EPUB 테스트', author: '테스터', language: 'ko' });
    expect(document.sections).toHaveLength(1);
    expect(document.sections[0].title).toBe('목차의 첫 장');
    expect(document.sections[0].blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'blockquote',
      'list_item',
      'image',
      'paragraph',
    ]);
    expect(document.sections[0].blocks[1].inlineMarks?.map((mark) => mark.kind)).toEqual(['strong', 'emphasis']);
    expect(document.sections[0].blocks[5].inlineMarks?.[0].href).toBe('OEBPS/chapter.xhtml#end');
    expect(document.resources).toHaveLength(1);

    const parsed = materializeEpubImport(document, {
      fileName: 'fixture.epub',
      sourceBytes: new Uint8Array(await source.arrayBuffer()),
      now: '2026-07-13T00:00:00.000Z',
    });
    const rows = [...(parsed.consumeChapterParagraphs() as Iterable<{ paragraphs: Iterable<unknown> }>)];
    expect(parsed.novel).toMatchObject({ format: 'epub', totalChapters: 1, coverFit: 'contain' });
    expect(parsed.embeddedAssets?.map((asset) => asset.kind)).toEqual(['epub_resource', 'cover']);
    expect([...rows[0].paragraphs]).toHaveLength(6);
  });

  it('retains a separate embedded illustration and links its image block to the stored asset', async () => {
    const illustration = new Uint8Array(256 * 1024);
    for (let index = 0; index < illustration.length; index += 1) illustration[index] = index % 251;
    illustration.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const source = await epubFixture({
      body: '<h1>삽화 장</h1><p>삽화 앞 문장</p><img src="images/illustration.png" alt="삽화"/>',
      manifestExtra: '<item id="illustration" href="images/illustration.png" media-type="image/png"/>',
      extraEntries: [{ path: 'OEBPS/images/illustration.png', bytes: illustration }],
    });
    const document = await parseEpub(source);

    expect(document.resources.map((resource) => [resource.href, resource.bytes.byteLength])).toEqual([
      ['OEBPS/images/illustration.png', illustration.byteLength],
      ['OEBPS/images/cover.png', 8],
    ]);

    const parsed = materializeEpubImport(document, {
      fileName: 'illustrated.epub',
      sourceBytes: new Uint8Array(await source.arrayBuffer()),
      now: '2026-08-21T00:00:00.000Z',
    });
    const rows = [
      ...(parsed.consumeChapterParagraphs() as Iterable<{
        paragraphs: Iterable<{ documentKind?: string; assetId?: string }>;
      }>),
    ];
    const image = [...rows[0].paragraphs].find((paragraph) => paragraph.documentKind === 'image');
    const illustrationAsset = parsed.embeddedAssets?.find(
      (asset) => asset.kind === 'epub_resource' && asset.fileName === 'illustration.png',
    );

    expect(illustrationAsset?.bytes.byteLength).toBe(illustration.byteLength);
    expect(image?.assetId).toBe(illustrationAsset?.id);
    expect(parsed.embeddedAssets?.map((asset) => asset.kind)).toEqual([
      'epub_resource',
      'epub_resource',
      'cover',
    ]);
  });

  it('accepts an EPUB2 package with an NCX manifest item and uses spine order', async () => {
    const source = await epubFixture({
      version: '2.0',
      manifestExtra: '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      extraEntries: [
        {
          path: 'OEBPS/toc.ncx',
          text: '<ncx><navMap><navPoint><navLabel><text>NCX 첫 장</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>',
        },
      ],
    });
    await expect(parseEpub(source)).resolves.toMatchObject({
      title: 'EPUB 테스트',
      sections: [{ title: 'NCX 첫 장' }],
    });
  });

  it('preserves ruby readings, inherited language spans and footnote references without duplicate rt text', async () => {
    const source = await epubFixture({
      body: `<p lang="ja"><ruby>東京<rt>とうきょう</rt></ruby><a epub:type="noteref" href="#note-1">1</a></p>
        <aside epub:type="footnote" id="note-1"><p>각주 본문</p></aside>`,
    });
    const document = await parseEpub(source);
    const block = document.sections[0].blocks[0];

    expect(block.plainText).toBe('東京1');
    expect(block.inlineSemantics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ruby', start: 0, end: 2, value: 'とうきょう' }),
        expect.objectContaining({ kind: 'language', start: 0, end: 3, value: 'ja' }),
        expect.objectContaining({ kind: 'footnote_reference', start: 2, end: 3 }),
      ]),
    );
    const parsed = materializeEpubImport(document, {
      fileName: 'semantic.epub',
      sourceBytes: new Uint8Array(await source.arrayBuffer()),
      now: '2026-08-01T00:00:00.000Z',
    });
    const rows = [
      ...(parsed.consumeChapterParagraphs() as Iterable<{ paragraphs: Iterable<{ inlineSemantics?: unknown }> }>),
    ];
    expect([...rows[0].paragraphs][0].inlineSemantics).toEqual(block.inlineSemantics);
    const footnote = [...rows[0].paragraphs].find((row) => (row as { text?: string }).text === '각주 본문');
    expect(footnote).toMatchObject({ documentPageType: 'footnote', sourceHref: expect.stringContaining('#note-1') });
  });

  it('handles a long single spine item without losing blocks', async () => {
    const body = `<h1>긴 장</h1>${Array.from({ length: 180 }, (_, index) => `<p>${index}번째 문단</p>`).join('')}`;
    const document = await parseEpub(await epubFixture({ body }));
    expect(document.sections[0].blocks).toHaveLength(181);
  });

  it('rejects fixed-layout and traversal package paths with explicit reasons', async () => {
    await expect(parseEpub(await epubFixture({ fixedLayout: true }))).rejects.toMatchObject({
      code: 'fixed_layout',
    });
    await expect(
      parseEpub(
        await epubFixture({
          manifestExtra: '<item id="bad" href="../../outside.png" media-type="image/png"/>',
        }),
      ),
    ).rejects.toBeInstanceOf(EpubImportError);
  });

  it('drops scripts and remote images but preserves confirmed external links', async () => {
    const document = await parseEpub(
      await epubFixture({
        body: '<script>globalThis.pwned=true</script><img src="https://example.com/a.png"/><p><a href="https://example.com/">외부</a></p>',
      }),
    );
    expect(document.sections[0].blocks).toHaveLength(1);
    expect(document.sections[0].blocks[0].inlineMarks?.[0].href).toBe('https://example.com/');
    expect(document.resources).toHaveLength(1);
  });
});
