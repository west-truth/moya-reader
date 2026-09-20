import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture';
import type { VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive';
import { createNodePackageExecution } from './node-package-execution';
import { createSourceNetworkSettings } from './source-network-settings';
import type { SourceCredentialVault } from './source-credential-vault';

const observed = vi.hoisted(() => [] as string[]);
vi.mock('./source-proxy-transport', () => ({
  createSourceProxyTransport: (proxy?: string) =>
    !proxy
      ? {}
      : {
          transport: async () => {
            observed.push(proxy);
            return { status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(['{}']) };
          },
        },
}));
afterEach(() => {
  observed.length = 0;
  vi.unstubAllEnvs();
});

it('routes real SDK broker requests through the saved default while respecting per-source direct/custom choices', async () => {
  vi.stubEnv('SOURCE_OUTBOUND_PROXY', 'http://environment:8080');
  const secrets = new Map<string, { secret: string }>();
  const vault: SourceCredentialVault = {
    read: (key) => secrets.get(key),
    write: (key, value) => {
      if (value) secrets.set(key, value);
    },
  };
  const network = createSourceNetworkSettings(vault);
  network.save({ revision: 0, defaultProxy: 'socks5://shared:1080' });
  const execution = createNodePackageExecution('self-host-gateway', {
    vault,
    transport: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => {
        observed.push('direct');
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(['{}']) };
      },
    },
  });
  const pkg = {
    manifest: examplePackageManifest(),
    digest: 'fixture',
    archive: new Blob(),
    source: `globalThis.moyaExtension=async(method,input,host)=>{await host.request('http.request',{url:'https://catalog.example/list',response:'text'});return {items:[]};};`,
  } as VerifiedMoyaPackage;
  const signal = AbortSignal.timeout(10000),
    source = 'org.example.catalog.source';
  const invoke = () => execution.invoke(pkg, 'source.listWorks', { sourceId: source }, signal, {}, 'epoch');
  await invoke();
  let revision = 0;
  const selections: Record<string, string>[] = [
    { __moya_proxy_mode: 'direct' },
    { __moya_proxy_mode: 'custom', __moya_outbound_proxy: 'http://custom:8080' },
    { __moya_proxy_mode: 'inherit' },
  ];
  for (const changes of selections) {
    await execution.preferences!(
      pkg,
      source,
      'epoch',
      { action: 'save', revision: revision++, changes, privateOrigins: [] },
      signal,
    );
    await invoke();
  }
  network.save({ revision: 1, defaultProxy: '' });
  await invoke();
  expect(observed).toEqual(['socks5://shared:1080', 'direct', 'http://custom:8080/', 'socks5://shared:1080', 'direct']);
});
