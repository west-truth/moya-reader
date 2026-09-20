import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useOptionalSelfHostAuth } from '../auth/SelfHostAccountGate';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { DiscoverySettingsStore } from './discovery-settings-store';
import { DiscoverySession } from './discovery-session';
export function useDiscoveryController(
  registry: ExternalSourceRegistryPort,
  context: TrustedExternalSourceHostContext,
  serverScope = 'local',
  client?: RemoteApiClient,
) {
  const auth = useOptionalSelfHostAuth();
  const scope = `${location.origin}:${serverScope}:${auth?.account.username ?? 'local'}`;
  const [active, setActive] = useState(false);
  const store = useMemo(() => new DiscoverySettingsStore(scope, client), [scope, client]);
  const shared = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => store.mount(), [store]);
  useEffect(() => {
    if (!active || !client) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void store.refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, client, store]);
  const session = useMemo(() => new DiscoverySession(registry, context, scope), [registry, context, scope]);
  useEffect(() => session.mount(), [session]);
  return {
    active,
    setActive,
    scope,
    session,
    ...shared,
    refresh: store.refresh,
    save: store.save,
  };
}
export type DiscoveryController = ReturnType<typeof useDiscoveryController>;
