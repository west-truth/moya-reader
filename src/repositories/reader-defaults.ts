import { ReaderSettings } from '../domain/types';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../providers/tts-playback-settings';
import { DEFAULT_GESTURE_BINDINGS, DEFAULT_READING_PROFILE } from '../features/reader-settings/reading-profile';

export const PARAGRAPHS_PER_PAGE = 120;

export const defaultSettings: ReaderSettings = {
  id: 'reader-settings',
  applicationTheme: 'dark',
  theme: 'dark',
  font: 'serif',
  fontSize: 18,
  lineHeight: 1.85,
  paragraphSpacing: 1.15,
  marginX: 12,
  marginY: 4,
  contentWidth: 760,
  flow: 'scroll',
  ttsSpeed: 1,
  ttsPlayback: DEFAULT_TTS_PLAYBACK_SETTINGS,
  readingProfile: DEFAULT_READING_PROFILE,
  aiWorkflows: { schemaVersion: 1, bookOverrides: {} },
  gestureBindings: DEFAULT_GESTURE_BINDINGS,
  keepScreenChrome: false,
};

export function normalizeReaderSettings(settings: Partial<ReaderSettings> = {}): ReaderSettings {
  return {
    ...defaultSettings,
    ...settings,
    ttsPlayback: {
      ...defaultSettings.ttsPlayback,
      ...settings.ttsPlayback,
      rate: settings.ttsPlayback?.rate ?? settings.ttsSpeed ?? defaultSettings.ttsPlayback.rate,
    },
    readingProfile: { ...defaultSettings.readingProfile, ...settings.readingProfile },
    aiWorkflows: {
      ...defaultSettings.aiWorkflows!,
      ...settings.aiWorkflows,
      bookOverrides: { ...defaultSettings.aiWorkflows?.bookOverrides, ...settings.aiWorkflows?.bookOverrides },
    },
    gestureBindings: { ...defaultSettings.gestureBindings, ...settings.gestureBindings },
  };
}
