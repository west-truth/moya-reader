import { BlobReader, ZipReader } from '@zip.js/zip.js';
import type { ServerConfig } from '../config.js';

export const MAX_LOCAL_ARCHIVE_BYTES = 4 * 1024 ** 3;
export const MAX_LOCAL_ARCHIVE_EXPANDED_BYTES = 8 * 1024 ** 3;

export function localUploadLimit(
  config: Pick<ServerConfig, 'maxUploadBytes' | 'maxArchiveUploadBytes'>,
  fileName: string,
  importMode = 'replace_book',
): number {
  return importMode === 'replace_book' && /\.(epub|zip|cbz)$/i.test(fileName)
    ? Math.min(config.maxArchiveUploadBytes ?? config.maxUploadBytes, MAX_LOCAL_ARCHIVE_BYTES)
    : config.maxUploadBytes;
}

/** Reject large legacy containers before their eager parsers can allocate archive-sized buffers. */
export async function assertLargeArchiveSupported(
  blob: Blob,
  fileName: string,
  legacyLimit: number,
  signal: AbortSignal,
): Promise<void> {
  if (blob.size <= legacyLimit) return;
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (!/\.(epub|zip|cbz)$/i.test(fileName) || signature[0] !== 0x50 || signature[1] !== 0x4b) {
    throw new Error('대용량 가져오기는 EPUB·ZIP·CBZ 파일만 지원합니다.');
  }
  const reader = new ZipReader(new BlobReader(blob), { signal });
  try {
    const entries = await reader.getEntries();
    if (
      entries.some((entry) =>
        /^(moya-comic-source\.cbz|moya-document-series\.json)$/i.test(
          entry.filename.replace(/\\/g, '/').replace(/^\.\//, ''),
        ),
      )
    ) {
      throw new Error('대용량 Moya 내보내기 파일은 아직 복원할 수 없습니다. 일반 EPUB·ZIP·CBZ를 사용해 주세요.');
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
}
