import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

export function pdfFixture() {
  const text = 'BT /F1 24 Tf 72 720 Td (Moya PDF proof) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export async function epubFixture() {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, value] of Object.entries({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    'book.opf':
      '<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Moya EPUB proof</dc:title><dc:language>en</dc:language></metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>',
    'chapter.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First chapter</h1><p>Embedded EPUB reading works.</p></body></html>',
  }))
    await writer.add(name, new TextReader(value), { level: 0 });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}
