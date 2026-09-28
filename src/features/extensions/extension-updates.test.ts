import { expect, it, vi } from 'vitest';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import type { SourceExtensionManager } from '../../external-sources/extension-management';
import { findExtensionUpdates } from './extension-updates';

it('discovers Moya, APK, Mangayomi and Suwayomi updates without authorizing installation', async () => {
  const compatibility = (format: string) => ({
    list: vi.fn(async () => ({
      packages: [
        { pkg: 'new', code: 10, version: '1.0' },
        { pkg: 'old', code: 10, version: '1.0' },
      ],
      repositories: [
        {
          url: 'https://example.test/index.json',
          entries: [
            { pkg: 'new', name: 'New', code: format === 'apk' ? 11 : 9, version: '1.1', format },
            { pkg: 'old', name: 'Old', code: 9, version: '0.9', format },
          ],
        },
      ],
    })),
    refreshRepository: vi.fn(),
    inspectRepository: vi.fn(),
    install: vi.fn(),
  });
  const apk = compatibility('apk');
  const mangayomi = compatibility('mangayomi-js');
  const manager = {
    getSnapshot: () => ({
      packages: [
        {
          id: 'moya',
          revision: 1,
          active: { manifest: { updates: {}, extension: { name: 'Moya source', version: '1' } } },
        },
      ],
    }),
    checkUpdate: vi.fn(async () => ({ plan: { package: { manifest: { extension: { version: '2' } } } } })),
    apk,
    mangayomi,
    install: vi.fn(),
  } as unknown as InstalledExtensionManager;
  const suwayomi = {
    refresh: vi.fn(async () => ({
      extensions: [
        { id: 'remote', installed: true, hasUpdate: true, name: 'Remote', version: '2' },
        { id: 'uninstalled', installed: false, hasUpdate: true },
      ],
    })),
    change: vi.fn(),
  } as unknown as SourceExtensionManager;
  const result = await findExtensionUpdates(manager, suwayomi, new AbortController().signal);
  expect(result.updates.map((update) => update.id)).toEqual([
    'moya:moya',
    'Mangayomi:https://example.test/index.json:new',
    'APK:https://example.test/index.json:new',
    'suwayomi:remote',
  ]);
  expect(result.failures).toEqual([]);
  expect(apk.refreshRepository).toHaveBeenCalledOnce();
  expect(mangayomi.refreshRepository).toHaveBeenCalledOnce();
  expect(apk.inspectRepository).not.toHaveBeenCalled();
  expect(mangayomi.install).not.toHaveBeenCalled();
  expect(manager.install).not.toHaveBeenCalled();
  expect(suwayomi.change).not.toHaveBeenCalled();
});

it('continues with other backends when one cannot connect', async () => {
  const manager = {
    getSnapshot: () => ({ packages: [] }),
    apk: { list: vi.fn().mockRejectedValue(Error('offline')) },
  } as unknown as InstalledExtensionManager;
  const suwayomi = {
    refresh: vi.fn(async () => ({ extensions: [{ id: 'remote', installed: true, hasUpdate: true }] })),
  } as unknown as SourceExtensionManager;
  const result = await findExtensionUpdates(manager, suwayomi, new AbortController().signal);
  expect(result.updates).toHaveLength(1);
  expect(result.failures).toHaveLength(1);
});
