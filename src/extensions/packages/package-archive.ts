import { BlobReader, ZipReader, type FileEntry } from '@zip.js/zip.js';
import {
  isMoyaPackagePath,
  MOYA_PACKAGE_LIMITS,
  validateMoyaPackageManifest,
  type MoyaPackageManifestV1,
} from '@noveldesk/extension-contracts/package';

export class MoyaPackageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MoyaPackageError';
  }
}

export interface VerifiedMoyaPackage {
  readonly digest: string;
  readonly manifest: MoyaPackageManifestV1;
  readonly publisherFingerprint?: string;
  readonly source: string;
  readonly archive: Blob;
}

interface IntegrityFile {
  path: string;
  sha256: string;
  size: number;
}
export const INTEGRITY_DOMAIN = 'moya.extension.package/integrity/v1\n';

export async function packageSha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalIntegrity(files: readonly IntegrityFile[]): string {
  return `${JSON.stringify({ schemaVersion: 1, files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(({ path, sha256, size }) => ({ path, sha256, size })) })}\n`;
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MoyaPackageError('invalid_package_encoding');
  }
}

function metadata(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length > MOYA_PACKAGE_LIMITS.manifestBytes) throw new MoyaPackageError('package_limit');
  const value: unknown = JSON.parse(text(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MoyaPackageError('invalid_package_metadata');
  return value as Record<string, unknown>;
}

function allowedFile(path: string): boolean {
  return (
    [
      'manifest.json',
      'integrity.json',
      'signatures/publisher.json',
      'dist/main.js',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ].includes(path) || /^assets\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(path)
  );
}

async function readEntry(entry: FileEntry, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > max)
    throw new MoyaPackageError('package_limit');
  const chunks: Uint8Array[] = [];
  let size = 0;
  await entry.getData(
    new WritableStream<Uint8Array>({
      write(chunk) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > max || size > entry.uncompressedSize) throw new MoyaPackageError('package_limit');
        chunks.push(chunk.slice());
      },
    }),
    { signal, checkSignature: true, useWebWorkers: false },
  );
  if (size !== entry.uncompressedSize) throw new MoyaPackageError('invalid_package_size');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function verifyPublisher(bytes: Uint8Array, integrity: string): Promise<string> {
  const value = metadata(bytes);
  if (
    Object.keys(value).sort().join(',') !== 'algorithm,publicKey,schemaVersion,signature' ||
    value.schemaVersion !== 1 ||
    value.algorithm !== 'ECDSA-P256-SHA256' ||
    typeof value.publicKey !== 'string' ||
    value.publicKey.length > 512 ||
    typeof value.signature !== 'string' ||
    value.signature.length > 128
  )
    throw new MoyaPackageError('invalid_package_signature');
  const decode = (value: string) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new MoyaPackageError('invalid_package_signature');
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  };
  const publicKey = decode(value.publicKey);
  const signature = decode(value.signature);
  if (signature.length !== 64) throw new MoyaPackageError('invalid_package_signature');
  const key = await crypto.subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ]);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    new TextEncoder().encode(INTEGRITY_DOMAIN + integrity),
  );
  if (!valid) throw new MoyaPackageError('invalid_package_signature');
  return packageSha256(publicKey);
}

/** No code execution, writes, global trust changes or network requests occur during preflight. */
export async function verifyMoyaExtension(archive: Blob, signal?: AbortSignal): Promise<VerifiedMoyaPackage> {
  signal?.throwIfAborted();
  if (archive.size === 0 || archive.size > MOYA_PACKAGE_LIMITS.archiveBytes)
    throw new MoyaPackageError('package_limit');
  const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
  try {
    const files = new Map<string, Uint8Array>();
    const names = new Set<string>();
    let count = 0;
    let expanded = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > MOYA_PACKAGE_LIMITS.entries) throw new MoyaPackageError('package_limit');
      const path = entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename;
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        !isMoyaPackagePath(path) ||
        names.has(path.toLowerCase()) ||
        entry.encrypted ||
        (mode !== 0 && mode !== (entry.directory ? 0x4000 : 0x8000))
      )
        throw new MoyaPackageError('invalid_package_entry');
      names.add(path.toLowerCase());
      if (entry.directory) {
        if (!['dist', 'assets', 'signatures'].includes(path) || entry.uncompressedSize !== 0)
          throw new MoyaPackageError('invalid_package_entry');
        continue;
      }
      if (!allowedFile(path)) throw new MoyaPackageError('invalid_package_entry');
      const maximum = path.endsWith('.json')
        ? MOYA_PACKAGE_LIMITS.manifestBytes
        : path === 'dist/main.js'
          ? MOYA_PACKAGE_LIMITS.entryBytes
          : MOYA_PACKAGE_LIMITS.expandedBytes;
      expanded += entry.uncompressedSize;
      if (expanded > MOYA_PACKAGE_LIMITS.expandedBytes) throw new MoyaPackageError('package_limit');
      files.set(path, await readEntry(entry, Math.min(maximum, MOYA_PACKAGE_LIMITS.expandedBytes), signal));
    }
    for (const required of ['manifest.json', 'integrity.json', 'dist/main.js', 'LICENSE']) {
      if (!files.has(required)) throw new MoyaPackageError('incomplete_package');
    }
    const manifest = validateMoyaPackageManifest(metadata(files.get('manifest.json')!));
    if (!manifest.ok) throw new MoyaPackageError(manifest.code);
    const integrity = metadata(files.get('integrity.json')!);
    if (
      integrity.schemaVersion !== 1 ||
      !Array.isArray(integrity.files) ||
      integrity.files.length > MOYA_PACKAGE_LIMITS.entries
    )
      throw new MoyaPackageError('invalid_package_integrity');
    const expected: IntegrityFile[] = [];
    for (const [path, bytes] of files) {
      if (path === 'integrity.json' || path === 'signatures/publisher.json') continue;
      signal?.throwIfAborted();
      expected.push({ path, sha256: await packageSha256(bytes), size: bytes.length });
    }
    // Exact canonical comparison rejects missing/extra files, duplicate entries, wrong hashes/sizes and hidden fields.
    const canonical = canonicalIntegrity(expected);
    if (text(files.get('integrity.json')!) !== canonical) throw new MoyaPackageError('invalid_package_integrity');
    const publisher = files.get('signatures/publisher.json');
    const publisherFingerprint = publisher ? await verifyPublisher(publisher, canonical) : undefined;
    const digest = await packageSha256(new Uint8Array(await archive.arrayBuffer()));
    signal?.throwIfAborted();
    return {
      digest,
      manifest: manifest.manifest,
      publisherFingerprint,
      source: text(files.get('dist/main.js')!),
      archive,
    };
  } catch (error) {
    if (signal?.aborted) throw new MoyaPackageError('cancelled');
    if (error instanceof MoyaPackageError) throw error;
    throw new MoyaPackageError('invalid_package');
  } finally {
    await reader.close();
  }
}
