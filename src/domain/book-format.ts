import type { BookFormat, Novel } from './types';

export function isFixedDocumentFormat(format: BookFormat | undefined): boolean {
  return format === 'pdf' || format === 'image_archive';
}

export function bookUnitLabel(novel: Novel): string {
  return isFixedDocumentFormat(novel.format) ? '페이지' : '화';
}

export function bookFormatLabel(novel: Novel): string {
  // A TXT series is stored in a portable ZIP container, but remains text to the reader.
  if (novel.format === 'txt' && (novel.documentSectionCount ?? 0) > 0) return 'TXT';
  const extension = novel.sourceFileName
    .split(/[\\/]/u)
    .at(-1)
    ?.match(/\.([^.]+)$/u)?.[1]
    ?.trim()
    .toUpperCase();
  if (extension) return extension;
  return novel.format === 'image_archive' ? 'ARCHIVE' : (novel.format?.toUpperCase() ?? 'TEXT');
}
