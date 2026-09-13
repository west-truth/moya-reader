import { openSourceBrowserProxy } from './source-browser-proxy.js';
import { readBrowserSession, mergeBrowserSession } from './source-browser-session.js';
import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import {
  validSourceWebViewRequest,
  type SourceWebViewRequest,
} from '../../../../packages/extension-contracts/source-webview.js';
import { compatibilityHttp } from './mangayomi/http.js';
import type { SourceCredentialVault } from './source-credential-vault.js';

export interface SourceWebViewScope {
  /** Package/source/credential epoch in the owner's vault; never supplied by guest code. */
  key: string;
  vault?: SourceCredentialVault;
  /** Undefined only for the already-reviewed compatibility runtime's public network grant. */
  origins?: readonly string[];
  privateOrigins?: readonly string[];
  outboundProxy?: string;
  browserMode?: 'browser' | 'broker' | 'patchright';
}

/** A warm browser shared by jobs, with separate, short-lived contexts for each source invocation. */
export class SourceWebViewHost {
  private browsers = new Map<string, Promise<Browser>>();
  private idle?: ReturnType<typeof setTimeout>;
  private pending = 0;
  private active = 0;
  private scopes = new Set<string>();
  private wake = new Set<() => void>();
  constructor(private readonly transport = compatibilityHttp) {}

  private async launch(engine: string): Promise<Browser> {
    clearTimeout(this.idle);
    if (!this.browsers.has(engine)) {
      this.browsers.set(
        engine,
        (async () => {
          const launcher =
            engine === 'patchright' ? ((await import('patchright')).chromium as unknown as typeof chromium) : chromium;
          const args = ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
          const configured = process.env.MOYA_SOURCE_BROWSER_EXECUTABLE;
          if (configured) return launcher.launch({ executablePath: configured, headless: true, args });
          if (process.platform === 'win32') return launcher.launch({ channel: 'msedge', headless: true, args });
          for (const executablePath of [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ]) {
            if (
              await access(executablePath).then(
                () => true,
                () => false,
              )
            )
              return launcher.launch({ executablePath, headless: true, args });
          }
          return launcher.launch({ headless: true, args });
        })().catch((error) => {
          this.browsers.delete(engine);
          throw new Error('source_browser_unavailable', { cause: error });
        }),
      );
    }
    const browser = await this.browsers.get(engine)!;
    if (!browser.isConnected()) {
      this.browsers.delete(engine);
      return this.launch(engine);
    }
    return browser;
  }

