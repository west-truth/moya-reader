import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MOYA_PACKAGE_LIMITS } from '@noveldesk/extension-contracts/package';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';
import {
  repositoryUrl,
  validateRepositoryIndex,
  type RepositoryEntry,
} from '../../src/extensions/packages/repository-contract';
import { boundedFile } from './project';

/** Build metadata from verified archive bytes, never a hand-entered version/hash or executed guest. */
export async function buildRepositoryIndex(folder: string, publicIndexUrl: string, name?: string) {
  const url = repositoryUrl(publicIndexUrl);
  const files = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.name.endsWith('.moyaext'));
  if (!files.length || files.length > 256) throw new Error('repository_package_count');
  const packages: RepositoryEntry[] = [];
  const ids = new Set<string>();
  for (const file of files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!file.isFile()) throw new Error('repository_archive_not_file');
    const bytes = await boundedFile(resolve(folder, file.name), MOYA_PACKAGE_LIMITS.archiveBytes);
    const pkg = await verifyMoyaExtension(new Blob([new Uint8Array(bytes)]));
    const { id, version, name: packageName } = pkg.manifest.extension;
    if (ids.has(id)) throw new Error('repository_duplicate_package');
    ids.add(id);
    if (pkg.manifest.updates && repositoryUrl(pkg.manifest.updates.repository) !== url)
      throw new Error('repository_update_url_mismatch');
    packages.push({
      id,
      version,
      name: packageName,
      archive: './' + encodeURIComponent(file.name),
      sha256: pkg.digest,
    });
  }
  return validateRepositoryIndex(
    { format: 'moya.extension.repository', version: 1, ...(name ? { name } : {}), packages },
    url,
  );
}
