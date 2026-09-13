import { createSourceBroker } from '@moya/extension-runtime/source-broker';
import {
  validateSourceAuthenticationRequest,
  type SourceAuthentication,
  type SourceAuthenticationInput,
  type SourceAuthenticationRequest,
  type SourceAuthenticationStatus,
} from '@noveldesk/extension-contracts/package';
import type { VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive.js';
import type { SourceCredentialVault } from './source-credential-vault.js';

export type SourceTransport = NonNullable<Parameters<typeof createSourceBroker>[1]>;

function declaration(pkg: VerifiedMoyaPackage, sourceId: string) {
  const auth = pkg.manifest.requestedAccess.authentication?.find((item) => item.sourceId === sourceId);
  if (!auth) throw new Error('source_auth_unavailable');
  return auth;
}
function scope(pkg: VerifiedMoyaPackage, auth: SourceAuthentication, epoch: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(epoch)) throw new Error('source_auth_unavailable');
  // Canonical property order survives JSON/DB round trips. A changed endpoint/scheme/probe needs a new connection.
  return JSON.stringify([
    pkg.manifest.extension.id,
    pkg.publisherFingerprint ?? 'unsigned',
    epoch,
    auth.sourceId,
    auth.origin,
    auth.scheme,
    auth.cookieName ?? null,
    auth.verification.path,
    auth.verification.field,
    auth.verification.equals,
  ]);
}
function headers(auth: SourceAuthentication, credential: SourceAuthenticationInput): Record<string, string> {
  if (!validateSourceAuthenticationRequest({ action: 'save', credential })) throw new Error('source_auth_required');
  if (auth.scheme === 'basic') {
    if (!credential.username) throw new Error('source_auth_required');
    return {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.secret}`, 'utf8').toString('base64')}`,
    };
  }
  if (
    credential.username ||
    !/^[\x21-\x7e]+$/.test(credential.secret) ||
    (auth.scheme === 'cookie' && /[;,]/.test(credential.secret))
  )
    throw new Error('source_auth_required');
  return auth.scheme === 'cookie'
    ? { cookie: `${auth.cookieName}=${credential.secret}` }
    : { authorization: `Bearer ${credential.secret}` };
}

export function createSourceAuthentication(vault: SourceCredentialVault, transport: SourceTransport = {}) {
  const pending = new Map<string, AbortController>();
  return {
    retain(packageId: string, epoch: string | undefined) {
      for (const [key, controller] of pending) {
        const [id, , currentEpoch] = JSON.parse(key) as string[];
        if (id === packageId && currentEpoch !== epoch) controller.abort();
      }
      vault.retain?.(packageId, epoch);
    },
    transport(pkg: VerifiedMoyaPackage, sourceId: string, epoch: string): SourceTransport {
      return {
        ...transport,
        authenticate: async (url, signal) => {
          signal.throwIfAborted();
          const auth = declaration(pkg, sourceId);
          if (url.origin !== auth.origin) throw new Error('source_url_denied');
          const credential = vault.read(scope(pkg, auth, epoch));
          if (!credential) throw new Error('source_auth_required');
          return headers(auth, credential);
        },
      };
    },
    async manage(
      pkg: VerifiedMoyaPackage,
      sourceId: string,
      epoch: string,
      request: SourceAuthenticationRequest,
      signal: AbortSignal,
    ): Promise<SourceAuthenticationStatus> {
      if (!validateSourceAuthenticationRequest(request)) throw new Error('invalid_source_authentication');
      const auth = declaration(pkg, sourceId);
      const key = scope(pkg, auth, epoch);
      signal.throwIfAborted();
      const previous = vault.read(key);
      if (request.action === 'status') return { state: previous ? 'saved' : 'missing' };
      pending.get(key)?.abort();
      if (request.action === 'remove') {
        pending.delete(key);
        vault.write(key, undefined);
        return { state: 'missing' };
      }
      const controller = new AbortController();
      pending.set(key, controller);
      const joined = AbortSignal.any([signal, controller.signal]);
      const credential = request.action === 'save' ? request.credential : previous;
      const broker = createSourceBroker(
        { origins: [auth.origin] },
        {
          ...transport,
          authenticate: async (url) => {
            if (url.origin !== auth.origin || !credential) throw new Error('source_auth_required');
            return headers(auth, credential);
          },
        },
      );
      try {
        if (!credential) return { state: 'missing' };
        const response = (await broker.methods['http.request'](
          { url: new URL(auth.verification.path, auth.origin).href, authenticated: true, response: 'text' },
          joined,
        )) as { text: string };
        let result: unknown;
        try {
          result = JSON.parse(response.text);
        } catch {
          return { state: 'invalid' };
        }
        for (const field of auth.verification.field) {
          if (!result || typeof result !== 'object' || !Object.hasOwn(result, field)) return { state: 'invalid' };
          result = (result as Record<string, unknown>)[field];
        }
        if (result !== auth.verification.equals) return { state: 'invalid' };
        joined.throwIfAborted();
        if (request.action === 'save') vault.write(key, credential);
        return { state: 'valid', checkedAt: new Date().toISOString() };
      } catch (error) {
        joined.throwIfAborted();
        return {
          state:
            error instanceof Error && error.message === 'source_auth_required'
              ? 'invalid'
              : error instanceof Error && error.message === 'source_auth_forbidden'
                ? 'forbidden'
                : 'error',
        };
      } finally {
        broker.dispose();
        if (pending.get(key) === controller) pending.delete(key);
      }
    },
  };
}