  async evaluate(input: SourceWebViewRequest, scope: SourceWebViewScope, signal: AbortSignal): Promise<unknown> {
    if (!validSourceWebViewRequest(input)) throw new Error('invalid_source_invocation');
    const permitted = (raw: string) => {
      const url = new URL(raw);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (scope.origins && !scope.origins.includes(url.origin) && !scope.privateOrigins?.includes(url.origin))
      )
        throw new Error('source_url_denied');
      return url;
    };
    const initial = permitted(input.url);
    if (this.pending >= 64) throw new Error('execution_busy');
    this.pending++;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs ?? 60000)]);
    const mode =
      scope.browserMode ??
      (process.env.MOYA_SOURCE_BROWSER_MODE === 'broker'
        ? 'broker'
        : process.env.MOYA_SOURCE_BROWSER_MODE === 'patchright'
          ? 'patchright'
          : 'browser');
    let proxy: Awaited<ReturnType<typeof openSourceBrowserProxy>> | undefined;
    let context: BrowserContext | undefined;
    let admitted = false;
    const notify = () => {
      for (const next of [...this.wake]) next();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (deadline.aborted) {
            cleanup();
            reject(new Error(signal.aborted ? 'cancelled' : 'source_request_timeout'));
          } else if (this.active < 2 && !this.scopes.has(scope.key)) {
            this.active++;
            this.scopes.add(scope.key);
            admitted = true;
            cleanup();
            resolve();
          }
        };
        const cleanup = () => {
          this.wake.delete(check);
          deadline.removeEventListener('abort', check);
        };
        this.wake.add(check);
        deadline.addEventListener('abort', check, { once: true });
        check();
      });
      const browser = await this.launch(mode === 'patchright' ? 'patchright' : 'chromium');
      deadline.throwIfAborted();
      const saved = readBrowserSession(scope);
      const suppliedHeaders = Object.fromEntries(
        Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const userAgent = suppliedHeaders['user-agent'] ?? saved.userAgents?.[initial.origin];
      if (mode !== 'broker') proxy = await openSourceBrowserProxy(scope, deadline);
      context = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 390, height: 844 },
        storageState: { cookies: saved.cookies, origins: saved.origins },
        ...(userAgent ? { userAgent } : {}),
        ...(proxy ? { proxy: proxy.proxy } : {}),
      });
      if (suppliedHeaders.cookie) {
        const cookies = suppliedHeaders.cookie.split(';').flatMap((part) => {
          const index = part.indexOf('=');
          return index > 0
            ? [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: initial.origin + '/' }]
            : [];
        });
        await context.addCookies(cookies);
        delete suppliedHeaders.cookie;
      }
      const close = () => {
        void context?.close().catch(() => undefined);
      };
      deadline.addEventListener('abort', close, { once: true });
      let requests = 0,
        total = 0;
      let navigationFailure: string | undefined;
      try {
        deadline.throwIfAborted();
        await context.routeWebSocket('**/*', (socket) => socket.close());
        const visited = new Set<string>();
        await context.route('**/*', async (route) => {
          try {
            const request = route.request();
            const url = permitted(request.url());
            if (++requests > 512 || total > 32 * 1024 * 1024) throw new Error('source_body_limit');
            const headers = await request.allHeaders();
            delete headers.host;
            delete headers['content-length'];
            delete headers.connection;
            if (url.origin === initial.origin) Object.assign(headers, suppliedHeaders);
            // Browser cookies are managed by its own jar; avoid overriding cross-origin credentials.
            if (mode !== 'broker') {
              visited.add(url.origin);
              if (url.origin !== initial.origin && suppliedHeaders.authorization === headers.authorization)
                delete headers.authorization;
              await route.continue(Object.keys(suppliedHeaders).length ? { headers } : undefined);
              return;
            }
            const response = await this.transport(
              { url: url.href, method: request.method(), headers, body: request.postData() ?? undefined },
              deadline,
              scope.privateOrigins,
              8 * 1024 * 1024,
              scope.outboundProxy,
              false,
            );
            total += response.bytes.length;
            if (total > 32 * 1024 * 1024) throw new Error('source_body_limit');
            const resultHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined && !/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(key))
                resultHeaders[key] = Array.isArray(value) ? value.join('\n') : String(value);
            await route.fulfill({ status: response.statusCode, headers: resultHeaders, body: response.bytes });
          } catch (error) {
            if (route.request().isNavigationRequest()) navigationFailure = (error as Error).message;
            await route.abort('failed').catch(() => undefined);
          }
        });
        const page = await context.newPage();
        page.on('popup', (popup) => {
          void popup.close().catch(() => undefined);
        });
        let response = await page.goto(input.url, { waitUntil: input.waitUntil ?? 'domcontentloaded', timeout: 0 });
        if (mode !== 'broker' && [403, 503].includes(response?.status() ?? 0)) {
          response = await page
            .waitForResponse(
              (res) => res.request().isNavigationRequest() && res.frame() === page.mainFrame() && res.ok(),
              { timeout: 10000 },
            )
            .catch(() => response!);
          if (response?.ok()) await page.waitForLoadState(input.waitUntil ?? 'domcontentloaded', { timeout: 10000 });
        }
        if (!response?.ok())
          throw new Error(
            response?.status() === 401 || response?.status() === 403 ? 'source_auth_required' : 'source_http_failed',
          );
        const result: unknown =
          mode === 'patchright'
            ? await (page as unknown as import('patchright').Page).evaluate(input.script, undefined, false)
            : await page.evaluate(input.script);
        deadline.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(result) ?? 'null') > 2 * 1024 * 1024) throw new Error('source_body_limit');
        const state = await context.storageState();
        const actualAgent = await page.evaluate(() => navigator.userAgent);
        deadline.throwIfAborted();
        if (proxy?.failure === 'source_body_limit') throw new Error(proxy.failure);
        visited.add(initial.origin);
        mergeBrowserSession(
          scope,
          saved,
          state,
          Object.fromEntries([...visited].slice(0, 64).map((origin) => [origin, actualAgent])),
        );
        return result ?? null;
      } catch (error) {
        if (deadline.aborted)
          throw new Error(signal.aborted ? 'cancelled' : 'source_request_timeout', { cause: error });
        const safe = navigationFailure ?? proxy?.failure ?? (error as Error).message;
        throw new Error(/^source_[a-z_]+$/.test(safe) ? safe : 'source_browser_failed', { cause: error });
      } finally {
        deadline.removeEventListener('abort', close);
      }
    } finally {
      await context?.close().catch(() => undefined);
      proxy?.close();
      this.pending--;
      if (admitted) {
        this.active--;
        this.scopes.delete(scope.key);
      }
      notify();
      if (!this.pending) {
        this.idle = setTimeout(
          () => {
            void this.close();
          },
          5 * 60 * 1000,
        );
        this.idle.unref();
      }
    }
  }

  async close() {
    clearTimeout(this.idle);
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(browsers.map((browser) => browser.then((value) => value.close()).catch(() => undefined)));
  }
}

export const sourceWebViewHost = new SourceWebViewHost();
