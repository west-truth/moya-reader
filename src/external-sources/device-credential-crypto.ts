const CREDENTIAL_FORMAT = 'noveldesk-external-source-credential' as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface DeviceCredentialEnvelopeV1 {
  readonly format: typeof CREDENTIAL_FORMAT;
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
  if (!globalThis.crypto?.subtle) throw new Error('이 환경에서는 외부 소스 연결 정보를 안전하게 저장할 수 없습니다.');
  return globalThis.crypto;
}

export async function createExternalSourceCredentialKey(): Promise<CryptoKey> {
  return cryptoRuntime().subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealExternalSourceCredential<T>(value: T, key: CryptoKey): Promise<string> {
  const runtime = cryptoRuntime();
  const iv = runtime.getRandomValues(new Uint8Array(12));
  const ciphertext = await runtime.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    format: CREDENTIAL_FORMAT,
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies DeviceCredentialEnvelopeV1);
}

export async function unsealExternalSourceCredential<T>(envelopeJson: string, key: CryptoKey): Promise<T> {
  let envelope: Partial<DeviceCredentialEnvelopeV1>;
  try {
    envelope = JSON.parse(envelopeJson) as Partial<DeviceCredentialEnvelopeV1>;
  } catch {
    throw new Error('저장된 외부 소스 연결 정보가 올바르지 않습니다.');
  }
  if (
    envelope.format !== CREDENTIAL_FORMAT ||
    envelope.version !== 1 ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('저장된 외부 소스 연결 정보 형식을 지원하지 않습니다.');
  }
  try {
    const plaintext = await cryptoRuntime().subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    );
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch (error) {
    throw Object.assign(new Error('저장된 외부 소스 연결 정보를 복구할 수 없습니다.'), { cause: error });
  }
}
