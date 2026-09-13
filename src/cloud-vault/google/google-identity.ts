import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleIdentity {
  readonly subject: string;
  readonly label: string;
  readonly expiresAt: number;
}

/** Browser identity is for local account UX. A future metadata API must independently verify its token. */
export async function verifyGoogleIdentity(
  credential: string,
  clientId: string,
  nonce: string,
  key: JWTVerifyGetKey = keys,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(credential, key, {
    algorithms: ['RS256'],
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    maxTokenAge: '2h',
  });
  if (payload.nonce !== nonce || !payload.sub || (payload.azp && payload.azp !== clientId)) {
    throw new Error('Google 로그인 응답을 확인하지 못했습니다. 다시 로그인하세요.');
  }
  return {
    subject: payload.sub,
    label:
      typeof payload.email === 'string'
        ? payload.email
        : typeof payload.name === 'string'
          ? payload.name
          : 'Google 계정',
    expiresAt: payload.exp! * 1000,
  };
}
