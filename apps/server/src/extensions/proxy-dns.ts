import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { pinnedProxyAgent } from './outbound-proxy.js';
import type { CompatibilityPreference } from '../../../../src/extensions/packages/compatibility-preferences.js';

export const PROXY_DNS_KEY = '__moya_proxy_dns';
export type ProxyDnsMode = 'local' | 'proxy';
export function proxyDnsMode(value: unknown): ProxyDnsMode {
  if (value == null || value === '' || value === 'local') return 'local';
  if (value === 'proxy') return value;
  throw new Error('compatibility_preferences_invalid');
}
export function proxyDnsField(value?: ProxyDnsMode): CompatibilityPreference {
  return {
    key: PROXY_DNS_KEY,
    title: '프록시 DNS',
    kind: 'select',
    secret: false,
    value: value ?? 'local',
    summary:
      '프록시 경유는 Cloudflare 암호화 DNS를 같은 프록시로 조회합니다. 프록시 주소를 설정해야 적용되며, 운영체제 VPN 경로는 변경하지 않습니다.',
    choices: [
      { label: '로컬 DNS + 프록시', value: 'local' },
      { label: '프록시 경유 DNS + 프록시', value: 'proxy' },
    ],
  };
}

type Address = { address: string; family: number };
const cache = new Map<string, { until: number; addresses: Address[] }>();
/** Resolve through the same egress, then let callers validate and pin every destination IP.
 * A fixed DoH bootstrap IP avoids a local DNS dependency, including for the resolver itself.
 * No local fallback on failure: that would silently restore the blocked route.
 */
export async function resolveProxyAddress(
  host: string,
  proxy?: string,
  mode: ProxyDnsMode = 'local',
  signal = AbortSignal.timeout(10000),
): Promise<Address[]> {
  signal.throwIfAborted();
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  if (!proxy || mode === 'local') return lookup(host, { all: true, verbatim: true });
  const key = JSON.stringify([proxy, host]);
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.addresses;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  try {
    const results = await Promise.all(
      [1, 28].map(async (type) => {
        const url = new URL('https://cloudflare-dns.com/dns-query');
        url.search = new URLSearchParams({ name: host, type: String(type) }).toString();
        const agent = pinnedProxyAgent(proxy, url, '1.1.1.1', deadline)!;
        try {
          const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
            const req = request(url, { agent, signal: deadline, headers: { accept: 'application/dns-json' } }, resolve);
            req.once('error', reject);
            req.end();
          });
          if (response.statusCode !== 200) {
            response.destroy();
            throw new Error('source_dns_failed');
          }
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of response) {
            length += chunk.length;
            if (length > 64 * 1024) {
              response.destroy();
              throw new Error('source_dns_failed');
            }
            chunks.push(Buffer.from(chunk));
          }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.Status !== 0) throw new Error('source_dns_failed');
          return (Array.isArray(data.Answer) ? data.Answer : []).filter(
            (row: { type: number; data: string }) => row.type === type && isIP(row.data) === (type === 1 ? 4 : 6),
          ) as { data: string; TTL: number }[];
        } finally {
          agent.destroy();
        }
      }),
    );
    const rows = results.flat();
    const addresses = rows.map((row) => ({ address: row.data, family: isIP(row.data) }));
    if (!addresses.length) throw new Error('source_dns_failed');
    const ttl = Math.min(60, ...rows.map((row) => (Number.isFinite(row.TTL) ? Math.max(0, row.TTL) : 0)));
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + ttl * 1000, addresses });
    return addresses;
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error('source_dns_failed', { cause });
  }
}
