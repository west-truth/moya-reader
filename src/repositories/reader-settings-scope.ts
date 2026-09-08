import type { ReaderSettings } from '../domain/types';

/** Presentation and input preferences belong to this browser, including per-book overrides. */
export const DEVICE_READER_SETTING_KEYS = [
  'applicationTheme',
  'applicationThemeColors',
  'theme',
  'font',
  'fontSize',
  'lineHeight',
  'paragraphSpacing',
  'marginX',
  'marginY',
  'contentWidth',
  'flow',
  'readingProfile',
  'readingBookOverrides',
  'gestureBindings',
  'keepScreenChrome',
  'ttsVoiceURI',
] as const satisfies readonly (keyof ReaderSettings)[];

export type DeviceReaderSettings = Pick<ReaderSettings, (typeof DEVICE_READER_SETTING_KEYS)[number]>;
export type SharedReaderSettings = Pick<ReaderSettings, 'id'> &
  Partial<Omit<ReaderSettings, keyof DeviceReaderSettings>>;

export function deviceReaderSettings(settings: Partial<ReaderSettings>): DeviceReaderSettings {
  return Object.fromEntries(DEVICE_READER_SETTING_KEYS.map((key) => [key, settings[key]])) as DeviceReaderSettings;
}

/** An allowlist prevents future device preferences from silently entering sync payloads. */
export function sharedReaderSettings(settings: Partial<ReaderSettings>): SharedReaderSettings {
  const shared = {
    id: 'reader-settings',
    cloudVaultUpdatedAt: settings.cloudVaultUpdatedAt,
    ttsSpeed: settings.ttsSpeed,
    ttsPlayback: settings.ttsPlayback,
    ttsBookOverrides: settings.ttsBookOverrides,
    aiWorkflows: settings.aiWorkflows,
  };
  return Object.fromEntries(Object.entries(shared).filter(([, value]) => value !== undefined)) as SharedReaderSettings;
}

export function sharedReaderSettingsEqual(left: Partial<ReaderSettings>, right: Partial<ReaderSettings>): boolean {
  const withoutClock = (value: Partial<ReaderSettings>) =>
    JSON.stringify({ ...sharedReaderSettings(value), cloudVaultUpdatedAt: undefined });
  return withoutClock(left) === withoutClock(right);
}
