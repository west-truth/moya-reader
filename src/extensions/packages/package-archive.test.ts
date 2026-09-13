import { describe, expect, it } from 'vitest';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { examplePackageManifest } from '../../test/extension-package-fixture';
import { canonicalIntegrity, INTEGRITY_DOMAIN, packageSha256, verifyMoyaExtension } from './package-archive';

async function archive(
  options: {
    tamper?: boolean;
    sign?: boolean;
    wrongKey?: boolean;
    extra?: string;
    symlink?: boolean;
    large?: boolean;
  } = {},
) {
  const source = 'globalThis.moyaExtension=()=>({title:"작품"});';
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(examplePackageManifest()),
    'dist/main.js': source,
    LICENSE: 'MIT',
  };
  const integrity = canonicalIntegrity(
    await Promise.all(
      Object.entries(files).map(async ([path, value]) => {
        const bytes = new TextEncoder().encode(value);
        return { path, sha256: await packageSha256(bytes), size: bytes.length };
      }),
    ),
  );
  files['integrity.json'] = integrity;
  if (options.sign) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(INTEGRITY_DOMAIN + (options.wrongKey ? 'wrong' : integrity)),
    );
    const base64 = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
    files['signatures/publisher.json'] = JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ECDSA-P256-SHA256',
      publicKey: base64(await crypto.subtle.exportKey('spki', pair.publicKey)),
      signature: base64(signature),
    });
  }
  if (options.tamper) files['dist/main.js'] += 'throw Error("tamper");';
  if (options.large) files['dist/main.js'] = ' '.repeat(5 * 1024 * 1024 + 1);
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, value] of Object.entries(files)) await writer.add(path, new TextReader(value), { level: 0 });
  if (options.extra)
    await writer.add(options.extra, new Uint8ArrayReader(new Uint8Array([1])), {
      unixMode: options.symlink ? 0xa1ff : undefined,
    });
  return writer.close();
}

describe('moyaext preflight', () => {
  it('validates unsigned packages without executing code', async () => {
    const result = await verifyMoyaExtension(await archive());
    expect(result.manifest.extension.id).toBe('org.example.catalog');
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.publisherFingerprint).toBeUndefined();
  });
  it('checks payload hashes even when ZIP CRC is valid', async () => {
    await expect(verifyMoyaExtension(await archive({ tamper: true }))).rejects.toMatchObject({
      code: 'invalid_package_integrity',
    });
  });
  it('verifies publisher signatures and refuses modified signed data', async () => {
    expect((await verifyMoyaExtension(await archive({ sign: true }))).publisherFingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyMoyaExtension(await archive({ sign: true, wrongKey: true }))).rejects.toMatchObject({
      code: 'invalid_package_signature',
    });
  });
  it.each(['dist/MAIN.js', 'dist/payload.exe', 'assets/nul.png', 'unlisted.js'])(
    'rejects hidden, colliding or native payload %s',
    async (extra) => {
      await expect(verifyMoyaExtension(await archive({ extra }))).rejects.toMatchObject({
        code: 'invalid_package_entry',
      });
    },
  );
  it('rejects symlinks, excessive code size, invalid zip and cancellation', async () => {
    await expect(
      verifyMoyaExtension(await archive({ extra: 'assets/cover.png', symlink: true })),
    ).rejects.toMatchObject({
      code: 'invalid_package_entry',
    });
    await expect(verifyMoyaExtension(await archive({ large: true }))).rejects.toMatchObject({ code: 'package_limit' });
    await expect(verifyMoyaExtension(new Blob(['not a zip']))).rejects.toMatchObject({ code: 'invalid_package' });
    const controller = new AbortController();
    controller.abort();
    await expect(verifyMoyaExtension(await archive(), controller.signal)).rejects.toBeDefined();
  });
});
