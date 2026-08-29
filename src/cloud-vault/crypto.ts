import { canonicalJson } from '../domain/canonical-json';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_AI_TTS_FORMAT,
  CLOUD_VAULT_AI_TTS_VERSION,
  CLOUD_VAULT_VERSION,
  type CloudVaultAiTtsPayloadV1,
  type CloudVaultEncryptedEnvelopeV1,
  type CloudVaultSnapshotV1,
} from './contracts';

const PBKDF2_ITERATIONS = 310_000;
export const CLOUD_VAULT_MIN_PASSPHRASE_LENGTH = 8;
const CLOUD_SECRET_FORMAT = 'noveldesk-cloud-secret' as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function cryptoRuntime(): Crypto {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle) throw new Error('This environment does not support cloud vault encryption.');
  return runtime;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (passphrase.length < CLOUD_VAULT_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Cloud vault passphrase must be at least ${CLOUD_VAULT_MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const crypto = cryptoRuntime();
  const material = await crypto.subtle.importKey('raw', textEncoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function parseEnvelope(bytes: Uint8Array): CloudVaultEncryptedEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new Error('Cloud vault file is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cloud vault envelope is invalid.');
  const envelope = value as Partial<CloudVaultEncryptedEnvelopeV1>;
  if (
    envelope.format !== CLOUD_VAULT_FORMAT ||
    envelope.version !== CLOUD_VAULT_VERSION ||
    envelope.kdf?.name !== 'PBKDF2' ||
    envelope.kdf.hash !== 'SHA-256' ||
    envelope.cipher?.name !== 'AES-GCM' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('Cloud vault format is not supported.');
  }
  return envelope as CloudVaultEncryptedEnvelopeV1;
}

async function encryptJsonPayload(
  value: unknown,
  passphrase: string,
  payloadKind: 'vault' | 'ai-tts',
): Promise<Uint8Array> {
  const crypto = cryptoRuntime();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = textEncoder.encode(canonicalJson(value));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const envelope: CloudVaultEncryptedEnvelopeV1 = {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    payloadKind,
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
  return textEncoder.encode(JSON.stringify(envelope));
}

async function decryptJsonPayload(bytes: Uint8Array, passphrase: string, expectedKind: 'vault' | 'ai-tts') {
  const envelope = parseEnvelope(bytes);
  const actualKind = envelope.payloadKind ?? 'vault';
  if (actualKind !== expectedKind) throw new Error('Cloud vault payload kind is invalid.');
  if (!Number.isSafeInteger(envelope.kdf.iterations) || envelope.kdf.iterations < 100_000) {
    throw new Error('Cloud vault key derivation parameters are invalid.');
  }
  try {
    const salt = base64ToBytes(envelope.kdf.salt);
    const iv = base64ToBytes(envelope.cipher.iv);
    const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
    const plaintext = await cryptoRuntime().subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    );
    return JSON.parse(textDecoder.decode(plaintext)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cloud vault')) throw error;
    throw Object.assign(new Error('Cloud vault passphrase is incorrect or the file is damaged.'), { cause: error });
  }
}

function validateSnapshot(value: unknown): CloudVaultSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cloud vault payload is invalid.');
  const snapshot = value as Partial<CloudVaultSnapshotV1>;
  if (
    snapshot.format !== CLOUD_VAULT_FORMAT ||
    snapshot.version !== CLOUD_VAULT_VERSION ||
    !Array.isArray(snapshot.books) ||
    !Array.isArray(snapshot.shelves) ||
    !Array.isArray(snapshot.shelfMemberships) ||
    !Array.isArray(snapshot.tombstones)
  ) {
    throw new Error('Cloud vault payload version is not supported.');
  }
  return snapshot as CloudVaultSnapshotV1;
}

export async function encryptCloudVault(snapshot: CloudVaultSnapshotV1, passphrase: string): Promise<Uint8Array> {
  return encryptJsonPayload(snapshot, passphrase, 'vault');
}

export async function decryptCloudVault(bytes: Uint8Array, passphrase: string): Promise<CloudVaultSnapshotV1> {
  return validateSnapshot(await decryptJsonPayload(bytes, passphrase, 'vault'));
}

export function encryptCloudVaultAiTts(payload: CloudVaultAiTtsPayloadV1, passphrase: string): Promise<Uint8Array> {
  return encryptJsonPayload(payload, passphrase, 'ai-tts');
}

export async function decryptCloudVaultAiTts(bytes: Uint8Array, passphrase: string): Promise<CloudVaultAiTtsPayloadV1> {
  const value = await decryptJsonPayload(bytes, passphrase, 'ai-tts');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud vault AI/TTS payload is invalid.');
  }
  const payload = value as Partial<CloudVaultAiTtsPayloadV1>;
  if (
    payload.format !== CLOUD_VAULT_AI_TTS_FORMAT ||
    payload.version !== CLOUD_VAULT_AI_TTS_VERSION ||
    typeof payload.bookHash !== 'string' ||
    !Array.isArray(payload.chapters) ||
    !Array.isArray(payload.paragraphs) ||
    !Array.isArray(payload.characters) ||
    !Array.isArray(payload.characterRelations) ||
    !Array.isArray(payload.segments) ||
    !Array.isArray(payload.voiceProfiles) ||
    !Array.isArray(payload.corrections)
  ) {
    throw new Error('Cloud vault AI/TTS payload is invalid.');
  }
  return payload as CloudVaultAiTtsPayloadV1;
}

interface CloudVaultSealedSecretV1 {
  readonly format: typeof CLOUD_SECRET_FORMAT;
  readonly version: 1;
  readonly iterations: number;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export async function sealCloudVaultSecret<T>(value: T, passphrase: string): Promise<string> {
  const crypto = cryptoRuntime();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return JSON.stringify({
    format: CLOUD_SECRET_FORMAT,
    version: 1,
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies CloudVaultSealedSecretV1);
}

export async function unsealCloudVaultSecret<T>(envelopeJson: string, passphrase: string): Promise<T> {
  let envelope: Partial<CloudVaultSealedSecretV1>;
  try {
    envelope = JSON.parse(envelopeJson) as Partial<CloudVaultSealedSecretV1>;
  } catch {
    throw new Error('Stored cloud credential is invalid.');
  }
  if (
    envelope.format !== CLOUD_SECRET_FORMAT ||
    envelope.version !== 1 ||
    !Number.isSafeInteger(envelope.iterations) ||
    (envelope.iterations ?? 0) < 100_000 ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('Stored cloud credential format is not supported.');
  }
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const key = await deriveKey(passphrase, salt, envelope.iterations!);
    const plaintext = await cryptoRuntime().subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    );
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Stored cloud')) throw error;
    throw Object.assign(new Error('Cloud vault passphrase could not unlock the stored Dropbox connection.'), {
      cause: error,
    });
  }
}
