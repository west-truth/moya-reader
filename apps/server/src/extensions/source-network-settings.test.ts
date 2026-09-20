import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceNetworkSettings } from './source-network-settings.js';
import { EncryptedSourceCredentialVault } from './source-credential-vault.js';
import { applyProxyChanges } from './outbound-proxy.js';
import { registerSourceNetworkSettingsRoutes } from '../routes/source-network-settings.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('persists a default, preserves legacy overrides and direct exceptions, and rejects stale writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moya-network-'));
  roots.push(root);
  const vault = () => new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 42));
  let settings = createSourceNetworkSettings(vault(), 'http://operator:8080');
  expect(settings.resolve()).toBe('http://operator:8080/');
  const app = Fastify();
  await registerSourceNetworkSettingsRoutes(app, settings);
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/source-network-settings',
    payload: { revision: 0, defaultProxy: 'socks5://proxy:1080' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ revision: 1, defaultProxy: 'socks5://proxy:1080', origin: 'settings' });
  settings = createSourceNetworkSettings(vault(), 'http://operator:8080');
  expect(settings.resolve()).toBe('socks5://proxy:1080');
  expect(settings.resolve({ outboundProxy: 'http://legacy:8080' })).toBe('http://legacy:8080/');
  expect(settings.resolve({ proxyMode: 'direct', outboundProxy: 'http://legacy:8080' })).toBeUndefined();
  expect(settings.resolve({ proxyMode: 'inherit', outboundProxy: 'http://legacy:8080' })).toBe('socks5://proxy:1080');
  for (const [payload, status] of [
    [{ revision: 0, defaultProxy: '' }, 409],
    [{ revision: 1, defaultProxy: 'http://user:secret@proxy:8080' }, 400],
    [{ revision: 1, defaultProxy: 'ftp://proxy' }, 400],
  ] as const)
    expect((await app.inject({ method: 'PUT', url: '/api/source-network-settings', payload })).statusCode).toBe(status);
  expect(settings.read().revision).toBe(1);
  settings.save({ revision: 1, defaultProxy: '' });
  expect(settings.resolve()).toBeUndefined();
  settings.save({ revision: 2, defaultProxy: null });
  expect(settings.resolve()).toBe('http://operator:8080/');
  const options = { outboundProxy: 'http://legacy:8080' };
  applyProxyChanges(options, { __moya_outbound_proxy: '' });
  expect(settings.resolve(options)).toBe('http://operator:8080/');
  expect(() => applyProxyChanges(options, { __moya_proxy_mode: 'custom' })).toThrow(
    'compatibility_preferences_invalid',
  );
  await app.close();
});

it('allows encrypted Mangayomi caches to reopen and rejects oversized writes without replacing saved data', () => {
  const root = mkdtempSync(join(tmpdir(), 'moya-vault-limit-'));
  roots.push(root);
  const vault = new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 1));
  const scope = JSON.stringify(['pkg', 'mangayomi-options', 'epoch']);
  const saved = { secret: JSON.stringify({ values: { status: '가'.repeat(30000), mapping: 'x'.repeat(54000) } }) };
  vault.write(scope, saved);
  expect(new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 1)).read(scope)).toEqual(saved);
  expect(() => vault.write(scope, { secret: 'x'.repeat(1024 * 1024) })).toThrow('source_vault_size_limit');
  expect(vault.read(scope)).toEqual(saved);
  expect(() => vault.write(JSON.stringify(['pkg', 'auth', 'epoch']), saved)).toThrow('source_vault_size_limit');
});
