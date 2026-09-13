import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { canonicalIntegrity, INTEGRITY_DOMAIN, packageSha256, verifyMoyaExtension } from './package-archive';

/** Authoring helper. No npm scripts, remote dependencies or native payloads are executed. */
export async function buildMoyaExtension(input: {
  manifest: unknown;
  source: string;
  license: string;
  notices?: string;
  assets?: ReadonlyMap<string, Uint8Array>;
  signingKey?: CryptoKeyPair;
}): Promise<Blob> {
  const encode = (value: string) => new TextEncoder().encode(value);
  const files = new Map<string, Uint8Array>([
    ['manifest.json', encode(JSON.stringify(input.manifest))],
    ['dist/main.js', encode(input.source)],
    ['LICENSE', encode(input.license)],
  ]);
  if (input.notices) files.set('THIRD_PARTY_NOTICES.md', encode(input.notices));
  for (const [name, bytes] of input.assets ?? []) files.set(`assets/${name}`, bytes);
  const integrity = canonicalIntegrity(
    await Promise.all(
      [...files].map(async ([path, bytes]) => ({ path, size: bytes.length, sha256: await packageSha256(bytes) })),
    ),
  );
  files.set('integrity.json', encode(integrity));
  if (input.signingKey) {
    const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      input.signingKey.privateKey,
      encode(INTEGRITY_DOMAIN + integrity),
    );
    files.set(
      'signatures/publisher.json',
      encode(
        JSON.stringify({
          schemaVersion: 1,
          algorithm: 'ECDSA-P256-SHA256',
          publicKey: base64(await crypto.subtle.exportKey('spki', input.signingKey.publicKey)),
          signature: base64(signature),
        }),
      ),
    );
  }
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, bytes] of files)
    await writer.add(name, new Uint8ArrayReader(bytes), {
      level: 6,
      lastModDate: new Date(1980, 0, 1),
      extendedTimestamp: false,
    });
  const archive = await writer.close();
  await verifyMoyaExtension(archive);
  return archive;
}
