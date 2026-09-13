import { createSourceBroker } from '@moya/extension-runtime/source-broker';
import { verifyMoyaExtension, type VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive.js';
import { comparePackageVersions } from '../../../../src/extensions/packages/package-installer.js';
import {
  repositoryUrl,
  validateRepositoryIndex,
  type RepositoryEntry,
} from '../../../../src/extensions/packages/repository-contract.js';
import type { SourceTransport } from './source-authentication.js';

function brokerFor(url: string, transport: SourceTransport) {
  const { authenticate: _ignored, ...publicTransport } = transport;
  return createSourceBroker({ origins: [new URL(repositoryUrl(url)).origin], allowDownloads: true }, publicTransport);
}
export async function fetchRepositoryIndex(url: string, signal: AbortSignal, transport: SourceTransport = {}) {
  const broker = brokerFor(url, transport);
  try {
    const response = (await broker.methods['http.request']({ url: repositoryUrl(url), response: 'text' }, signal)) as {
      text: string;
    };
    return validateRepositoryIndex(JSON.parse(response.text), url);
  } finally {
    broker.dispose();
  }
}
/** A cached entry pins the clicked version even when the repository publishes a new index during download. */
export async function fetchRepositoryArchive(
  url: string,
  entry: RepositoryEntry,
  signal: AbortSignal,
  transport: SourceTransport = {},
) {
  validateRepositoryIndex({ format: 'moya.extension.repository', version: 1, packages: [entry] }, url);
  const broker = brokerFor(url, transport);
  try {
    const ref = (await broker.methods['http.request'](
      { url: new URL(entry.archive, url).href, response: 'asset' },
      signal,
    )) as { handle: string; byteLength: number; sha256: string };
    if (ref.byteLength > 10 * 1024 * 1024 || ref.sha256 !== entry.sha256)
      throw new Error('package_repository_integrity');
    const archive = new Blob([Uint8Array.from(broker.takeAsset(ref.handle).bytes)]);
    const candidate = await verifyMoyaExtension(archive, signal);
    if (candidate.manifest.extension.id !== entry.id || candidate.manifest.extension.version !== entry.version)
      throw new Error('package_repository_integrity');
    signal.throwIfAborted();
    return archive;
  } finally {
    broker.dispose();
  }
}
/** Repository requests never receive source credentials or execute candidate code. */
export async function downloadPackageUpdate(
  pkg: VerifiedMoyaPackage,
  signal: AbortSignal,
  transport: SourceTransport = {},
): Promise<Blob | undefined> {
  const repository = pkg.manifest.updates?.repository;
  if (!repository) return undefined;
  const index = await fetchRepositoryIndex(repository, signal, transport);
  const entry = index.packages.find((item) => item.id === pkg.manifest.extension.id);
  if (!entry || comparePackageVersions(entry.version, pkg.manifest.extension.version) <= 0) return undefined;
  const archive = await fetchRepositoryArchive(repository, entry, signal, transport);
  const candidate = await verifyMoyaExtension(archive, signal);
  if (candidate.publisherFingerprint !== pkg.publisherFingerprint) throw new Error('package_update_publisher_mismatch');
  return archive;
}
