import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { boundedFile } from './project';

export async function generatePublisherKey(folder: string) {
  // Reserve a new directory before generating anything: existing keys are never replaced.
  const target = resolve(folder);
  await mkdir(target, { mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  await writeFile(resolve(target, 'publisher.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(resolve(target, 'publisher-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }), {
    flag: 'wx',
    mode: 0o644,
  });
  return { folder: target, publicKeyFingerprint: createHash('sha256').update(publicDer).digest('hex') };
}

export async function loadPublisherKey(path: string): Promise<CryptoKeyPair> {
  const bytes = await boundedFile(path, 16 * 1024);
  const key = createPrivateKey(bytes);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('publisher_key_requires_p256');
  const publicKey = createPublicKey(key);
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  return {
    privateKey: await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(key.export({ type: 'pkcs8', format: 'der' })),
      algorithm,
      false,
      ['sign'],
    ),
    publicKey: await crypto.subtle.importKey(
      'spki',
      new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      algorithm,
      true,
      ['verify'],
    ),
  };
}
