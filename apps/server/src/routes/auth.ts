import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serverExposure, type ServerConfig } from '../config.js';
import {
  SELF_HOST_SESSION_COOKIE,
  clearedSelfHostSessionCookie,
  requestCookie,
  selfHostSessionCookie,
} from '../auth-cookie.js';
import { SelfHostAuthError, type SelfHostAuthService } from '../services/self-host-auth-service.js';

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const AUTH_BODY_LIMIT = 4 * 1024;

interface AccountBody {
  readonly username?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
  readonly setupCode?: unknown;
}

function bodyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function throttleKey(request: FastifyRequest): string {
  // Do not include the submitted username: otherwise an attacker can rotate arbitrary
  // usernames to bypass the admission window and grow the in-memory key set.
  return request.ip.slice(0, 200);
}

function safeSecretEquals(candidate: string, expected: string): boolean {
  if (candidate.length > 512 || expected.length > 512) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function authErrorReply(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof SelfHostAuthError) return { status: error.status, body: { error: error.code } };
  return { status: 500, body: { error: 'authentication_unavailable' } };
}

export async function registerSelfHostAuthRoutes(
  app: FastifyInstance,
  service: SelfHostAuthService,
  config: ServerConfig,
): Promise<void> {
  const secureCookie = serverExposure(config) === 'external';

  app.get('/api/auth/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const sessionToken = requestCookie(request, SELF_HOST_SESSION_COOKIE);
    const status = await service.status(sessionToken);
    const recoveryEnabled = Boolean(config.authToken?.trim());
    return {
      ...status,
      setupCodeRequired: status.setupRequired && recoveryEnabled,
      legacyRecoveryEnabled: recoveryEnabled,
    };
  });

  app.get('/api/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const account = await service.authenticateSession(requestCookie(request, SELF_HOST_SESSION_COOKIE));
    if (!account) return reply.code(401).send({ error: 'unauthorized' });
    return { authenticated: true, account };
  });

  app.post<{ Body: AccountBody }>('/api/auth/register', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const expectedSetupCode = config.authToken?.trim();
      if (expectedSetupCode && !safeSecretEquals(bodyString(request.body?.setupCode), expectedSetupCode)) {
        return reply.code(403).send({ error: 'invalid_setup_code' });
      }
      const session = await service.register({
        username: bodyString(request.body?.username),
        displayName: bodyString(request.body?.displayName) || undefined,
        password: bodyString(request.body?.password),
      });
      reply.header('Set-Cookie', selfHostSessionCookie(request, session.token, SESSION_MAX_AGE_SECONDS, secureCookie));
      return reply.code(201).send({ authenticated: true, account: session.account, expiresAt: session.expiresAt });
    } catch (error) {
      const failure = authErrorReply(error);
      return reply.code(failure.status).send(failure.body);
    }
  });

  app.post<{ Body: AccountBody }>('/api/auth/login', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const username = bodyString(request.body?.username);
    try {
      const session = await service.login({
        username,
        password: bodyString(request.body?.password),
        throttleKey: throttleKey(request),
      });
      reply.header('Set-Cookie', selfHostSessionCookie(request, session.token, SESSION_MAX_AGE_SECONDS, secureCookie));
      return { authenticated: true, account: session.account, expiresAt: session.expiresAt };
    } catch (error) {
      const failure = authErrorReply(error);
      return reply.code(failure.status).send(failure.body);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    await service.logout(requestCookie(request, SELF_HOST_SESSION_COOKIE));
    reply.header('Set-Cookie', clearedSelfHostSessionCookie(request, secureCookie));
    return { ok: true };
  });
}
