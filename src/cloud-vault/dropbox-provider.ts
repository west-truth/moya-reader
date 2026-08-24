import {
  CLOUD_VAULT_FILE_NAME,
  CloudVaultWriteConflictError,
  type CloudVaultFileProvider,
  type CloudVaultStoredObject,
} from './contracts';

const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';
const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_VAULT_PATH = `/${CLOUD_VAULT_FILE_NAME}`;

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

export class DropboxCloudVaultProvider implements CloudVaultFileProvider {
  readonly kind = 'dropbox' as const;
  readonly label = 'Dropbox';

  private readonly accessTokens: DropboxAccessTokenManager;

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
