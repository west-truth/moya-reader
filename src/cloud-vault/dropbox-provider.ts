import {
  CLOUD_VAULT_FILE_NAME,
  CloudVaultWriteConflictError,
  type CloudVaultContentProvider,
  type CloudVaultStoredObject,
} from './contracts';

const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';
const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_VAULT_PATH = `/${CLOUD_VAULT_FILE_NAME}`;
const DROPBOX_SIMPLE_UPLOAD_LIMIT = 140 * 1024 * 1024;
const DROPBOX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export interface DropboxCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly accountId?: string;
}

export interface DropboxCredentialStore {
  get(): Promise<DropboxCredential | undefined>;
  save(credential: DropboxCredential): Promise<void>;
}

export interface DropboxAccessTokenSource {
  getAccessToken(): Promise<string>;
}

interface DropboxTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
}

const MAX_DROPBOX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_DROPBOX_TOKEN_LENGTH = 16 * 1024;

function validToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DROPBOX_TOKEN_LENGTH) {
    throw new Error(`Dropbox ${label} is invalid.`);
  }
  return value;
}

function expiresAt(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31_536_000) {
    throw new Error('Dropbox token expiry is invalid.');
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function responseError(prefix: string, response: Response): Error {
  return new Error(`${prefix} (${response.status}).`);
}

async function parseTokenResponse(response: Response): Promise<DropboxTokenResponse> {
  const text = await response.text();
  if (text.length > MAX_DROPBOX_TOKEN_RESPONSE_BYTES) {
    throw new Error(`Dropbox authorization failed (${response.status}).`);
  }
  let body: DropboxTokenResponse = {};
  try {
    body = JSON.parse(text) as DropboxTokenResponse;
  } catch {
    // A safe HTTP summary is returned below.
  }
  if (!response.ok || !body.access_token) {
    throw new Error(`Dropbox authorization failed (${response.status}).`);
  }
  if (
    body.account_id !== undefined &&
    (typeof body.account_id !== 'string' || !body.account_id.trim() || body.account_id.length > 512)
  ) {
    throw new Error(`Dropbox authorization failed (${response.status}).`);
  }
  return {
    ...body,
    access_token: validToken(body.access_token, 'access token'),
    refresh_token: body.refresh_token ? validToken(body.refresh_token, 'refresh token') : undefined,
  };
}

export async function exchangeDropboxAuthorizationCode(input: {
  readonly appKey: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DropboxCredential> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    code: input.code,
    grant_type: 'authorization_code',
    client_id: input.appKey,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const body = await parseTokenResponse(
    await fetchImpl(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
  );
  if (typeof body.account_id !== 'string' || !body.account_id.trim() || body.account_id.length > 512) {
    throw new Error('Dropbox authorization failed because the account identity was missing.');
  }
  return {
    accessToken: body.access_token!,
    refreshToken: body.refresh_token,
    expiresAt: expiresAt(body.expires_in),
    accountId: body.account_id,
  };
}

/**
 * Host-owned Dropbox token boundary shared by first-party Dropbox adapters.
 * Refresh credentials never leave the supplied credential store, and concurrent
 * callers share one refresh request when an access token expires.
 */
export class DropboxAccessTokenManager implements DropboxAccessTokenSource {
  private refreshPromise?: Promise<string>;

  constructor(
    private readonly appKey: string,
    private readonly credentials: DropboxCredentialStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async getAccessToken(): Promise<string> {
    const current = await this.credentials.get();
    if (!current) throw new Error('Dropbox is not connected.');
    validToken(current.accessToken, 'access token');
    const stillValid = !current.expiresAt || Date.parse(current.expiresAt) - Date.now() > 60_000;
    if (stillValid) return current.accessToken;
    return this.refreshAccessToken(current.accessToken);
  }

  /** Refreshes after a 401 while avoiding a second refresh when another caller already rotated the token. */
  async refreshAccessToken(staleAccessToken?: string): Promise<string> {
    const current = await this.credentials.get();
    if (!current) throw new Error('Dropbox is not connected.');
    validToken(current.accessToken, 'access token');
    if (staleAccessToken && current.accessToken !== staleAccessToken) return current.accessToken;
    if (!current.refreshToken) throw new Error('Dropbox session expired. Connect Dropbox again.');
    validToken(current.refreshToken, 'refresh token');
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(current).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async refresh(current: DropboxCredential): Promise<string> {
    const refreshToken = current.refreshToken;
    if (!refreshToken) throw new Error('Dropbox session expired. Connect Dropbox again.');
    const response = await this.fetchImpl(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.appKey,
      }),
    });
    const body = await parseTokenResponse(response);
    const next: DropboxCredential = {
      ...current,
      accessToken: body.access_token!,
      refreshToken: body.refresh_token ?? current.refreshToken,
      expiresAt: expiresAt(body.expires_in),
      accountId: body.account_id ?? current.accountId,
    };
    await this.credentials.save(next);
    return next.accessToken;
  }
}

function dropboxObjectPath(objectKey: string): string {
  const segments = objectKey.split('/');
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[a-z0-9._-]+$/i.test(segment))
  ) {
    throw new Error('Cloud Vault object key is invalid.');
  }
  return `/${segments.join('/')}`;
}

