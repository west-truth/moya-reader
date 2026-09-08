import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../repositories/reader-defaults';
import type { ReaderSettings } from '../domain/types';
import { RemoteReaderRepository } from '../repositories/remote-reader-repository';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { IndexedDbCloudVaultArtifactRepository } from '../cloud-vault/indexeddb-artifact-repository';
import { DEFAULT_CLOUD_VAULT_SCOPE } from '../cloud-vault/contracts';
import { mergeCloudVaultSnapshots } from '../cloud-vault/merge';
import { getSettings, saveSettings, resetReaderDbForTests, listSyncOutbox, applyRemoteSyncEvents } from './db';
import { putItem } from './indexeddb-transaction';

beforeEach(() => resetReaderDbForTests());

describe('device reader settings boundary', () => {
  it('preserves an unmigrated local profile before applying a legacy remote settings event', async () => {
    await putItem('settings', { ...defaultSettings, fontSize: 26, applicationTheme: 'sepia' });
    await applyRemoteSyncEvents([
      {
        id: 'remote-legacy-settings',
        type: 'settings_updated',
        deviceId: 'server',
        entityId: 'reader-settings',
        createdAt: '2099-01-01T00:00:00.000Z',
        payload: { settings: { id: 'reader-settings', fontSize: 12, applicationTheme: 'light', ttsSpeed: 1.6 } },
      },
    ]);
    expect(await getSettings()).toMatchObject({ fontSize: 26, applicationTheme: 'sepia', ttsSpeed: 1.6 });
  });
  it('seeds legacy local settings once and saves presentation without adding sync work', async () => {
    await putItem('settings', { ...defaultSettings, fontSize: 23, applicationTheme: 'sepia' });
    expect(await getSettings()).toMatchObject({ fontSize: 23, applicationTheme: 'sepia' });
    await saveSettings({ ...(await getSettings()), fontSize: 29, readingBookOverrides: { book: { marginX: 12 } } });
    expect(await listSyncOutbox()).toEqual([]);
    // A legacy full-document write cannot replace the independent device record.
    await putItem('settings', { ...defaultSettings, fontSize: 12, applicationTheme: 'light' });
    expect(await new IndexedDbReaderRepository().getSettings()).toMatchObject({
      fontSize: 29,
      applicationTheme: 'sepia',
      readingBookOverrides: { book: { marginX: 12 } },
    });
  });

  it('keeps preferences across repository recreation and separates device scopes while sharing common settings', async () => {
    let server = structuredClone(defaultSettings);
    const makeClient = (scope: string) => ({
      readerSettingsScope: scope,
      getSettings: vi.fn(async () => ({ settings: structuredClone(server) })),
      saveSettings: vi.fn(async (settings: Partial<ReaderSettings>) => {
        server = { ...server, ...settings };
      }),
    });
    const clientA = makeClient('device-a');
    const clientB = makeClient('device-b');
    const a = new RemoteReaderRepository(clientA as unknown as RemoteApiClient);
    const b = new RemoteReaderRepository(clientB as unknown as RemoteApiClient);
    const settingsA = await a.getSettings();
    await b.getSettings();
    await a.saveSettings({
      ...settingsA,
      fontSize: 31,
      flow: 'page',
      gestureBindings: { ...settingsA.gestureBindings, tapLeft: 'none' },
    });
    expect(clientA.saveSettings).not.toHaveBeenCalled();
    expect(clientA.getSettings).toHaveBeenCalledTimes(1);
    expect(await b.getSettings()).toMatchObject({ fontSize: defaultSettings.fontSize });
    expect(await new RemoteReaderRepository(clientA as unknown as RemoteApiClient).getSettings()).toMatchObject({
      fontSize: 31,
      flow: 'page',
      gestureBindings: { tapLeft: 'none' },
    });
    await a.saveSettings({ ...(await a.getSettings()), ttsSpeed: 1.5 });
    expect(clientA.saveSettings).toHaveBeenCalledOnce();
    expect(clientA.saveSettings.mock.calls[0][0]).not.toHaveProperty('fontSize');
    expect(clientA.saveSettings.mock.calls[0][0]).not.toHaveProperty('readingProfile');
    expect(await b.getSettings()).toMatchObject({ ttsSpeed: 1.5, fontSize: defaultSettings.fontSize });
  });

  it('exports common settings only and ignores presentation in legacy Cloud Vault snapshots', async () => {
    await saveSettings({
      ...defaultSettings,
      fontSize: 27,
      readingBookOverrides: { book: { fontSize: 30 } },
      ttsSpeed: 1.4,
    });
    const event = (await listSyncOutbox()).find((item) => item.event.type === 'settings_updated')!;
    expect(event.event.payload).toMatchObject({ settings: { ttsSpeed: 1.4 } });
    expect((event.event.payload as { settings: object }).settings).not.toHaveProperty('fontSize');
    const artifacts = new IndexedDbCloudVaultArtifactRepository(new IndexedDbReaderRepository());
    const snapshot = await artifacts.capture({
      deviceId: 'local',
      scope: { ...DEFAULT_CLOUD_VAULT_SCOPE, readerSettings: true },
      capturedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(snapshot.settings).not.toHaveProperty('fontSize');
    expect(snapshot.settings).not.toHaveProperty('readingBookOverrides');
    const legacy = {
      ...snapshot,
      settings: { ...defaultSettings, fontSize: 10, ttsSpeed: 1.8 },
      settingsUpdatedAt: '2099-01-01T00:00:00.000Z',
    };
    expect(mergeCloudVaultSnapshots(snapshot, legacy).settings).not.toHaveProperty('fontSize');
    await artifacts.apply(legacy);
    expect(await getSettings()).toMatchObject({
      fontSize: 27,
      readingBookOverrides: { book: { fontSize: 30 } },
      ttsSpeed: 1.8,
    });
  });
});
