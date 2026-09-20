import type {
  SourceNetworkSettings,
  SourceNetworkSettingsRequest,
} from '../../../../packages/extension-contracts/source-network-settings.js';
import type { SourceCredentialVault } from './source-credential-vault.js';
import { parseOutboundProxy, type SourceProxyOptions } from './outbound-proxy.js';

const scope = JSON.stringify(['host:source-network', 'source-network', 'v1']);

/** Same owner vault as installed sources. Reads on use so changes need no server restart. */
export function createSourceNetworkSettings(
  vault?: SourceCredentialVault,
  environment = process.env.SOURCE_OUTBOUND_PROXY,
) {
  const read = (): SourceNetworkSettings => {
    const secret = vault?.read(scope)?.secret;
    const saved = secret ? (JSON.parse(secret) as { revision: number; defaultProxy: string | null }) : undefined;
    const inherited = !saved || saved.defaultProxy === null;
    const defaultProxy = parseOutboundProxy(inherited ? environment : saved.defaultProxy) ?? '';
    return {
      revision: saved?.revision ?? 0,
      defaultProxy,
      origin: inherited ? (defaultProxy ? 'environment' : 'direct') : 'settings',
    };
  };
  return {
    read,
    save(input: SourceNetworkSettingsRequest): SourceNetworkSettings {
      if (!vault) throw new Error('source_network_unavailable');
      if (
        !input ||
        !Number.isSafeInteger(input.revision) ||
        (typeof input.defaultProxy !== 'string' && input.defaultProxy !== null)
      )
        throw new Error('compatibility_preferences_invalid');
      const defaultProxy = input.defaultProxy === null ? null : (parseOutboundProxy(input.defaultProxy) ?? '');
      if (read().revision !== input.revision) throw new Error('source_network_conflict');
      vault.write(scope, { secret: JSON.stringify({ revision: input.revision + 1, defaultProxy }) });
      return read();
    },
    resolve(options: SourceProxyOptions = {}): string | undefined {
      const mode = options.proxyMode ?? (options.outboundProxy ? 'custom' : 'inherit');
      if (mode === 'direct') return undefined;
      if (mode === 'custom') {
        const proxy = parseOutboundProxy(options.outboundProxy);
        if (!proxy) throw new Error('compatibility_preferences_invalid');
        return proxy;
      }
      return read().defaultProxy || undefined;
    },
  };
}
