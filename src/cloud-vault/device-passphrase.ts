const DEVICE_PASSPHRASE_FORMAT = 'noveldesk-cloud-vault-device-passphrase' as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface DevicePassphraseEnvelopeV1 {
  readonly format: typeof DEVICE_PASSPHRASE_FORMAT;
  readonly version: 1;
  readonly iv: string;
  readonly ciphertext: string;
}

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
  if (!globalThis.crypto?.subtle) throw new Error('이 기기에서는 Vault 암호를 안전하게 기억할 수 없습니다.');
  return globalThis.crypto;
}

export async function createCloudVaultDeviceKey(): Promise<CryptoKey> {
  return cryptoRuntime().subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealCloudVaultDevicePassphrase(passphrase: string, key: CryptoKey): Promise<string> {
  const runtime = cryptoRuntime();
  const iv = runtime.getRandomValues(new Uint8Array(12));
  const ciphertext = await runtime.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(passphrase));
  return JSON.stringify({
    format: DEVICE_PASSPHRASE_FORMAT,
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies DevicePassphraseEnvelopeV1);
}

export async function unsealCloudVaultDevicePassphrase(envelopeJson: string, key: CryptoKey): Promise<string> {
  let envelope: Partial<DevicePassphraseEnvelopeV1>;
  try {
    envelope = JSON.parse(envelopeJson) as Partial<DevicePassphraseEnvelopeV1>;
  } catch {
    throw new Error('저장된 Vault 암호가 올바르지 않습니다.');
  }
  if (
    envelope.format !== DEVICE_PASSPHRASE_FORMAT ||
    envelope.version !== 1 ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('저장된 Vault 암호 형식을 지원하지 않습니다.');
  }
  try {
    const plaintext = await cryptoRuntime().subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    );
    return textDecoder.decode(plaintext);
  } catch (error) {
    throw Object.assign(new Error('이 기기에 저장된 Vault 암호를 복구할 수 없습니다.'), { cause: error });
  }
}
