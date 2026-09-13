import { createRemoteJWKSet, jwtVerify } from 'jose';

export const driveScope = 'https://www.googleapis.com/auth/drive.file';
export class GoogleGrantError extends Error {
  constructor(reconnect) {
    super('Google authorization failed');
    this.reconnect = reconnect;
  }
}

export function googleProvider(
  config,
  fetchImpl = fetch,
  keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
) {
  const verify = async (credential, nonce) => {
    const { payload } = await jwtVerify(credential, keys, {
      algorithms: ['RS256'],
      audience: config.clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      maxTokenAge: '2h',
    });
    if (payload.nonce !== nonce || (payload.azp && payload.azp !== config.clientId)) throw new GoogleGrantError(true);
    return { subject: payload.sub, label: typeof payload.email === 'string' ? payload.email : 'Google 계정' };
  };
  const token = async (values) => {
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values }),
    });
    const value = await response.json();
    if (!response.ok) throw new GoogleGrantError(value.error === 'invalid_grant');
    if (
      typeof value.access_token !== 'string' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 60 ||
      (value.scope && !value.scope.split(' ').includes(driveScope))
    )
      throw new GoogleGrantError(true);
    return value;
  };
  return {
    verify,
    async exchange(code, verifier, nonce) {
      const value = await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: `${config.publicUrl}/oauth/callback`,
      });
      if (!value.id_token || !value.refresh_token || !value.scope?.split(' ').includes(driveScope))
        throw new GoogleGrantError(true);
      const identity = await verify(value.id_token, nonce);
      return {
        identity,
        refreshToken: value.refresh_token,
        accessToken: value.access_token,
        expiresIn: value.expires_in,
      };
    },
    async refresh(refreshToken) {
      const value = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      return { accessToken: value.access_token, expiresIn: value.expires_in, refreshToken: value.refresh_token };
    },
  };
}
