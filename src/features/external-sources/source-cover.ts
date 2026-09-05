import { integrityHash } from '@noveldesk/text-core/hash';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';

export const MAX_SOURCE_COVER_BYTES = 8 * 1024 * 1024;
const SOURCE_COVER_TIMEOUT_MS = 5_000;

export function sourceCoverContentType(value: string): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  const normalized = value.split(';')[0]?.trim().toLocaleLowerCase();
  if (normalized === 'image/jpg' || normalized === 'image/jpeg') return 'image/jpeg';
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  return undefined;
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function downloadSourceCover(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Blob> {
  const request = new AbortController();
  const abort = () => request.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(
    () => request.abort(new DOMException('원격 표지 요청 시간이 초과되었습니다.', 'TimeoutError')),
    timeoutMs,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    request.signal.throwIfAborted();
    const response = await withSignal(fetch(url, { signal: request.signal }), request.signal);
    reader = response.body?.getReader();
    if (!response.ok) throw new Error(`표지 요청에 실패했습니다. (HTTP ${response.status})`);
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_COVER_BYTES) {
      throw new Error('원격 표지 크기가 안전 한도를 초과했습니다.');
    }
    const contentType = sourceCoverContentType(response.headers.get('Content-Type') || '');
    if (!contentType || !reader) throw new Error('지원하지 않는 원격 표지 형식입니다.');
    const chunks: ArrayBuffer[] = [];
    let bytes = 0;
    for (;;) {
      const result = await withSignal(reader.read(), request.signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_SOURCE_COVER_BYTES) throw new Error('원격 표지 크기가 안전 한도를 초과했습니다.');
      chunks.push(Uint8Array.from(result.value).buffer);
    }
    request.signal.throwIfAborted();
    if (bytes === 0) throw new Error('지원하지 않는 원격 표지 형식입니다.');
    completed = true;
    return new Blob(chunks, { type: contentType });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (!completed) {
      request.abort();
      void reader?.cancel(request.signal.reason).catch(() => undefined);
    }
    reader?.releaseLock();
  }
}

export async function persistSourceCover(
  assets: BookAssetRepository | undefined,
  novel: Novel,
  thumbnailUrl: string | undefined,
  signal?: AbortSignal,
  options: { readonly timeoutMs?: number } = {},
): Promise<boolean> {
  if (!thumbnailUrl) return false;
  signal?.throwIfAborted();
  if (!assets?.saveApprovedEnrichmentCover) {
    throw new Error('원격 표지를 저장할 기능을 찾지 못했습니다. Moya Web과 서버를 함께 업데이트해 주세요.');
  }
  // Asset operations have no cancellation API; check before starting each mutation.
  const active = await assets.getActiveCover(novel.id);
  signal?.throwIfAborted();
  if (
    active &&
    active.metadata.provenance !== 'archive_embedded' &&
    active.metadata.provenance !== 'generated_preview'
  ) {
    return false;
  }
  const blob = await downloadSourceCover(thumbnailUrl, signal, options.timeoutMs ?? SOURCE_COVER_TIMEOUT_MS);
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  const pixelWidth = bitmap.width;
  const pixelHeight = bitmap.height;
  bitmap.close();
  signal?.throwIfAborted();
  if (pixelWidth < 1 || pixelHeight < 1) throw new Error('원격 표지 크기를 확인하지 못했습니다.');
  // Hosted cover uploads require the current tagged integrity-hash contract.
  const contentHash = integrityHash(await blob.arrayBuffer());
  const contentType = sourceCoverContentType(blob.type)!;
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  signal?.throwIfAborted();
  await assets.saveApprovedEnrichmentCover(novel.id, {
    blob,
    fileName: `${novel.title}.${extension}`,
    contentType,
    contentHash,
    pixelWidth,
    pixelHeight,
    fit: 'crop',
    positionX: 50,
    positionY: 50,
    expectedMetadataRevision: novel.metadataRevision ?? 0,
  });
  return true;
}
