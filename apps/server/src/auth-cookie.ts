import type { FastifyRequest } from 'fastify';

export const SELF_HOST_SESSION_COOKIE = 'moya_session';

export function requestCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    const value = entry.slice(separator + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestUsesHttps(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',', 1)[0]?.trim().toLowerCase();
  return protocol === 'https' || request.protocol === 'https';
}

export function selfHostSessionCookie(
  request: FastifyRequest,
  token: string,
  maxAgeSeconds: number,
  forceSecure = false,
): string {
  return [
    `${SELF_HOST_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(forceSecure || requestUsesHttps(request) ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSelfHostSessionCookie(request: FastifyRequest, forceSecure = false): string {
  return selfHostSessionCookie(request, '', 0, forceSecure);
}
