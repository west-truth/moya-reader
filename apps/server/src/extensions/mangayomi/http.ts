import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPublicSourceAddress } from '@moya/extension-runtime/source-http';
import { pinnedProxyAgent } from '../outbound-proxy.js';

export interface CompatibilityHttpInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
/** Public web requests pin DNS. Private origins are granted by the owner in the options UI, never by extension code. */
export async function compatibilityHttp(
  input: CompatibilityHttpInput,
  signal: AbortSignal,
  privateOrigins: readonly string[] = [],
  maximum = 768 * 1024,
  outboundProxy?: string,
  followRedirects = true,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  try {
    try {
      return await compatibilityRequest(input, deadline, privateOrigins, maximum, outboundProxy, followRedirects);
    } catch (error) {
      // Replay only reads after transport failure, with one shared deadline. Never replay provider job creation.
      if (
        !['GET', 'HEAD'].includes(input?.method ?? 'GET') ||
        deadline.aborted ||
        !['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(deadline.reason);
        };
        const timer = setTimeout(() => {
          deadline.removeEventListener('abort', cancel);
          resolve();
        }, 250);
        deadline.addEventListener('abort', cancel, { once: true });
        if (deadline.aborted) cancel();
      });
      return await compatibilityRequest(input, deadline, privateOrigins, maximum, outboundProxy, followRedirects);
    }
  } catch (error) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { cause: error });
    if (deadline.aborted) throw Object.assign(new Error('source_request_timeout'), { cause: error });
    if (
      [
        'ECONNRESET',
        'EPIPE',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
        'ECONNREFUSED',
        'ERR_STREAM_PREMATURE_CLOSE',
      ].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw Object.assign(new Error('source_connection_failed'), { cause: error });
    throw error;
  }
}
async function compatibilityRequest(
  input: CompatibilityHttpInput,
  deadline: AbortSignal,
  privateOrigins: readonly string[],
  maximum: number,
  outboundProxy?: string,
  followRedirects = true,
) {
  if (
    !input ||
    !['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'].includes(input.method ?? 'GET') ||
    (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 256 * 1024))
  )
    throw new Error('source_http_failed');
  let url = new URL(input.url);
  let method = input.method ?? 'GET';
  let body = input.body;
  let headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'gzip, deflate, br' };
  if (input.headers && (typeof input.headers !== 'object' || Object.keys(input.headers).length > 32))
    throw new Error('source_http_failed');
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(key) ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      /[\r\n]/.test(value) ||
      /^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(key)
    )
      throw new Error('source_http_failed');
    headers[key.toLowerCase()] = value;
  }
  for (let n = 0; n <= 4; n++) {
    deadline.throwIfAborted();
    if (
      url.href.length > 8192 ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('source_url_denied');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, verbatim: true });
    const local = privateOrigins.includes(url.origin);
    if (!addresses.length || (addresses.some((row) => !isPublicSourceAddress(row.address)) && !local))
      throw new Error('source_address_denied');
    if (url.protocol === 'http:' && !local) throw new Error('source_url_denied');
    const address = addresses[0];
    // Explicitly granted local authentication/content services remain reachable on the host's own network.
    const proxy = pinnedProxyAgent(
      local && !isPublicSourceAddress(address.address) ? undefined : outboundProxy,
      url,
      address.address,
      deadline,
    );
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers,
          signal: deadline,
          agent: proxy ?? false,
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [address]) : callback(null, address.address, address.family),
        },
        resolve,
      );
      req.once('error', reject);
      req.end(body);
    }).catch((error) => {
      proxy?.destroy();
      throw error;
    });
    try {
      if (followRedirects && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (n === 4 || !response.headers.location) throw new Error('source_redirect_limit');
        const next = new URL(response.headers.location, url);
        if (next.origin !== url.origin) {
          if (method !== 'GET' && method !== 'HEAD') throw new Error('source_redirect_denied');
          headers = { ...headers };
          delete headers.authorization;
          delete headers.cookie;
        }
        if (response.statusCode === 303 || ([301, 302].includes(response.statusCode!) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
      const encoding = response.headers['content-encoding'];
      if (encoding && !['gzip', 'br', 'deflate', 'identity'].includes(encoding)) throw new Error('source_http_failed');
      const decoded =
        encoding === 'gzip'
          ? response.pipe(createGunzip())
          : encoding === 'br'
            ? response.pipe(createBrotliDecompress())
            : encoding === 'deflate'
              ? response.pipe(createInflate())
              : response;
      const upstreamError = (error: Error) => decoded.destroy(error);
      if (decoded !== response) response.once('error', upstreamError);
      const abort = () => decoded.destroy(new Error('cancelled'));
      deadline.addEventListener('abort', abort, { once: true });
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const part of decoded) {
          deadline.throwIfAborted();
          size += part.length;
          if (size > maximum) throw new Error('source_body_limit');
          chunks.push(Buffer.from(part));
        }
      } finally {
        deadline.removeEventListener('abort', abort);
        response.removeListener('error', upstreamError);
        if (decoded !== response) decoded.destroy();
      }
      const bytes = Buffer.concat(chunks, size);
      const type = response.headers['content-type'] ?? 'application/octet-stream';
      return {
        bytes,
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        url: url.href,
        contentType: type,
      };
    } finally {
      response.destroy();
      proxy?.destroy();
    }
  }
  throw new Error('source_redirect_limit');
}
