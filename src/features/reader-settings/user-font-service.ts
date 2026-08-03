import type { UserFontAsset, UserFontContentType } from '../../domain/types';
import { sha256 } from '../../domain/hash';
import { persistentId128 } from '../../domain/id-hash-contract';

export const MAX_USER_FONT_BYTES = 10 * 1024 * 1024;

interface DetectedFont {
  readonly contentType: UserFontContentType;
  readonly extension: string;
  readonly format: string;
}

function detectFont(bytes: Uint8Array): DetectedFont | undefined {
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  if (signature === 'wOF2') return { contentType: 'font/woff2', extension: 'woff2', format: 'woff2' };
  if (signature === 'wOFF') return { contentType: 'font/woff', extension: 'woff', format: 'woff' };
  if (signature === 'OTTO') return { contentType: 'font/otf', extension: 'otf', format: 'opentype' };
  if (signature === '\u0000\u0001\u0000\u0000' || signature === 'true') {
    return { contentType: 'font/ttf', extension: 'ttf', format: 'truetype' };
  }
  return undefined;
}

function defaultFamilyLabel(fileName: string): string {
  return (
    fileName
      .replace(/\.(woff2?|ttf|otf)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim() || '사용자 글꼴'
  );
}

export async function prepareUserFont(file: File): Promise<{ asset: UserFontAsset; blob: Blob }> {
  if (!file.size || file.size > MAX_USER_FONT_BYTES) throw new Error('font_size_invalid');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectFont(bytes);
  if (!detected) throw new Error('font_format_invalid');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension && extension !== detected.extension) throw new Error('font_extension_mismatch');
  const rawHash = await sha256(bytes.buffer);
  const contentHash = rawHash.startsWith('sha256:') ? rawHash : `sha256:${rawHash}`;
  const now = new Date().toISOString();
  const id = persistentId128('user_font_asset', [contentHash]);
  return {
    asset: {
      id,
      familyLabel: defaultFamilyLabel(file.name),
      fileName: file.name,
      style: /italic|oblique/i.test(file.name) ? 'italic' : 'normal',
      weight: /bold|700/i.test(file.name) ? 700 : 400,
      contentHash,
      contentType: detected.contentType,
      byteLength: file.size,
      storageKey: `user-font:${id}`,
      createdAt: now,
      updatedAt: now,
    },
    blob: new Blob([bytes], { type: detected.contentType }),
  };
}

export async function verifyFontCanLoad(asset: UserFontAsset, blob: Blob): Promise<void> {
  if (typeof FontFace === 'undefined' || !globalThis.document?.fonts) return;
  const url = URL.createObjectURL(blob);
  const family = `NovelDesk validation ${asset.id}`;
  const face = new FontFace(family, `url("${url}")`, { style: asset.style, weight: String(asset.weight) });
  try {
    await face.load();
  } finally {
    URL.revokeObjectURL(url);
  }
}
