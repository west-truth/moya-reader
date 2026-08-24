import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

export interface LocalEndpointAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface LocalEndpointEgressOptions {
  readonly allowedHosts?: readonly string[];
  readonly lookup?: (hostname: string) => Promise<readonly LocalEndpointAddress[]>;
  readonly fetchImpl?: typeof fetch;
}

export interface LocalEndpointRequest {
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

interface ApprovedEndpoint {
  readonly url: URL;
  readonly address: LocalEndpointAddress;
}

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');
loopbackAddresses.addSubnet('::ffff:7f00:0', 104, 'ipv6');

// RFC1918 targets can be admin-allowlisted; infrastructure-only ranges stay blocked unconditionally.
const prohibitedAddresses = new BlockList();
prohibitedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
prohibitedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
prohibitedAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
prohibitedAddresses.addSubnet('240.0.0.0', 4, 'ipv4');
prohibitedAddresses.addAddress('::', 'ipv6');
prohibitedAddresses.addSubnet('fe80::', 10, 'ipv6');
prohibitedAddresses.addSubnet('ff00::', 8, 'ipv6');
prohibitedAddresses.addAddress('fd00:ec2::254', 'ipv6');
prohibitedAddresses.addSubnet('::ffff:0:0', 104, 'ipv6');
prohibitedAddresses.addSubnet('::ffff:a9fe:0', 112, 'ipv6');
prohibitedAddresses.addSubnet('::ffff:e000:0', 100, 'ipv6');
prohibitedAddresses.addSubnet('::ffff:f000:0', 100, 'ipv6');

export async function requestLocalEndpoint(
  endpointUrl: string,
  request: LocalEndpointRequest,
  options: LocalEndpointEgressOptions,
): Promise<Response> {
  const endpoint = await approveLocalEndpoint(endpointUrl, options);
  if (options.fetchImpl) {
    try {
      return await options.fetchImpl(endpoint.url, { ...request, redirect: 'manual' });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw errorWithCause('Local TTS endpoint network request failed', error);
    }
  }
  return requestPinnedEndpoint(endpoint, request);
}

async function approveLocalEndpoint(
  endpointUrl: string,
  options: LocalEndpointEgressOptions,
): Promise<ApprovedEndpoint> {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new Error('Local TTS endpoint URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Local TTS endpoint must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Local TTS endpoint URL credentials are not allowed');
  }
  url.hash = '';

  const hostname = normalizeUrlHostname(url.hostname);
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts ?? []);
  const addressFamily = isIP(hostname);
  if (addressFamily === 4 || addressFamily === 6) {
    const address = { address: hostname, family: addressFamily } as const;
    assertAddressAllowed(address);
    if (!isLoopbackAddress(address) && !allowedHosts.has(hostname)) {
      throw new Error('Local TTS endpoint host is not permitted');
    }
    return { url, address };
  }

  const isLocalhost = hostname === 'localhost';
  if (!isLocalhost && !allowedHosts.has(hostname)) {
    throw new Error('Local TTS endpoint host is not permitted');
  }

  const lookup = options.lookup ?? lookupAddresses;
  let addresses: readonly LocalEndpointAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    throw errorWithCause('Local TTS endpoint DNS lookup failed', error);
  }
  if (!addresses.length) throw new Error('Local TTS endpoint DNS lookup returned no addresses');

  for (const address of addresses) {
    assertAddressAllowed(address);
    if (isLocalhost && !isLoopbackAddress(address)) {
      throw new Error('Local TTS endpoint resolved to a prohibited address');
    }
  }
  return { url, address: normalizedAddress(addresses[0]) };
}

async function lookupAddresses(hostname: string): Promise<readonly LocalEndpointAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => normalizedAddress(address));
}

function normalizeUrlHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function normalizeAllowedHosts(values: readonly string[]): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const value of values) {
    const candidate = value
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (!candidate || candidate.includes('*') || /[\s/@?#]/.test(candidate)) {
      throw new Error('LOCAL_TTS_ALLOWED_HOSTS must contain exact hostnames or IP addresses');
    }
    if (isIP(candidate) === 0 && candidate.includes(':')) {
      throw new Error('LOCAL_TTS_ALLOWED_HOSTS entries must not include ports');
    }
    hosts.add(candidate);
  }
  return hosts;
}

function normalizedAddress(value: { readonly address: string; readonly family: number }): LocalEndpointAddress {
  const address = value.address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if ((family !== 4 && family !== 6) || (value.family !== 4 && value.family !== 6)) {
    throw new Error('Local TTS endpoint resolved to a prohibited address');
  }
  return { address, family };
}

function assertAddressAllowed(value: LocalEndpointAddress): void {
  const address = normalizedAddress(value);
  if (prohibitedAddresses.check(address.address, address.family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error('Local TTS endpoint resolved to a prohibited address');
  }
}

function isLoopbackAddress(value: LocalEndpointAddress): boolean {
  const address = normalizedAddress(value);
  return loopbackAddresses.check(address.address, address.family === 4 ? 'ipv4' : 'ipv6');
}

function requestPinnedEndpoint(endpoint: ApprovedEndpoint, request: LocalEndpointRequest): Promise<Response> {
  if (request.signal?.aborted) return Promise.reject(abortError());

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const cleanup = () => request.signal?.removeEventListener('abort', onAbort);
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    const originalHostname = normalizeUrlHostname(endpoint.url.hostname);
    const requestOptions: https.RequestOptions = {
      protocol: endpoint.url.protocol,
      hostname: endpoint.address.address,
      family: endpoint.address.family,
      port: endpoint.url.port || undefined,
      path: `${endpoint.url.pathname}${endpoint.url.search}`,
      method: request.method,
      headers: { ...request.headers, Host: endpoint.url.host },
      servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
    };
    const send = endpoint.url.protocol === 'https:' ? https.request : http.request;
    const outgoing = send(requestOptions, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.on('error', (error) => {
        rejectOnce(errorWithCause('Local TTS endpoint network request failed', error));
      });
      incoming.on('end', () => {
        const status = incoming.statusCode ?? 500;
        const emptyBodyStatus = status === 204 || status === 205 || status === 304;
        resolveOnce(
          new Response(emptyBodyStatus ? null : Buffer.concat(chunks), {
            status,
            headers: responseHeaders(incoming.headers),
          }),
        );
      });
    });
    const onAbort = () => outgoing.destroy(abortError());
    request.signal?.addEventListener('abort', onAbort, { once: true });
    outgoing.on('error', (error) => {
      rejectOnce(isAbortError(error) ? error : errorWithCause('Local TTS endpoint network request failed', error));
    });
    outgoing.end(request.body);
  });
}

function responseHeaders(input: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function abortError(): Error {
  const error = new Error('Local TTS endpoint request aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}
