import { exchangeDropboxAuthorizationCode, type DropboxCredential } from './dropbox-provider';

const CALLBACK_TYPE = 'noveldesk-dropbox-oauth-callback';

interface DropboxOAuthCallbackMessage {
  readonly type: typeof CALLBACK_TYPE;
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function defaultDropboxRedirectUri(): string | undefined {
  if (!globalThis.location || !['http:', 'https:'].includes(globalThis.location.protocol)) return undefined;
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

export function relayDropboxOAuthPopup(): boolean {
  if (!globalThis.location || !globalThis.window?.opener) return false;
  const query = new URLSearchParams(globalThis.location.search);
  const code = query.get('code') ?? undefined;
  const state = query.get('state') ?? undefined;
  const error = query.get('error') ?? undefined;
  if (!state || (!code && !error)) return false;
  const message: DropboxOAuthCallbackMessage = {
    type: CALLBACK_TYPE,
    code,
    state,
    error,
    errorDescription: query.get('error_description') ?? undefined,
  };
  globalThis.window.opener.postMessage(message, globalThis.location.origin);
  globalThis.window.close();
  return true;
}

export async function connectDropboxWithPopup(input: {
  readonly appKey: string;
  readonly redirectUri?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DropboxCredential> {
  const redirectUri = input.redirectUri ?? defaultDropboxRedirectUri();
  if (!redirectUri) throw new Error('Dropbox OAuth currently requires an HTTP or HTTPS web origin.');
  const verifier = randomValue(48);
  const state = randomValue(24);
  const authorize = new URL('https://www.dropbox.com/oauth2/authorize');
  authorize.searchParams.set('client_id', input.appKey);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('token_access_type', 'offline');
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('code_challenge', await codeChallenge(verifier));
  authorize.searchParams.set('state', state);

  const popup = globalThis.window.open(
    authorize.toString(),
    'noveldesk-dropbox-oauth',
    'popup,width=560,height=720,noopener=false',
  );
  if (!popup) throw new Error('Dropbox sign-in popup was blocked. Allow popups and try again.');

  const callback = await new Promise<DropboxOAuthCallbackMessage>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(new Error('Dropbox sign-in timed out.')), 120_000);
    const closed = globalThis.setInterval(() => {
      if (popup.closed) finish(new Error('Dropbox sign-in was cancelled.'));
    }, 400);
    const onMessage = (event: MessageEvent<DropboxOAuthCallbackMessage>) => {
      if (event.origin !== globalThis.location.origin || event.data?.type !== CALLBACK_TYPE) return;
      if (event.data.state !== state) {
        finish(new Error('Dropbox OAuth state did not match.'));
        return;
      }
      finish(undefined, event.data);
    };
    const finish = (error?: Error, value?: DropboxOAuthCallbackMessage) => {
      globalThis.clearTimeout(timeout);
      globalThis.clearInterval(closed);
      globalThis.removeEventListener('message', onMessage);
      if (!popup.closed) popup.close();
      if (error) reject(error);
      else resolve(value!);
    };
    globalThis.addEventListener('message', onMessage);
  });
  if (callback.error || !callback.code) {
    throw new Error(callback.errorDescription || callback.error || 'Dropbox authorization failed.');
  }
  return exchangeDropboxAuthorizationCode({
    appKey: input.appKey,
    code: callback.code,
    codeVerifier: verifier,
    redirectUri,
    fetchImpl: input.fetchImpl,
  });
}
