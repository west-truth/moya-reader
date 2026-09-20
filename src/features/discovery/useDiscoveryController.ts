import { useEffect, useMemo, useState } from 'react';
import { useOptionalSelfHostAuth } from '../auth/SelfHostAccountGate';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import { readConfig, writeConfig, type DiscoveryConfig } from './discovery-config';
import { DiscoverySession } from './discovery-session';
export function useDiscoveryController(
  registry: ExternalSourceRegistryPort,
  context: TrustedExternalSourceHostContext,
  serverScope = 'local',
) {
  const auth = useOptionalSelfHostAuth();
  const scope = `${location.origin}:${serverScope}:${auth?.account.username ?? 'local'}`;
  const [active, setActive] = useState(false);
  const [saved, setSaved] = useState(() => ({ scope, config: readConfig(scope) }));
  const config = useMemo(() => (saved.scope === scope ? saved.config : readConfig(scope)), [saved, scope]);
  const session = useMemo(() => new DiscoverySession(registry, context, scope), [registry, context, scope]);
  useEffect(() => session.mount(), [session]);
  return {
    active,
    setActive,
    scope,
    session,
    config,
    save(config: DiscoveryConfig) {
      writeConfig(scope, config);
      setSaved({ scope, config });
    },
  };
}
export type DiscoveryController = ReturnType<typeof useDiscoveryController>;
