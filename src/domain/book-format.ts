import type { BookFormat, Novel } from './types';

export function isFixedDocumentFormat(format: BookFormat | undefined): boolean {
  return format === 'pdf' || format === 'image_archive';
}

export function bookUnitLabel(novel: Novel): string {
  return isFixedDocumentFormat(novel.format) ? '페이지' : '화';
}

export function bookFormatLabel(novel: Novel): string {
  if (novel.format === 'image_archive') {
    if (/\.cbz$/i.test(novel.sourceFileName)) return 'CBZ';
    if (/\.cbr$/i.test(novel.sourceFileName)) return 'CBR';
    if (/\.cb7$/i.test(novel.sourceFileName)) return 'CB7';
    if (/\.rar$/i.test(novel.sourceFileName)) return 'RAR';
    if (/\.7z$/i.test(novel.sourceFileName)) return '7Z';
    return 'IMAGE ZIP';
  }
  return novel.format?.toUpperCase() ?? novel.sourceFileName.split('.').pop()?.toUpperCase() ?? 'TEXT';
}
