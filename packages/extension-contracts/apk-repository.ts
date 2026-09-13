/** Shared Tachiyomi/Mihon/Aniyomi manga index contract. APKs remain host-owned executable code. */
import { detectCompatibilityRepository } from './compatibility-repository.js';
export interface MangaApkSource {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  readonly baseUrl?: string;
}
export interface MangaApkEntry {
  readonly pkg: string;
  readonly name: string;
  readonly apk: string;
  readonly version: string;
  readonly code: number;
  readonly lang: string;
  readonly nsfw: boolean;
  readonly sources: readonly MangaApkSource[];
  readonly excludedSources: number;
}
export interface MangaApkIndex {
  readonly entries: readonly MangaApkEntry[];
  readonly excludedEntries: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const short = (value: unknown, max = 512): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32);
export function mangaApkRepositoryUrl(value: string): string {
  const url = new URL(value.trim());
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('apk_repository_invalid');
  if (!url.pathname.endsWith('/index.min.json')) url.pathname = url.pathname.replace(/\/$/, '') + '/index.min.json';
  return url.href;
}

/** Reject ambiguous IDs and paths before network requests. Keep 64-bit source IDs as decimal strings. */
export function parseMangaApkIndex(value: unknown): MangaApkIndex {
  if (detectCompatibilityRepository(value) === 'mangayomi') throw new Error('compatibility_repository_mismatch');
  if (!Array.isArray(value) || value.length > 10000) throw new Error('apk_repository_invalid');
  const entries: MangaApkEntry[] = [];
  const packages = new Set<string>();
  let excludedEntries = 0;
  for (const row of value) {
    if (
      !object(row) ||
      !short(row.pkg, 256) ||
      !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(row.pkg) ||
      packages.has(row.pkg) ||
      !short(row.name) ||
      !short(row.lang, 32) ||
      !short(row.version, 64) ||
      !Number.isSafeInteger(row.code) ||
      (row.code as number) < 1 ||
      !short(row.apk, 256) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.apk$/.test(row.apk) ||
      row.apk.includes('..') ||
      ![0, 1].includes(row.nsfw as number) ||
      !Array.isArray(row.sources) ||
      row.sources.length > 1000
    )
      throw new Error('apk_repository_invalid');
    packages.add(row.pkg);
    const sources: MangaApkSource[] = [];
    const ids = new Set<string>();
    const excludedSources = 0;
    for (const source of row.sources) {
      if (
        !object(source) ||
        !short(source.id, 19) ||
        !/^[1-9]\d*$/.test(source.id) ||
        BigInt(source.id) > 9223372036854775807n ||
        ids.has(source.id) ||
        !short(source.name) ||
        !short(source.lang, 32)
      )
        throw new Error('apk_repository_invalid');
      ids.add(source.id);
      if (source.baseUrl !== undefined) {
        if (!short(source.baseUrl, 2048)) throw new Error('apk_repository_invalid');
        const origin = new URL(source.baseUrl);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
          throw new Error('apk_repository_invalid');
      }
      sources.push({
        id: source.id,
        name: source.name,
        lang: source.lang,
        ...(source.baseUrl ? { baseUrl: source.baseUrl as string } : {}),
      });
    }
    if (!sources.length) {
      excludedEntries++;
      continue;
    }
    entries.push({
      pkg: row.pkg,
      name: row.name,
      apk: row.apk,
      lang: row.lang,
      version: row.version,
      code: row.code as number,
      nsfw: row.nsfw === 1,
      sources,
      excludedSources,
    });
  }
  return { entries, excludedEntries };
}

export function mangaApkDownloadUrl(repository: string, entry: MangaApkEntry): string {
  parseMangaApkIndex([{ ...entry, nsfw: entry.nsfw ? 1 : 0 }]);
  return new URL(`apk/${entry.apk}`, mangaApkRepositoryUrl(repository)).href;
}
