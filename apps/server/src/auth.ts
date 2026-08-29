import { timingSafeEqual } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { assertSecureServerConfig, type ServerConfig } from './config.js';
import { SELF_HOST_SESSION_COOKIE, requestCookie } from './auth-cookie.js';
import type { SelfHostAuthService } from './services/self-host-auth-service.js';

function tokenFromAuthorizationHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer[\t ]+([^\t ]+)[\t ]*$/i);
  return match?.[1];
}

function safeTokenEquals(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isPublicRequest(method: string, url: string): boolean {
  if (method.toUpperCase() === 'OPTIONS') return true;
  const path = url.split('?', 1)[0];
  return (
    path === '/health' ||
    path === '/api/health' ||
    path === '/ready' ||
    path === '/api/ready' ||
    path === '/api/auth/status' ||
    path === '/api/auth/session' ||
    path === '/api/auth/register' ||
    path === '/api/auth/login' ||
    path === '/api/auth/logout'
  );
}

export function authEnabled(config: ServerConfig): boolean {
  return Boolean(config.authToken?.trim());
}

export async function registerAuthHook(
  app: FastifyInstance,
  config: ServerConfig,
  selfHostAuth?: SelfHostAuthService,
): Promise<void> {
  assertSecureServerConfig(config);
  const expectedToken = config.authToken?.trim();
  if (!expectedToken && !selfHostAuth) return;

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRequest(request.method, request.url)) return;
    const token = tokenFromAuthorizationHeader(request.headers.authorization);
    if (expectedToken && safeTokenEquals(token, expectedToken)) return;
    const account = await selfHostAuth?.authenticateSession(requestCookie(request, SELF_HOST_SESSION_COOKIE));
    if (account) return;
    if (selfHostAuth && (await selfHostAuth.setupRequired())) {
      return reply.code(503).send({ error: 'account_setup_required' });
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });
}
