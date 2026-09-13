import { detectCompatibilityRepository } from '../../../packages/extension-contracts/compatibility-repository';
export interface RepositoryEntry {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly sha256: string;
  readonly name?: string;
  readonly description?: string;
}
export interface RepositoryIndex {
  readonly format: 'moya.extension.repository';
  readonly version: 1;
  readonly name?: string;
  readonly packages: readonly RepositoryEntry[];
}
export interface RepositoryRecord {
  readonly url: string;
  readonly revision: number;
  /** Missing index is a removal tombstone, fencing an earlier refresh. */
  readonly index?: RepositoryIndex;
  readonly checkedAt?: string;
}
export function repositoryUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_package_repository');
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost')
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error('invalid_package_repository');
  }
}
export function validateRepositoryIndex(value: unknown, url: string): RepositoryIndex {
  if (detectCompatibilityRepository(value) === 'mangayomi') throw new Error('package_repository_mangayomi');
  const origin = new URL(repositoryUrl(url)).origin;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.pkg === 'string' &&
        typeof entry.apk === 'string' &&
        entry.apk.endsWith('.apk') &&
        Array.isArray(entry.sources),
    )
  )
    throw new Error('package_repository_suwayomi');
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const label = (v: unknown, limit: number) => v === undefined || (typeof v === 'string' && v.length <= limit);
  if (
    !object(value) ||
    value.format !== 'moya.extension.repository' ||
    value.version !== 1 ||
    !Array.isArray(value.packages) ||
    value.packages.length > 256 ||
    !label(value.name, 120) ||
    Object.keys(value).some((key) => !['format', 'version', 'name', 'packages'].includes(key))
  )
    throw new Error('invalid_package_repository');
  const ids = new Set<string>();
  for (const entry of value.packages) {
    if (
      !object(entry) ||
      Object.keys(entry).some((key) => !['id', 'version', 'archive', 'sha256', 'name', 'description'].includes(key)) ||
      typeof entry.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{1,254}$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.version !== 'string' ||
      !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(
        entry.version,
      ) ||
      entry.version.length > 96 ||
      entry.version
        .split('-')
        .slice(1)
        .join('-')
        .split('.')
        .some((part) => /^0\d+$/.test(part)) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.archive !== 'string' ||
      !entry.archive ||
      entry.archive.length > 2048 ||
      !label(entry.name, 120) ||
      !label(entry.description, 500)
    )
      throw new Error('invalid_package_repository');
    ids.add(entry.id);
    const archive = new URL(entry.archive, url);
    if (archive.origin !== origin || archive.username || archive.password || archive.hash)
      throw new Error('package_repository_origin_denied');
  }
  return value as unknown as RepositoryIndex;
}
