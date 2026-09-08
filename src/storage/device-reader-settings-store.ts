import type { ReaderSettings } from '../domain/types';
import { deviceReaderSettings, type DeviceReaderSettings } from '../repositories/reader-settings-scope';
import { defaultSettings } from '../repositories/reader-defaults';
import { openReaderDb } from './reader-database';
import { requestToPromise, transactionDone } from './indexeddb-transaction';

const PREFIX = 'device-reader-settings:v1:';
export const LOCAL_READER_SETTINGS_SCOPE = 'local';
interface DeviceSettingsRecord {
  id: string;
  preferences: DeviceReaderSettings;
}

export function isDeviceReaderSettingsRecord(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(PREFIX);
}

export async function deviceSettingsInStore(
  store: IDBObjectStore,
  scope: string,
  legacy: Partial<ReaderSettings>,
  replace = false,
): Promise<DeviceReaderSettings> {
  const id = PREFIX + scope;
  const existing = await requestToPromise<DeviceSettingsRecord | undefined>(store.get(id));
  if (existing && !replace) return existing.preferences;
  const preferences = deviceReaderSettings({
    ...defaultSettings,
    ...legacy,
    readingProfile: { ...defaultSettings.readingProfile, ...legacy.readingProfile },
    gestureBindings: { ...defaultSettings.gestureBindings, ...legacy.gestureBindings },
  });
  store.put({ id, preferences } satisfies DeviceSettingsRecord);
  return preferences;
}

export async function loadDeviceReaderSettings(scope: string, legacy: Partial<ReaderSettings>, replace = false) {
  const db = await openReaderDb();
  const tx = db.transaction('settings', 'readwrite');
  const done = transactionDone(tx);
  const preferences = await deviceSettingsInStore(tx.objectStore('settings'), scope, legacy, replace);
  await done;
  return preferences;
}

/** Remote sync/restore may change common settings, but must seed and then preserve this device's preferences. */
export async function preserveLocalReaderSettings(store: IDBObjectStore): Promise<void> {
  const legacy = await requestToPromise<ReaderSettings | undefined>(store.get(defaultSettings.id));
  await deviceSettingsInStore(store, LOCAL_READER_SETTINGS_SCOPE, legacy ?? defaultSettings);
}
