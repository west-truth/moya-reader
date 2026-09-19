import { watch, type FSWatcher } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { relative, resolve } from 'node:path';
import {
  formatDeveloperError,
  ignoredDevelopmentPath,
  runDevelopmentIteration,
  type DevelopmentOptions,
} from './development';

interface PreviewState {
  readonly status: 'ready' | 'error';
  readonly sequence: number;
  readonly callId: string;
  readonly changed?: string;
  readonly durationMs: number;
  readonly current?: Awaited<ReturnType<typeof runDevelopmentIteration>>;
  readonly lastGood?: Awaited<ReturnType<typeof runDevelopmentIteration>>;
  readonly error?: string;
}

export interface DevelopmentPreviewServer {
  readonly url: string;
  readonly stateUrl: string;
  close(): Promise<void>;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moya extension preview</title><link rel="stylesheet" href="/style.css"></head>
<body><main><header><div><p class="eyebrow">Moya extension SDK</p><h1>Local extension preview</h1></div><span id="status">Starting</span></header>
<p id="meta" class="meta"></p><section><h2>Last successful result</h2><pre id="result">Waiting for the first run…</pre></section>
<section id="failure" hidden><h2>Current error</h2><pre id="error"></pre></section><p class="note">Bound to 127.0.0.1. Downloaded text and image bytes are never rendered here.</p></main>
<script type="module" src="/app.js"></script></body></html>`;

const css = `:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#101512;color:#edf4ee}body{margin:0}main{max-width:880px;margin:0 auto;padding:40px 20px}header{display:flex;align-items:center;justify-content:space-between;gap:20px}.eyebrow{color:#8cc59d;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;margin:0}h1{margin:.25rem 0 0;font-size:clamp(1.8rem,5vw,3rem)}h2{font-size:1rem;color:#b7c9bc}#status{border:1px solid #536459;border-radius:999px;padding:.45rem .8rem}.ready{color:#9ee2ad}.error{color:#ffb4a7}section{background:#18201b;border:1px solid #344239;border-radius:14px;padding:18px;margin-top:18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px/1.55 ui-monospace,SFMono-Regular,monospace}.meta,.note{color:#aab9ae}.note{font-size:.85rem;margin-top:20px}`;

const app = `const status=document.querySelector('#status'),meta=document.querySelector('#meta'),result=document.querySelector('#result'),failure=document.querySelector('#failure'),error=document.querySelector('#error');
async function refresh(){try{const state=await fetch('/state',{cache:'no-store'}).then(r=>r.json());status.textContent=state.status==='ready'?'Ready':'Build failed';status.className=state.status;const value=state.current??state.lastGood;meta.textContent=[state.callId,value?.id,value?.version,value?.method].filter(Boolean).join(' · ');if(value)result.textContent=JSON.stringify(value,null,2);failure.hidden=state.status!=='error';error.textContent=state.error??'';}catch{status.textContent='Disconnected';status.className='error';}}refresh();setInterval(refresh,750);`;

export async function startDevelopmentPreview(
  folder: string,
  options: DevelopmentOptions,
): Promise<DevelopmentPreviewServer> {
  let sequence = 0;
  let lastGood: Awaited<ReturnType<typeof runDevelopmentIteration>> | undefined;
  let state!: PreviewState;
  let active = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;
  const execute = async (changed?: string) => {
    if (active) {
      queued = true;
      return;
    }
    active = true;
    const started = Date.now();
    const callId = `preview-${sequence + 1}`;
    try {
      const current = await runDevelopmentIteration(folder, options);
      lastGood = current;
      state = {
        status: 'ready',
        sequence: ++sequence,
        callId,
        changed,
        durationMs: Date.now() - started,
        current,
        lastGood,
      };
    } catch (previewError) {
      state = {
        status: 'error',
        sequence: ++sequence,
        callId,
        changed,
        durationMs: Date.now() - started,
        lastGood,
        error: formatDeveloperError(previewError),
      };
    } finally {
      active = false;
      if (queued) {
        queued = false;
        void execute('queued changes');
      }
    }
  };
  await execute();
  const server = createServer((request, response) => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (request.url === '/') return send(response, 200, 'text/html; charset=utf-8', html);
    if (request.url === '/style.css') return send(response, 200, 'text/css; charset=utf-8', css);
    if (request.url === '/app.js') return send(response, 200, 'text/javascript; charset=utf-8', app);
    if (request.url === '/state') return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(state));
    return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('preview_listen_failed');
  const watcher = watch(folder, { recursive: true }, (_event, fileName) => {
    const changed = fileName?.toString() ?? '';
    if (!changed || ignoredDevelopmentPath(changed)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void execute(relative(process.cwd(), resolve(folder, changed))), 120);
  });
  return {
    url: `http://127.0.0.1:${address.port}/`,
    stateUrl: `http://127.0.0.1:${address.port}/state`,
    close: async () => close(server, watcher, timer),
  };
}

function send(response: import('node:http').ServerResponse, status: number, type: string, body: string) {
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

async function listen(server: Server) {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
}

async function close(server: Server, watcher: FSWatcher, timer?: NodeJS.Timeout) {
  if (timer) clearTimeout(timer);
  watcher.close();
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}
