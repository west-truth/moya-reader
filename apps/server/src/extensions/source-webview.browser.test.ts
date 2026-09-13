import { mangayomiWebViewScript } from './mangayomi/webview-script.js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceWebViewHost } from './source-webview.js';
import { sourceBrowserHttp } from './source-browser-cookies.js';

describe.skipIf(!process.env.MOYA_TEST_SOURCE_BROWSER)('production source WebView', () => {
  const host = new SourceWebViewHost();
  const secrets = new Map<string, { secret: string }>();
  const vault = {
    read: (key: string) => secrets.get(key),
    write: (key: string, value?: { secret: string }) => {
      if (value) secrets.set(key, value);
      else secrets.delete(key);
    },
  };
  let server: Server, origin: string;
  const scope = (key = 'one') => ({ key, vault, privateOrigins: [origin], origins: [origin] });
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/reader' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<html><body><div id="reader"></div><script>setTimeout(()=>{document.querySelector("#reader").textContent="첫 줄\\n둘째 줄"},80)</script></body></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('executes delayed site JS, follows browser redirects and preserves text', async () => {
    const result = await host.evaluate(
      {
        url: origin + '/redirect',
        script: `new Promise(resolve=>{
      const timer=setInterval(()=>{const text=document.querySelector('#reader').textContent;
      if(text){clearInterval(timer);resolve({text,path:location.pathname})}},20)})`,
      },
      scope(),
      AbortSignal.timeout(15000),
    );
    expect(result).toEqual({ text: '첫 줄\n둘째 줄', path: '/reader' });
  });
  it('restores cookies and storage only within the same source', async () => {
    await host.evaluate(
      {
        url: origin,
        script: `(()=>{document.cookie='session=one; Path=/';localStorage.setItem('saved','yes');return true})()`,
      },
      scope(),
      AbortSignal.timeout(15000),
    );
    const request = { url: origin, script: `({cookie:document.cookie,saved:localStorage.getItem('saved')})` };
    expect(await host.evaluate(request, scope(), AbortSignal.timeout(15000))).toEqual({
      cookie: 'session=one',
      saved: 'yes',
    });
    let cookie = '';
    await sourceBrowserHttp({ url: origin }, AbortSignal.timeout(1000), scope(), 1024, async (input) => {
      cookie = input.headers?.cookie ?? '';
      return {
        statusCode: 200,
        bytes: Buffer.from('ok'),
        headers: { 'set-cookie': ['fromHttp=yes; Path=/'] },
        contentType: 'text/plain',
        url: origin,
      };
    });
    expect(cookie).toBe('session=one');
    expect(
      await host.evaluate({ url: origin, script: 'document.cookie' }, scope(), AbortSignal.timeout(15000)),
    ).toContain('fromHttp=yes');
    expect(await host.evaluate(request, scope('two'), AbortSignal.timeout(15000))).toEqual({ cookie: '', saved: null });
  });
  it('blocks navigation and subrequests outside the source grant', async () => {
    await expect(
      host.evaluate(
        { url: origin, script: 'true' },
        { ...scope(), origins: [], privateOrigins: [] },
        AbortSignal.timeout(15000),
      ),
    ).rejects.toThrow('source_url_denied');
    const result = await host.evaluate(
      { url: origin, script: `fetch('http://localhost:1/secret').then(()=>false,()=>true)` },
      scope(),
      AbortSignal.timeout(15000),
    );
    expect(result).toBe(true);
  });
  it('cancels a pending evaluation and releases its source slot', async () => {
    const abort = new AbortController();
    const pending = host.evaluate({ url: origin, script: 'new Promise(()=>{})' }, scope(), abort.signal);
    setTimeout(() => abort.abort(), 400);
    await expect(pending).rejects.toThrow('cancelled');
    expect(await host.evaluate({ url: origin, script: '42' }, scope(), AbortSignal.timeout(15000))).toBe(42);
  });
  it('supports standard and patched browser sessions, maker callbacks and broker rollback', async () => {
    for (const browserMode of ['browser', 'patchright', 'broker'] as const) {
      const current = { ...scope('engine-' + browserMode), browserMode };
      const script = mangayomiWebViewScript([
        `setTimeout(()=>{document.cookie='callback=done; Path=/';window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({ok:true,ua:navigator.userAgent}))},50)`,
      ]);
      const result = JSON.parse(
        (await host.evaluate(
          { url: origin, script, waitUntil: 'load', headers: { 'User-Agent': 'Moya-test-agent' } },
          current,
          AbortSignal.timeout(15000),
        )) as string,
      );
      expect(result).toEqual({ ok: true, ua: 'Moya-test-agent' });
      await sourceBrowserHttp({ url: origin }, AbortSignal.timeout(1000), current, 1024, async (input) => {
        expect(input.headers).toMatchObject({ cookie: 'callback=done', 'user-agent': 'Moya-test-agent' });
        return { statusCode: 200, headers: {}, bytes: Buffer.from('ok'), contentType: 'text/plain', url: origin };
      });
    }
  });
});
