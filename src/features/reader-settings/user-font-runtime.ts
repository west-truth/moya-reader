import type { UserFontAsset } from '../../domain/types';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';

const loadedFonts = new Map<string, { hash: string; face: FontFace; url: string; family: string }>();

export async function loadUserFont(
  repository: ReaderPersonalizationRepository | undefined,
  asset: UserFontAsset | undefined,
): Promise<string | undefined> {
  if (!repository || !asset || typeof FontFace === 'undefined' || !globalThis.document?.fonts) return undefined;
  const existing = loadedFonts.get(asset.id);
  if (existing?.hash === asset.contentHash) return `"${existing.family}"`;
  if (existing) unloadUserFont(asset.id);
  const blob = await repository.getUserFontContent(asset.id);
  if (!blob) throw new Error('font_content_missing');
  const url = URL.createObjectURL(blob);
  const family = `NovelDesk User ${asset.id}`;
  const face = new FontFace(family, `url("${url}")`, { style: asset.style, weight: String(asset.weight) });
  try {
    await face.load();
    document.fonts.add(face);
    loadedFonts.set(asset.id, { hash: asset.contentHash, face, url, family });
    return `"${family}"`;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function unloadUserFont(id: string): void {
  const loaded = loadedFonts.get(id);
  if (!loaded) return;
  document.fonts.delete(loaded.face);
  URL.revokeObjectURL(loaded.url);
  loadedFonts.delete(id);
}

export function builtinFontFamily(fontId: string): string | undefined {
  if (fontId === 'builtin-sans') return 'var(--font-sans)';
  if (fontId === 'builtin-mono') return 'var(--font-mono)';
  if (fontId === 'builtin-serif') return 'var(--font-serif)';
  return undefined;
}