interface DropboxFileMetadata {
  readonly rev?: string;
  readonly size?: number;
}

export class DropboxCloudVaultProvider implements CloudVaultContentProvider {
  readonly kind = 'dropbox' as const;
  readonly label = 'Dropbox';

  private readonly accessTokens: DropboxAccessTokenManager;
  private readonly ensuredObjectDirectories = new Set<string>();

  constructor(
    private readonly appKey: string,
    private readonly credentials: DropboxCredentialStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.accessTokens = new DropboxAccessTokenManager(appKey, credentials, fetchImpl);
  }

  async read(): Promise<CloudVaultStoredObject | undefined> {
    const token = await this.accessTokens.getAccessToken();
    const response = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_VAULT_PATH }),
      },
    });
    if (response.status === 409) {
      const message = await response.text();
      if (message.includes('not_found')) return undefined;
      throw responseError('Dropbox vault read failed', response);
    }
    if (!response.ok) throw responseError('Dropbox vault read failed', response);
    const metadata = response.headers.get('Dropbox-API-Result');
    const parsed = metadata ? (JSON.parse(metadata) as { rev?: string }) : undefined;
    if (!parsed?.rev) throw new Error('Dropbox vault response did not include a file revision.');
    return { bytes: new Uint8Array(await response.arrayBuffer()), revision: parsed.rev };
  }

  async getRevision(): Promise<string | undefined> {
    return (await this.getMetadata(DROPBOX_VAULT_PATH))?.rev;
  }

  async write(bytes: Uint8Array, expectedRevision?: string): Promise<{ revision: string }> {
    const token = await this.accessTokens.getAccessToken();
    const mode = expectedRevision ? { '.tag': 'update', update: expectedRevision } : { '.tag': 'add' };
    const response = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: DROPBOX_VAULT_PATH,
          mode,
          autorename: false,
          mute: true,
          strict_conflict: true,
        }),
      },
      body: bytes as unknown as BodyInit,
    });
    const text = await response.text();
    if (response.status === 409) throw new CloudVaultWriteConflictError('Dropbox vault revision changed.');
    if (!response.ok) throw responseError('Dropbox vault write failed', response);
    const result = JSON.parse(text) as { rev?: string };
    if (!result.rev) throw new Error('Dropbox vault upload did not return a file revision.');
    return { revision: result.rev };
  }

  async getObject(objectKey: string) {
    const token = await this.accessTokens.getAccessToken();
    const response = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxObjectPath(objectKey) }),
      },
    });
    if (response.status === 409) {
      const message = await response.text();
      if (message.includes('not_found')) return undefined;
      throw responseError('Dropbox content read failed', response);
    }
    if (!response.ok) throw responseError('Dropbox content read failed', response);
    const header = response.headers.get('Dropbox-API-Result');
    const metadata = header ? (JSON.parse(header) as DropboxFileMetadata) : undefined;
    return { blob: await response.blob(), revision: metadata?.rev };
  }

  async putObject(objectKey: string, blob: Blob, expected: { readonly byteLength: number }) {
    if (blob.size !== expected.byteLength) throw new Error('Cloud Vault object size changed before upload.');
    const path = dropboxObjectPath(objectKey);
    const existing = await this.getMetadata(path);
    if (existing) {
      if (existing.size !== expected.byteLength) {
        throw new Error('Dropbox content-addressed object has an unexpected size.');
      }
      return { created: false, revision: existing.rev };
    }
    await this.ensureParentDirectories(path);
    try {
      const metadata =
        blob.size <= DROPBOX_SIMPLE_UPLOAD_LIMIT
          ? await this.uploadObject(path, blob)
          : await this.uploadObjectInChunks(path, blob);
      return { created: true, revision: metadata.rev };
    } catch (error) {
      if (!(error instanceof CloudVaultWriteConflictError)) throw error;
      const raced = await this.getMetadata(path);
      if (raced?.size === expected.byteLength) return { created: false, revision: raced.rev };
      throw error;
    }
  }

  private async getMetadata(path: string): Promise<DropboxFileMetadata | undefined> {
    const token = await this.accessTokens.getAccessToken();
    const response = await this.fetchImpl(`${DROPBOX_API}/files/get_metadata`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const text = await response.text();
    if (response.status === 409 && text.includes('not_found')) return undefined;
    if (!response.ok) throw responseError('Dropbox content metadata failed', response);
    return JSON.parse(text) as DropboxFileMetadata;
  }

  private async ensureParentDirectories(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean).slice(0, -1);
    if (segments.length === 0) return;
    const token = await this.accessTokens.getAccessToken();
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      if (this.ensuredObjectDirectories.has(current)) continue;
      const response = await this.fetchImpl(`${DROPBOX_API}/files/create_folder_v2`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: current, autorename: false }),
      });
      if (!response.ok && response.status !== 409) {
        throw responseError('Dropbox content directory creation failed', response);
      }
      this.ensuredObjectDirectories.add(current);
    }
  }

  private async uploadObject(path: string, blob: Blob): Promise<DropboxFileMetadata> {
    const token = await this.accessTokens.getAccessToken();
    const response = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path,
          mode: { '.tag': 'add' },
          autorename: false,
          mute: true,
          strict_conflict: true,
        }),
      },
      body: blob,
    });
    const text = await response.text();
    if (response.status === 409) throw new CloudVaultWriteConflictError('Dropbox content object already exists.');
    if (!response.ok) throw responseError('Dropbox content upload failed', response);
    return JSON.parse(text) as DropboxFileMetadata;
  }

  private async uploadObjectInChunks(path: string, blob: Blob): Promise<DropboxFileMetadata> {
    const token = await this.accessTokens.getAccessToken();
    const firstEnd = Math.min(DROPBOX_UPLOAD_CHUNK_BYTES, blob.size);
    const started = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload_session/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ close: false }),
      },
      body: blob.slice(0, firstEnd),
    });
    const startedText = await started.text();
    if (!started.ok) throw responseError('Dropbox content upload session failed', started);
    const sessionId = (JSON.parse(startedText) as { session_id?: string }).session_id;
    if (!sessionId) throw new Error('Dropbox upload session did not return an id.');

    let offset = firstEnd;
    while (offset + DROPBOX_UPLOAD_CHUNK_BYTES < blob.size) {
      const end = offset + DROPBOX_UPLOAD_CHUNK_BYTES;
      const appended = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload_session/append_v2`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
        },
        body: blob.slice(offset, end),
      });
      if (!appended.ok) throw responseError('Dropbox content upload append failed', appended);
      offset = end;
    }

    const finished = await this.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload_session/finish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          cursor: { session_id: sessionId, offset },
          commit: {
            path,
            mode: { '.tag': 'add' },
            autorename: false,
            mute: true,
            strict_conflict: true,
          },
        }),
      },
      body: blob.slice(offset),
    });
    const finishedText = await finished.text();
    if (finished.status === 409) {
      throw new CloudVaultWriteConflictError('Dropbox content object already exists.');
    }
    if (!finished.ok) throw responseError('Dropbox content upload finish failed', finished);
    return JSON.parse(finishedText) as DropboxFileMetadata;
  }
}

export async function fetchDropboxAccountLabel(
  credential: DropboxCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl(`${DROPBOX_API}/users/get_current_account`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.accessToken}` },
  });
  if (!response.ok) return undefined;
  const value = (await response.json()) as { email?: string; name?: { display_name?: string } };
  return value.email ?? value.name?.display_name;
}
