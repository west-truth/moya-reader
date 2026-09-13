export type CompatibilityFormat = 'tachiyomi-apk' | 'mangayomi-js' | 'mangayomi-dart';
export interface MangayomiEntry {
  id: string;
  name: string;
  lang: string;
  version: string;
  baseUrl: string;
  apiUrl?: string;
  dateFormat?: string;
  dateFormatLocale?: string;
  typeSource?: string;
  isManga?: boolean;
  sourceCodeUrl: string;
  format: 'mangayomi-js' | 'mangayomi-dart';
  isNsfw: boolean;
  appMinVerReq?: string;
  hasCloudflare: boolean;
}
export function detectCompatibilityRepository(value: unknown): 'tachiyomi-apk' | 'mangayomi' | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const apk = value.every(
    (row) => row && typeof row.pkg === 'string' && typeof row.apk === 'string' && Array.isArray(row.sources),
  );
  const mg = value.every(
    (row) => row && typeof row.sourceCodeUrl === 'string' && typeof row.sourceCodeLanguage === 'number',
  );
  return apk === mg ? undefined : apk ? 'tachiyomi-apk' : 'mangayomi';
}
export function compatibilityRepositoryUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('compatibility_repository_invalid');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error('compatibility_repository_invalid');
  if (!url.pathname.endsWith('.json')) url.pathname = url.pathname.replace(/\/$/, '') + '/index.min.json';
  return url.href;
}
export function parseMangayomiIndex(value: unknown): MangayomiEntry[] {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    (value.length && detectCompatibilityRepository(value) !== 'mangayomi')
  )
    throw new Error('compatibility_repository_mismatch');
  const ids = new Set<string>();
  return value.map((row) => {
    if (typeof row.id === 'number' && !Number.isSafeInteger(row.id))
      throw new Error('compatibility_repository_invalid');
    const id = String(row.id);
    if (
      !/^\d{1,19}$/.test(id) ||
      ids.has(id) ||
      ![0, 1].includes(row.sourceCodeLanguage) ||
      !['name', 'lang', 'version', 'baseUrl', 'sourceCodeUrl'].every(
        (key) => typeof row[key] === 'string' && row[key].length > 0 && row[key].length < 2048,
      ) ||
      (row.itemType !== undefined && row.itemType !== 0) ||
      row.isManga === false
    )
      throw new Error('compatibility_repository_invalid');
    ids.add(id);
    const code = new URL(row.sourceCodeUrl),
      site = new URL(row.baseUrl);
    if (
      code.protocol !== 'https:' ||
      code.username ||
      code.password ||
      code.hash ||
      !['https:', 'http:'].includes(site.protocol) ||
      site.username ||
      site.password
    )
      throw new Error('compatibility_repository_invalid');
    return {
      id,
      name: row.name,
      lang: row.lang,
      version: row.version,
      baseUrl: site.href.replace(/\/$/, ''),
      ...Object.fromEntries(
        ['apiUrl', 'dateFormat', 'dateFormatLocale', 'typeSource'].flatMap((key) =>
          typeof row[key] === 'string' && row[key].length <= 2048 ? [[key, row[key]]] : [],
        ),
      ),
      isManga: true,
      sourceCodeUrl: code.href,
      format: row.sourceCodeLanguage === 1 ? 'mangayomi-js' : 'mangayomi-dart',
      isNsfw: row.isNsfw === true,
      hasCloudflare: row.hasCloudflare === true,
      ...(typeof row.appMinVerReq === 'string' ? { appMinVerReq: row.appMinVerReq } : {}),
    };
  });
}
