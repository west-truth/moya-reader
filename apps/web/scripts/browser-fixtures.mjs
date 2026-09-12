import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';

async function zip(entries) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, value] of entries)
    await writer.add(name, new Uint8ArrayReader(Buffer.isBuffer(value) ? value : Buffer.from(value)), { level: 0 });
  return Buffer.from(await writer.close());
}

export async function syntheticEpub() {
  return zip([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    [
      'book.opf',
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">web-offline-fixture</dc:identifier><dc:title>Offline EPUB</dc:title><dc:language>ko</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    ],
    [
      'chapter.xhtml',
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>EPUB 읽기</title></head><body><h1>제1화 오프라인</h1><p>인터넷 없이 EPUB을 가져오고 읽는 합성 본문입니다.</p><p>원문과 독서 기록을 함께 보관합니다.</p></body></html>',
    ],
    [
      'nav.xhtml',
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>목차</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">제1화 오프라인</a></li></ol></nav></body></html>',
    ],
  ]);
}

export async function syntheticComic(png) {
  return zip([
    ['001.png', png],
    ['002.png', png],
  ]);
}

export function syntheticPdf() {
  const stream = 'BT /F1 20 Tf 30 250 Td (Offline PDF fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
    .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
