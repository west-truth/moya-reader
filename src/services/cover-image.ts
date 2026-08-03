import { integrityHash } from '../domain/id-hash-contract';
import type { BookCoverAssetInput } from '../repositories/book-asset-repository';
import { detectCoverContentType } from '@noveldesk/text-core/image-format';

export { detectCoverContentType } from '@noveldesk/text-core/image-format';

export const MAX_COVER_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_COVER_WIDTH = 1_200;
export const MAX_COVER_HEIGHT = 1_800;

type CoverContentType = BookCoverAssetInput['contentType'];

interface DecodedCover {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close?(): void;
}

export interface CoverImageAdapter {
  decode(blob: Blob): Promise<DecodedCover>;
  encode(source: CanvasImageSource, width: number, height: number, contentType: CoverContentType): Promise<Blob>;
}

export interface NormalizeCoverOptions {
  readonly fit?: 'crop' | 'contain';
  readonly positionX?: number;
  readonly positionY?: number;
}

export function boundedCoverDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('표지 이미지 크기를 확인할 수 없습니다.');
  }
  const scale = Math.min(1, MAX_COVER_WIDTH / width, MAX_COVER_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function defaultDecode(blob: Blob): Promise<DecodedCover> {
  if (typeof createImageBitmap !== 'function') throw new Error('이 환경에서는 표지 이미지를 처리할 수 없습니다.');
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
}

async function defaultEncode(
  source: CanvasImageSource,
  width: number,
  height: number,
  contentType: CoverContentType,
): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('이 환경에서는 표지 이미지를 처리할 수 없습니다.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('표지 이미지 canvas를 만들 수 없습니다.');
  context.drawImage(source, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('표지 이미지를 저장 형식으로 변환하지 못했습니다.'))),
      contentType,
      contentType === 'image/jpeg' || contentType === 'image/webp' ? 0.9 : undefined,
    );
  });
}

const browserAdapter: CoverImageAdapter = { decode: defaultDecode, encode: defaultEncode };

export async function normalizeCoverImage(
  file: File,
  options: NormalizeCoverOptions = {},
  adapter: CoverImageAdapter = browserAdapter,
): Promise<BookCoverAssetInput> {
  if (file.size <= 0 || file.size > MAX_COVER_INPUT_BYTES) {
    throw new Error('표지 이미지는 10MiB 이하여야 합니다.');
  }
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const contentType = detectCoverContentType(header);
  if (!contentType) throw new Error('JPEG, PNG, WebP 표지만 사용할 수 있습니다.');
  let decoded: DecodedCover | undefined;
  try {
    decoded = await adapter.decode(file);
    const dimensions = boundedCoverDimensions(decoded.width, decoded.height);
    const blob = await adapter.encode(decoded.source, dimensions.width, dimensions.height, contentType);
    const bytes = await blob.arrayBuffer();
    return {
      blob,
      fileName: file.name,
      contentType,
      contentHash: integrityHash(bytes),
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      fit: options.fit ?? 'crop',
      positionX: Math.max(0, Math.min(100, options.positionX ?? 50)),
      positionY: Math.max(0, Math.min(100, options.positionY ?? 50)),
    };
  } catch (error) {
    if (error instanceof Error && error.message) throw error;
    const symptom = new Error('표지 이미지를 해석하지 못했습니다.') as Error & { cause?: unknown };
    symptom.cause = error;
    throw symptom;
  } finally {
    decoded?.close?.();
  }
}
