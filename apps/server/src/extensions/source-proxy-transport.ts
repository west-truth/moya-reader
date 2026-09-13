import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { SourceTransport } from './source-authentication.js';
import { parseOutboundProxy, pinnedProxyAgent } from './outbound-proxy.js';

function publicHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
    ),
  );
}

/** Operator-owned egress for installed SDK sources. Guest packages never see or select the proxy. */
export function createSourceProxyTransport(proxyValue: string | undefined): SourceTransport {
  const proxy = parseOutboundProxy(proxyValue);
  if (!proxy) return {};
  return {
    transport: (approved, input, signal) =>
      new Promise((resolve, reject) => {
        const agent = pinnedProxyAgent(proxy, approved.url, approved.address.address, signal)!;
        const request = httpsRequest(
          approved.url,
          {
            method: input.method,
            headers: input.headers,
            signal,
            agent,
          },
          (response: IncomingMessage) => {
            response.once('close', () => agent.destroy());
            resolve({ status: response.statusCode ?? 0, headers: publicHeaders(response.headers), body: response });
          },
        );
        request.once('error', (error) => {
          agent.destroy();
          reject(error);
        });
        request.end(input.body);
      }),
  };
}
