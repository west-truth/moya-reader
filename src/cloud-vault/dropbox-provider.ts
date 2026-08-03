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

interface DropboxTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
  error_description?: string;
}

function expiresAt(seconds: number | undefined): string | undefined {
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
}

function responseError(prefix: string, response: Response, body: string): Error {
  return new Error(`${prefix} (${response.status}): ${body || response.statusText}`);
}

async function parseTokenResponse(response: Response): Promise<DropboxTokenResponse> {
  const text = await response.text();
  let body: DropboxTokenResponse = {};
  try {
    body = JSON.parse(text) as DropboxTokenResponse;
  } catch {
    // A safe HTTP summary is returned below.
  }
  if (!response.ok || !body.access_token) {
    throw responseError('Dropbox authorization failed', response, body.error_description ?? text);
  }
  return body;
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
  return {
    accessToken: body.access_token!,
    refreshToken: body.refresh_token,
    expiresAt: expiresAt(body.expires_in),
    accountId: body.account_id,
  };
}

export class DropboxCloudVaultProvider implements CloudVaultFileProvider {
  readonly kind = 'dropbox' as const;
  readonly label = 'Dropbox';

  constructor(
    private readonly appKey: string,
    private readonly credentials: DropboxCredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async read(): Promise<CloudVaultStoredObject | undefined> {
    const token = await this.accessToken();
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
      throw responseError('Dropbox vault read failed', response, message);
    }
    if (!response.ok) throw responseError('Dropbox vault read failed', response, await response.text());
    const metadata = response.headers.get('Dropbox-API-Result');
    const parsed = metadata ? (JSON.parse(metadata) as { rev?: string }) : undefined;
    if (!parsed?.rev) throw new Error('Dropbox vault response did not include a file revision.');
    return { bytes: new Uint8Array(await response.arrayBuffer()), revision: parsed.rev };
  }

  async write(bytes: Uint8Array, expectedRevision?: string): Promise<{ revision: string }> {
    const token = await this.accessToken();
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
    if (!response.ok) throw responseError('Dropbox vault write failed', response, text);
    const result = JSON.parse(text) as { rev?: string };
    if (!result.rev) throw new Error('Dropbox vault upload did not return a file revision.');
    return { revision: result.rev };
  }

  private async accessToken(): Promise<string> {
    const current = await this.credentials.get();
    if (!current) throw new Error('Dropbox is not connected.');
    const stillValid = !current.expiresAt || Date.parse(current.expiresAt) - Date.now() > 60_000;
    if (stillValid) return current.accessToken;
    if (!current.refreshToken) throw new Error('Dropbox session expired. Connect Dropbox again.');
    const response = await this.fetchImpl(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
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
