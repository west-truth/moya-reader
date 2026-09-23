import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { SwitchableSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import { createSourceNetworkSettings } from '../../apps/server/src/extensions/source-network-settings';
import { startNativeExtensionHost } from './native-host';

describe('native vault transitions', () => {
  it('keeps session settings through encryption and reopening and never falls back while locked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moya-vault-'));
    try {
      const key = Buffer.alloc(32, 23);
      const vault = new SwitchableSourceCredentialVault(directory);
      const network = createSourceNetworkSettings(vault, '');
      const saved = network.save({ revision: 0, defaultProxy: 'socks5://127.0.0.1:1080' });
      vault.switchKey(key);
      expect(network.read()).toEqual(saved);
      vault.switchKey();
      expect(() => network.resolve()).toThrow('source_vault_locked');
      expect(() => network.save({ revision: 1, defaultProxy: '' })).toThrow('source_vault_locked');
      const reopened = new SwitchableSourceCredentialVault(directory, undefined, true);
      expect(() => createSourceNetworkSettings(reopened).read()).toThrow('source_vault_locked');
      reopened.switchKey(key);
      expect(createSourceNetworkSettings(reopened).read()).toEqual(saved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a vault transition during an active request without cancelling that request', async () => {
    const token = 'a'.repeat(64);
    const host = await startNativeExtensionHost(token, 'http://tauri.localhost');
    const change = vi.fn();
    const pending = request(host.endpoint + '/network-settings', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': '2' },
    });
    const response = new Promise<number | undefined>((resolve, reject) => {
      pending.on('response', (reply) => {
        reply.resume();
        reply.on('end', () => resolve(reply.statusCode));
      });
      pending.on('error', reject);
    });
    try {
      pending.write('{');
      await vi.waitFor(() => expect(() => host.whenIdle(change)).toThrow('source_vault_busy'));
      change.mockClear();
      pending.end('}');
      expect(await response).toBe(200);
      host.whenIdle(change);
      expect(change).toHaveBeenCalledOnce();
    } finally {
      pending.destroy();
      await host.close();
    }
  });
});
