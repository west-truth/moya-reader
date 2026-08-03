import { timingSafeEqual } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { assertSecureServerConfig, type ServerConfig } from './config.js';

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
  return path === '/health' || path === '/api/health' || path === '/ready' || path === '/api/ready';
}

export function authEnabled(config: ServerConfig): boolean {
  return Boolean(config.authToken?.trim());
}

export async function registerAuthHook(app: FastifyInstance, config: ServerConfig): Promise<void> {
  assertSecureServerConfig(config);
  const expectedToken = config.authToken?.trim();
  if (!expectedToken) return;

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRequest(request.method, request.url)) return;
    const token = tokenFromAuthorizationHeader(request.headers.authorization);
    if (!safeTokenEquals(token, expectedToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
