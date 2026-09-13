import { readBrowserSession, writeBrowserSession } from './source-browser-session.js';
import { CookieJar } from 'tough-cookie';
import type { SourceWebViewScope } from './source-webview.js';
import { compatibilityHttp, type CompatibilityHttpInput } from './mangayomi/http.js';

/** Bridges ordinary HTTP with the source's WebView session without launching a browser for HTTP requests. */
export async function sourceBrowserHttp(
  input: CompatibilityHttpInput,
  signal: AbortSignal,
  scope: SourceWebViewScope,
  maximum: number,
  transport = compatibilityHttp,
  followRedirects = false,
): Promise<Awaited<ReturnType<typeof compatibilityHttp>>> {
  if (followRedirects) {
    const next = { ...input, headers: { ...input.headers } };
    let remaining = maximum;
    for (let hop = 0; hop <= 4; hop++) {
      const response = await sourceBrowserHttp(next, signal, scope, remaining, transport, false);
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
      if (hop === 4 || !response.headers.location) throw new Error('source_redirect_limit');
      const url = new URL(response.headers.location, next.url);
      if (url.origin !== new URL(next.url).origin) {
        if (!['GET', 'HEAD'].includes(next.method ?? 'GET')) throw new Error('source_redirect_denied');
        next.headers = Object.fromEntries(
          Object.entries(next.headers).filter(([key]) => !['authorization', 'cookie'].includes(key.toLowerCase())),
        );
      }
      if (response.statusCode === 303 || ([301, 302].includes(response.statusCode) && next.method === 'POST')) {
        next.method = 'GET';
        next.body = undefined;
      }
      remaining -= response.bytes.length;
      if (remaining <= 0) throw new Error('source_body_limit');
      next.url = url.href;
    }
    throw new Error('source_redirect_limit');
  }
  const read = () => readBrowserSession(scope);
  const state = read();
  const jar = new CookieJar();
  for (const cookie of state.cookies) {
    const domain = String(cookie.domain).replace(/^\./, '');
    if (cookie.expires > 0 && cookie.expires * 1000 <= Date.now()) continue;
    jar.setCookieSync(
      `${cookie.name}=${cookie.value}; Path=${cookie.path}; ${String(cookie.domain).startsWith('.') ? `Domain=${domain};` : ''}${cookie.secure ? 'Secure;' : ''}${cookie.httpOnly ? 'HttpOnly;' : ''}`,
      `${cookie.secure ? 'https' : 'http'}://${domain}`,
      { ignoreError: true },
    );
  }
  const headers = { ...input.headers };
  const userAgent = state.userAgents?.[new URL(input.url).origin];
  if (userAgent && !Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent'))
    headers['user-agent'] = userAgent;
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    const cookie = jar.getCookieStringSync(input.url);
    if (cookie) headers.cookie = cookie;
  }
  const response = await transport(
    { ...input, headers },
    signal,
    scope.privateOrigins,
    maximum,
    scope.outboundProxy,
    followRedirects,
  );
  const received = response.headers['set-cookie'];
  if (received) {
    // Merge against the latest state so concurrent HTTP responses do not discard each other's cookies.
    const latest = read();
    for (const text of Array.isArray(received) ? received : [received]) {
      const cookie = jar.setCookieSync(text, response.url, { ignoreError: true });
      if (!cookie?.domain) continue;
      const domain = cookie.hostOnly ? cookie.domain : '.' + cookie.domain;
      latest.cookies = latest.cookies.filter(
        (old: { name: string; domain: string; path: string }) =>
          !(old.name === cookie.key && old.domain === domain && old.path === cookie.path),
      );
      const expires = cookie.expiryTime() ?? Infinity;
      if (expires <= Date.now()) continue;
      latest.cookies.push({
        name: cookie.key,
        value: cookie.value,
        domain,
        path: cookie.path ?? '/',
        expires: Number.isFinite(expires) ? expires / 1000 : -1,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'none' ? 'None' : 'Lax',
      });
    }
    signal.throwIfAborted();
    writeBrowserSession(scope, latest);
  }
  return response;
}
