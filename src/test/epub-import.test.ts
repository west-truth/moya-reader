import { describe, expect, it } from 'vitest';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { EpubImportError, materializeEpubImport, parseEpub, stableEpubCoverSeed } from '@noveldesk/epub-core';

interface FixtureOptions {
  readonly version?: '2.0' | '3.0';
  readonly fixedLayout?: boolean;
  readonly coverMode?: 'epub3' | 'epub2-meta' | 'guide';
  readonly body?: string;
  readonly manifestExtra?: string;
  readonly navTitle?: string;
  readonly chapterBytes?: Uint8Array;
  readonly chapterMediaType?: string;
  readonly extraEntries?: ReadonlyArray<{ path: string; text?: string; bytes?: Uint8Array }>;
}

async function renameFixtureArchiveEntry(blob: Blob, from: string, to: string): Promise<Blob> {
  const fromBytes = new TextEncoder().encode(from);
  const toBytes = new TextEncoder().encode(to);
  if (fromBytes.length !== toBytes.length) throw new Error('Fixture archive names must have the same byte length.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let replacements = 0;
  for (let offset = 0; offset <= bytes.length - fromBytes.length; offset += 1) {
    if (fromBytes.every((value, index) => bytes[offset + index] === value)) {
      bytes.set(toBytes, offset);
      replacements += 1;
      offset += fromBytes.length - 1;
    }
  }
  // A normal ZIP repeats a file name in its local header and central directory.
  if (replacements !== 2) throw new Error(`Expected two ZIP name occurrences, received ${replacements}.`);
  return new Blob([bytes], { type: 'application/epub+zip' });
}

function utf16Le(value: string): Uint8Array {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes.set([0xff, 0xfe]);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[2 + index * 2] = codeUnit & 0xff;
    bytes[3 + index * 2] = codeUnit >>> 8;
  }
  return bytes;
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
  const coverMode = options.coverMode ?? 'epub3';
  const metadata = [
    options.fixedLayout ? '<meta property="rendition:layout">pre-paginated</meta>' : '',
    coverMode === 'epub2-meta' ? '<meta name="cover" content="cover-image"/>' : '',
  ].join('');
  await writer.add(
    'OEBPS/content.opf',
    new TextReader(`<?xml version="1.0"?>
      <package version="${options.version ?? '3.0'}" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>EPUB 테스트</dc:title><dc:creator>테스터</dc:creator><dc:language>ko</dc:language>${metadata}
        </metadata>
        <manifest>
          <item id="chapter" href="chapter.xhtml" media-type="${options.chapterMediaType ?? 'application/xhtml+xml'}"/>
          <item id="cover-image" href="images/cover.png" media-type="image/png"${coverMode === 'epub3' ? ' properties="cover-image"' : ''}/>
          ${coverMode === 'guide' ? '<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>' : ''}
          ${options.navTitle ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
          ${options.manifestExtra ?? ''}
        </manifest>
        <spine${options.version === '2.0' ? ' toc="ncx"' : ''}><itemref idref="chapter"/></spine>
        ${coverMode === 'guide' ? '<guide><reference type="cover" href="cover.xhtml"/></guide>' : ''}
      </package>`),
  );
  const chapterSource = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>첫 장</title></head><body>
      ${
        options.body ??
        '<h1>첫 장</h1><p>문장 <strong>하나</strong>와 <em>강조</em>.</p><blockquote><p>인용문</p></blockquote><ul><li>항목</li></ul><img src="images/cover.png" alt="표지"/><p><a href="chapter.xhtml#end">내부 링크</a></p>'
      }
    </body></html>`;
  await writer.add(
    'OEBPS/chapter.xhtml',
    options.chapterBytes ? new Uint8ArrayReader(options.chapterBytes) : new TextReader(chapterSource),
  );
  await writer.add('OEBPS/images/cover.png', new Uint8ArrayReader(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])));
  if (coverMode === 'guide') {
    await writer.add(
      'OEBPS/cover.xhtml',
      new TextReader(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/cover.png" alt="표지"/></body></html>',
      ),
    );
  }
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

async function duplicateImageRecoveryFixture(options: { secondReference?: string } = {}): Promise<Blob> {
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
    new TextReader(`<?xml version="1.0"?>
      <package version="3.0" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>복구 EPUB</dc:title></metadata>
        <manifest>
          <item id="image_0" href="image_0000.png" media-type="image/png"/>
          <item id="image_1" href="image_0000.png" media-type="image/png"/>
          <item id="chapter_0" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
          <item id="chapter_1" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        </manifest>
        <spine><itemref idref="nav"/><itemref idref="chapter_0"/><itemref idref="chapter_1"/></spine>
      </package>`),
  );
  await writer.add('OEBPS/image_0000.png', new Uint8ArrayReader(new Uint8Array([1, 2, 3, 4])));
  await writer.add('OEBPS/image_9999.png', new Uint8ArrayReader(new Uint8Array([5, 6, 7, 8])));
  await writer.add(
    'OEBPS/chapter-1.xhtml',
    new TextReader(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>첫 화</title></head><body><h1>첫 화</h1><img src="images/image_0000.png"/></body></html>',
    ),
  );
  await writer.add(
    'OEBPS/chapter-2.xhtml',
    new TextReader(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>두 번째 화</title></head><body><h1>두 번째 화</h1><img src="${options.secondReference ?? 'images/image_0000.png'}"/></body></html>`,
    ),
  );
  await writer.add(
    'OEBPS/nav.xhtml',
    new TextReader(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>목차</title></head><body><h2>목차</h2><nav><ol><li><a href="chapter-1.xhtml">목차 첫 화</a></li><li><a href="chapter-2.xhtml">목차 두 번째 화</a></li></ol></nav></body></html>',
    ),
  );
  return renameFixtureArchiveEntry(await writer.close(), 'OEBPS/image_9999.png', 'OEBPS/image_0000.png');
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
      body: '<h1>삽화 장</h1><p>삽화 앞 문장</p><p><img src="images/illustration.png" alt="삽화"/></p>',
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
    expect(parsed.embeddedAssets?.map((asset) => asset.kind)).toEqual(['epub_resource', 'epub_resource', 'cover']);
  });

  it('recovers ordered duplicate images with unique manifest ids and excludes a nav-only spine item', async () => {
    const source = await duplicateImageRecoveryFixture();
    const document = await parseEpub(source);

    expect(document.sections.map((section) => section.title)).toEqual(['목차 첫 화', '목차 두 번째 화']);
    expect(document.resources).toHaveLength(2);
    expect(new Set(document.resources.map((resource) => resource.href)).size).toBe(2);
    expect(document.resources.map((resource) => [...resource.bytes])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    const imageHrefs = document.sections.flatMap((section) =>
      section.blocks.filter((block) => block.kind === 'image').map((block) => block.resourceHref),
    );
    expect(imageHrefs).toEqual(document.resources.map((resource) => resource.href));

    const parsed = materializeEpubImport(document, {
      fileName: 'recovered.epub',
      sourceBytes: new Uint8Array(await source.arrayBuffer()),
      now: '2026-09-01T00:00:00.000Z',
    });
    const imageAssets = parsed.embeddedAssets?.filter((asset) => asset.kind === 'epub_resource') ?? [];
    expect(parsed.novel.totalChapters).toBe(2);
    expect(imageAssets).toHaveLength(2);
    expect(new Set(imageAssets.map((asset) => asset.id)).size).toBe(2);
  });

  it('rejects duplicate image recovery when body references do not exactly follow the manifest order', async () => {
    await expect(
      parseEpub(await duplicateImageRecoveryFixture({ secondReference: 'images/image_0001.png' })),
    ).rejects.toMatchObject({
      code: 'invalid_archive',
      message: expect.stringContaining('본문 참조 순서'),
    });
  });

  it('continues to reject duplicate non-image archive paths', async () => {
    const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
    await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
    await writer.add(
      'META-INF/container.xml',
      new TextReader(
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      ),
    );
    await writer.add(
      'OEBPS/content.opf',
      new TextReader(
        '<package><metadata/><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      ),
    );
    await writer.add('OEBPS/chapter.xhtml', new TextReader('<html><body><p>첫 본문</p></body></html>'));
    await writer.add('OEBPS/chaptfr.xhtml', new TextReader('<html><body><p>중복 본문</p></body></html>'));
    const source = await renameFixtureArchiveEntry(await writer.close(), 'OEBPS/chaptfr.xhtml', 'OEBPS/chapter.xhtml');
    await expect(parseEpub(source)).rejects.toMatchObject({
      code: 'invalid_archive',
      message: expect.stringContaining('중복 archive 경로'),
    });
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

  it('recovers common EPUB2 XHTML entities and HTML syntax without weakening package XML validation', async () => {
    const source = await epubFixture({
      version: '2.0',
      body: '<p>&nbsp;</p><p>본문&nbsp;문장 &copy;</p><p>줄 하나<br>줄 둘</p>',
    });
    const document = await parseEpub(source);

    expect(document.sections[0].blocks.map((block) => block.plainText)).toEqual(['본문\u00a0문장 ©', '줄 하나\n줄 둘']);
  });

  it('decodes BOM-marked UTF-16 content and normalizes non-canonical manifest media type casing', async () => {
    const chapter =
      '<?xml version="1.0" encoding="utf-16"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>UTF-16</title></head><body><h1>인코딩 장</h1><p>유니코드 본문</p></body></html>';
    const document = await parseEpub(
      await epubFixture({
        chapterBytes: utf16Le(chapter),
        chapterMediaType: 'Application/XHTML+XML; charset=UTF-16',
      }),
    );

    expect(document.sections[0]).toMatchObject({
      title: '인코딩 장',
      blocks: [{ plainText: '인코딩 장' }, { plainText: '유니코드 본문' }],
    });
  });

  it('recognizes EPUB2 metadata and guide cover declarations', async () => {
    const metadataCover = await parseEpub(await epubFixture({ version: '2.0', coverMode: 'epub2-meta' }));
    const guideCover = await parseEpub(await epubFixture({ version: '2.0', coverMode: 'guide' }));

    expect(metadataCover.coverHref).toBe('OEBPS/images/cover.png');
    expect(guideCover.coverHref).toBe('OEBPS/images/cover.png');
    expect(metadataCover.resources.some((resource) => resource.href === metadataCover.coverHref)).toBe(true);
    expect(guideCover.resources.some((resource) => resource.href === guideCover.coverHref)).toBe(true);

    const source = await epubFixture({ version: '2.0', coverMode: 'epub2-meta', body: '<p>표지 확인 본문</p>' });
    const parsed = materializeEpubImport(await parseEpub(source), {
      fileName: 'legacy-cover.epub',
      sourceBytes: new Uint8Array(await source.arrayBuffer()),
      now: '2026-08-21T00:00:00.000Z',
    });
    expect(parsed.novel.coverAssetId).toBeDefined();
    expect(parsed.embeddedAssets?.some((asset) => asset.id === parsed.novel.coverAssetId)).toBe(true);
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
