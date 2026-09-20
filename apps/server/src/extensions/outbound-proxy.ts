import { isIP, Socket } from 'node:net';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import type { ClientRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent, type AgentConnectOpts } from 'agent-base';
import { SocksClient } from 'socks';
import type { CompatibilityPreference } from '../../../../src/extensions/packages/compatibility-preferences.js';

/** Host-owned option. Source scripts cannot select a proxy or weaken destination validation. */
export const OUTBOUND_PROXY_KEY = '__moya_outbound_proxy';
export const PROXY_MODE_KEY = '__moya_proxy_mode';
export interface SourceProxyOptions {
  proxyMode?: 'inherit' | 'direct' | 'custom';
  outboundProxy?: string;
}
export function proxyMode(value: unknown): NonNullable<SourceProxyOptions['proxyMode']> {
  if (value === 'inherit' || value === 'direct' || value === 'custom') return value;
  throw new Error('compatibility_preferences_invalid');
}
export function outboundProxyFields(options: SourceProxyOptions): CompatibilityPreference[] {
  const mode = options.proxyMode ?? (options.outboundProxy ? 'custom' : 'inherit');
  return [
    {
      key: PROXY_MODE_KEY,
      title: '소스 연결 방식',
      kind: 'select',
      secret: false,
      value: mode,
      choices: [
        { label: '기본값 사용', value: 'inherit' },
        { label: '직접 연결', value: 'direct' },
        { label: '개별 프록시', value: 'custom' },
      ],
      summary: '기본값은 콘텐츠 소스의 기본 프록시 설정을 따릅니다. 직접 연결은 기본 프록시를 사용하지 않습니다.',
    },
    outboundProxyField(options.outboundProxy),
  ];
}
/** Old clients only send the address; preserve their implicit custom/inherit selection. */
export function applyProxyChanges(options: SourceProxyOptions, changes: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(changes, OUTBOUND_PROXY_KEY)) {
    options.outboundProxy = parseOutboundProxy(changes[OUTBOUND_PROXY_KEY]);
    if (!Object.prototype.hasOwnProperty.call(changes, PROXY_MODE_KEY))
      options.proxyMode = options.outboundProxy ? 'custom' : 'inherit';
  }
  if (Object.prototype.hasOwnProperty.call(changes, PROXY_MODE_KEY))
    options.proxyMode = proxyMode(changes[PROXY_MODE_KEY]);
  if (options.proxyMode === 'custom' && !options.outboundProxy) throw new Error('compatibility_preferences_invalid');
}
/** Retired fixed-provider DNS preference. Ignore stale clients and discard persisted values. */
export const LEGACY_PROXY_DNS_KEY = '__moya_proxy_dns';
export function outboundProxyField(value?: string): CompatibilityPreference {
  return {
    key: OUTBOUND_PROXY_KEY,
    title: '개별 프록시 주소',
    kind: 'text',
    secret: false,
    value: value ?? '',
    summary:
      '개별 프록시를 선택했을 때 사용합니다. HTTP·HTTPS·SOCKS5 주소를 입력하세요. 주소는 휴대폰이 아닌 서버·앱 실행 환경 기준이며, DNS는 해당 환경의 설정을 따릅니다.',
  };
}
export function parseOutboundProxy(value: unknown): string | undefined {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('compatibility_preferences_invalid');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('compatibility_preferences_invalid');
  }
  if (
    !['http:', 'https:', 'socks5:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    (url.port && Number(url.port) < 1)
  )
    throw new Error('compatibility_preferences_invalid');
  return url.href;
}

/** Keep the approved destination IP, original Host header, TLS hostname and certificate verification. */
export function pinnedProxyAgent(proxy: string | undefined, destination: URL, address: string, signal: AbortSignal) {
  const normalized = parseOutboundProxy(proxy);
  if (!normalized) return undefined;
  const hostname = destination.hostname.replace(/^\[|\]$/g, '');
  const tlsOptions = {
    servername: isIP(hostname) ? undefined : hostname,
    checkServerIdentity: (_name: string, certificate: import('node:tls').PeerCertificate) =>
      checkServerIdentity(hostname, certificate),
  };
  if (normalized.startsWith('socks5:')) {
    const proxyUrl = new URL(normalized);
    return new (class extends Agent {
      async connect(_req: ClientRequest, options: AgentConnectOpts) {
        signal.throwIfAborted();
        const socket = new Socket({ signal });
        try {
          const connected = once(socket, 'connect', { signal });
          socket.connect(Number(proxyUrl.port || 1080), proxyUrl.hostname.replace(/^\[|\]$/g, ''));
          await connected;
          await SocksClient.createConnection({
            proxy: { host: proxyUrl.hostname, port: Number(proxyUrl.port || 1080), type: 5 },
            destination: { host: address, port: Number(options.port) },
            command: 'connect',
            existing_socket: socket,
            timeout: 15000,
          });
          signal.throwIfAborted();
          return options.secureEndpoint ? connectTls({ ...options, ...tlsOptions, socket }) : socket;
        } catch (error) {
          socket.destroy();
          throw Object.assign(new Error('source_connection_failed'), { cause: error });
        }
      }
    })();
  }
  const agent = new HttpsProxyAgent(normalized, { signal, timeout: 15000 });
  const connect = agent.connect.bind(agent);
  agent.connect = async (req, options) => {
    signal.throwIfAborted();
    const pinnedOptions = { ...options, host: address, ...tlsOptions };
    const socket = await connect(req, pinnedOptions);
    if (signal.aborted) {
      socket.destroy();
      signal.throwIfAborted();
    }
    return socket;
  };
  return agent;
}
