import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CloudVaultLocalStateStore, resetCloudVaultLocalStateForTests } from './local-state';

describe('CloudVaultLocalStateStore', () => {
  beforeEach(async () => resetCloudVaultLocalStateForTests());

  it('defaults remembered-device and automatic sync preferences on', async () => {
    const config = await new CloudVaultLocalStateStore().getConfig();

    expect(config.rememberPassphrase).toBe(true);
    expect(config.autoSync).toBe(true);
  });

  it('restores and clears a passphrase sealed for this browser database', async () => {
    const first = new CloudVaultLocalStateStore();
    await first.saveRememberedPassphrase('12345678');

    await expect(new CloudVaultLocalStateStore().getRememberedPassphrase()).resolves.toBe('12345678');

    await first.clearRememberedPassphrase();
    await expect(first.getRememberedPassphrase()).resolves.toBeUndefined();
  });
});
