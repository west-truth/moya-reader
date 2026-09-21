/** A small active source index. Original files remain independent source_part assets. */
export const LOCAL_ARCHIVE_SERIES_TYPE = 'application/vnd.moya.local-archive-series+json';
export interface LocalArchiveSeries {
  version: 1;
  bookId: string;
  format: 'epub' | 'image_archive';
  sources: Array<{ assetId: string; fileName: string; contentHash: string; byteLength: number; contentType: string }>;
}
export function isLocalArchiveSeries(value: unknown): value is LocalArchiveSeries {
  if (!value || typeof value !== 'object') return false;
  const v = value as LocalArchiveSeries;
  return (
    v.version === 1 &&
    typeof v.bookId === 'string' &&
    ['epub', 'image_archive'].includes(v.format) &&
    Array.isArray(v.sources) &&
    v.sources.length > 0 &&
    v.sources.length <= 2000 &&
    new Set(v.sources.map((s) => s?.assetId)).size === v.sources.length &&
    v.sources.every(
      (s) =>
        s &&
        typeof s.assetId === 'string' &&
        s.assetId.length <= 160 &&
        typeof s.fileName === 'string' &&
        s.fileName.length <= 512 &&
        typeof s.contentType === 'string' &&
        typeof s.contentHash === 'string' &&
        /^sha256:[a-f0-9]{64}$/u.test(s.contentHash) &&
        Number.isSafeInteger(s.byteLength) &&
        s.byteLength > 0 &&
        s.byteLength <= 4 * 1024 ** 3,
    )
  );
}
