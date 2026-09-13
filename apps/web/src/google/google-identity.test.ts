import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyGoogleIdentity } from './google-identity';

describe('Google identity verification', () => {
  it('checks the signature, issuer, audience, nonce and expiry before accepting an identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const sign = (claims: Record<string, unknown> = {}) =>
      new SignJWT({ nonce: 'nonce', email: 'reader@example.test', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('reader')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setIssuer('https://accounts.google.com')
        .setAudience('client')
        .sign(privateKey);
    const verify = (token: string, audience = 'client', nonce = 'nonce') =>
      verifyGoogleIdentity(token, audience, nonce, async () => publicKey);
    expect((await verify(await sign())).subject).toBe('reader');
    await expect(verify(await sign(), 'wrong-client')).rejects.toThrow();
    await expect(verify(await sign(), 'client', 'wrong-nonce')).rejects.toThrow();
    await expect(verify(await sign({ azp: 'wrong-client' }))).rejects.toThrow();
    const expired = await new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('reader')
      .setIssuedAt()
      .setExpirationTime(1)
      .setIssuer('https://accounts.google.com')
      .setAudience('client')
      .sign(privateKey);
    await expect(verify(expired)).rejects.toThrow();
    const wrongIssuer = await new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('reader')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('https://attacker.example')
      .setAudience('client')
      .sign(privateKey);
    await expect(verify(wrongIssuer)).rejects.toThrow();
    const other = await generateKeyPair('RS256');
    await expect(verifyGoogleIdentity(await sign(), 'client', 'nonce', async () => other.publicKey)).rejects.toThrow();
  });
});
