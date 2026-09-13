import { mangayomiWebViewScript } from './webview-script.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runExtension } from '@moya/extension-runtime';
import type { MangayomiEntry } from '../../../../../packages/extension-contracts/compatibility-repository.js';
import { mangayomiBootstrap, mangayomiDispatch } from './bootstrap.js';
import { compatibilityHttp, type CompatibilityHttpInput } from './http.js';
import type { SourceWebViewRequest } from '../../../../../packages/extension-contracts/source-webview.js';

export type PreferenceValues = Record<string, string | number | boolean | null>;
export interface MangayomiInvocation {
  entry: MangayomiEntry;
  source: string;
  action: string;
  params?: Record<string, unknown>;
  preferences?: PreferenceValues;
  privateOrigins?: readonly string[];
  webview?: (request: SourceWebViewRequest, signal: AbortSignal) => Promise<unknown>;
  signal: AbortSignal;
}
let dom: Promise<string> | undefined;
async function domSource() {
  dom ??= readFile(join(dirname(createRequire(import.meta.url).resolve('linkedom')), '../worker.js'), 'utf8').then(
    (source) => {
      if (!/\nexport \{[^}]+\};\s*$/.test(source) || source.length > 1024 * 1024)
        throw new Error('compatibility_runtime_unavailable');
      return (
        '(function(){\n' +
        source.replace(/\nexport \{[^}]+\};\s*$/, '\nglobalThis.__moyaParseHTML=parseHTML;') +
        '\n})();'
      );
    },
  );
  return dom;
}
/** The bundled DOM library and adapter execute in the same bounded WASM realm as the original source. */
export async function invokeMangayomi(input: MangayomiInvocation, transport = compatibilityHttp) {
  if (input.entry.format !== 'mangayomi-js' || Buffer.byteLength(input.source) > 1024 * 1024)
    throw new Error('compatibility_feature_unsupported');
  let requests = 0,
    bytes = 0;
  let lastTransportFailure: string | undefined;
  const value = (await runExtension({
    source:
      (await domSource()) +
      '\nconst sourceMetadata=' +
      JSON.stringify(input.entry) +
      ';\n' +
      mangayomiBootstrap +
      '\n' +
      input.source +
      '\n' +
      mangayomiDispatch,
    method: 'invoke',
    input: { action: input.action, params: input.params, preferences: input.preferences },
    profile: 'mangayomi-v1',
    timeoutMs: input.action === 'chapters' ? 10 * 60_000 : ['pages', 'html'].includes(input.action) ? 150000 : 30000,
    memoryBytes: 64 * 1024 * 1024,
    signal: input.signal,
    broker: {
      'compatibility.webview': async (raw, signal) => {
        const request = raw as { url: string; headers?: Record<string, string>; scripts?: unknown };
        if (['preferences', 'metadata'].includes(input.action) || !input.webview)
          throw new Error('source_browser_unavailable');
        if (
          !Array.isArray(request?.scripts) ||
          request.scripts.length > 32 ||
          request.scripts.some((script) => typeof script !== 'string' || script.length > 65536)
        )
          throw new Error('invalid_source_invocation');
        return await input.webview(
          {
            url: request.url,
            headers: request.headers,
            script: mangayomiWebViewScript(request.scripts as string[]),
            waitUntil: 'load',
            timeoutMs: 25000,
          },
          signal,
        );
      },
      'compatibility.http': async (raw, signal) => {
        if (['preferences', 'metadata'].includes(input.action) || ++requests > 240)
          throw new Error('permission_denied');
        let response: Awaited<ReturnType<typeof transport>>;
        try {
          response = await transport(raw as CompatibilityHttpInput, signal, input.privateOrigins);
          lastTransportFailure = undefined;
        } catch (error) {
          if (
            [
              'source_connection_failed',
              'source_request_timeout',
              'source_address_denied',
              'source_body_limit',
            ].includes((error as Error).message)
          )
            lastTransportFailure = (error as Error).message;
          throw error;
        }
        bytes += response.bytes.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('source_body_limit');
        const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] ?? 'utf-8';
        let body: string;
        try {
          body = new TextDecoder(charset).decode(response.bytes);
        } catch {
          throw new Error('source_encoding_unsupported');
        }
        return { statusCode: response.statusCode, headers: response.headers, body };
      },
      'compatibility.sleep': async (raw, signal) => {
        const delay = Number((raw as { delay?: unknown })?.delay);
        if (!Number.isFinite(delay) || delay < 0 || delay > 10000) throw new Error('permission_denied');
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error('cancelled'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
          }, delay);
          signal.addEventListener('abort', cancel, { once: true });
        });
        return null;
      },
    },
  }).catch((error) => {
    // Some original scripts replace transport exceptions with their own text. Preserve only safe host diagnostics.
    if (error?.message === 'execution_failed' && lastTransportFailure) throw new Error(lastTransportFailure);
    throw error;
  })) as { result: unknown; changes: PreferenceValues };
  if (!value || !value.changes || typeof value.changes !== 'object' || Object.keys(value.changes).length > 256)
    throw new Error('invalid_source_result');
  return value;
}
