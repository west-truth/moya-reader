import type {
  ReaderSettings,
  TTSSkippedContentType,
  TTSSleepTimerPreset,
  TTSPlaybackSettings,
  TTSPlaybackSettingsOverride,
} from '../domain/types';
import { clamp } from '../utils/format';

export const DEFAULT_TTS_PLAYBACK_SETTINGS: TTSPlaybackSettings = {
  schemaVersion: 1,
  rate: 1,
  pitch: 1,
  volume: 1,
  sentencePauseMs: 180,
  paragraphPauseMs: 420,
  chapterPauseMs: 900,
  chapterEndBehavior: 'stop',
  footnotePlayback: 'end_of_chapter',
  offlineOnly: false,
  skippedContentTypes: [],
};

const SKIPPABLE_CONTENT_TYPES = new Set<TTSSkippedContentType>(['author_note', 'system_message', 'sfx']);
const SLEEP_TIMER_PRESETS = new Set<TTSSleepTimerPreset>([10, 20, 30, 60, 'end_of_chapter']);

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeTTSPlaybackSettings(
  value: Partial<TTSPlaybackSettings> | undefined,
  legacyRate = 1,
): TTSPlaybackSettings {
  const timer = value?.sleepTimerDefault;
  return {
    schemaVersion: 1,
    rate: clamp(finiteNumber(value?.rate, legacyRate), 0.5, 2.5),
    pitch: clamp(finiteNumber(value?.pitch, 1), 0.5, 2),
    volume: clamp(finiteNumber(value?.volume, 1), 0, 1),
    sentencePauseMs: Math.round(clamp(finiteNumber(value?.sentencePauseMs, 180), 0, 2_000)),
    paragraphPauseMs: Math.round(clamp(finiteNumber(value?.paragraphPauseMs, 420), 0, 5_000)),
    chapterPauseMs: Math.round(clamp(finiteNumber(value?.chapterPauseMs, 900), 0, 10_000)),
    chapterEndBehavior: value?.chapterEndBehavior === 'continue' ? 'continue' : 'stop',
    footnotePlayback:
      value?.footnotePlayback === 'skip' || value?.footnotePlayback === 'immediate'
        ? value.footnotePlayback
        : 'end_of_chapter',
    offlineOnly: value?.offlineOnly === true,
    sleepTimerDefault: timer !== undefined && SLEEP_TIMER_PRESETS.has(timer) ? timer : undefined,
    skippedContentTypes: Array.from(
      new Set((value?.skippedContentTypes ?? []).filter((item) => SKIPPABLE_CONTENT_TYPES.has(item))),
    ),
  };
}

export function resolveTTSPlaybackSettings(settings: ReaderSettings, bookId?: string): TTSPlaybackSettings {
  const global = normalizeTTSPlaybackSettings(settings.ttsPlayback, settings.ttsSpeed);
  const override = bookId ? settings.ttsBookOverrides?.[bookId] : undefined;
  const sleepTimerDefault =
    override && Object.prototype.hasOwnProperty.call(override, 'sleepTimerDefault')
      ? override.sleepTimerDefault === null
        ? undefined
        : override.sleepTimerDefault
      : global.sleepTimerDefault;
  return normalizeTTSPlaybackSettings({ ...global, ...override, sleepTimerDefault }, global.rate);
}

export function updateGlobalTTSPlaybackSettings(
  settings: ReaderSettings,
  patch: TTSPlaybackSettingsOverride,
): ReaderSettings {
  const { sleepTimerDefault, ...otherFields } = patch;
  const merged: Partial<TTSPlaybackSettings> = { ...resolveTTSPlaybackSettings(settings), ...otherFields };
  if (Object.prototype.hasOwnProperty.call(patch, 'sleepTimerDefault')) {
    merged.sleepTimerDefault = sleepTimerDefault ?? undefined;
  }
  const ttsPlayback = normalizeTTSPlaybackSettings(merged);
  return { ...settings, ttsSpeed: ttsPlayback.rate, ttsPlayback };
}

export function updateBookTTSPlaybackOverride(
  settings: ReaderSettings,
  bookId: string,
  patch: TTSPlaybackSettingsOverride,
): ReaderSettings {
  const previous = settings.ttsBookOverrides?.[bookId] ?? {};
  return {
    ...settings,
    ttsBookOverrides: {
      ...settings.ttsBookOverrides,
      [bookId]: { ...previous, ...patch },
    },
  };
}

export function resetBookTTSPlaybackOverride(settings: ReaderSettings, bookId: string): ReaderSettings {
  if (!settings.ttsBookOverrides?.[bookId]) return settings;
  const next = { ...settings.ttsBookOverrides };
  delete next[bookId];
  return { ...settings, ttsBookOverrides: Object.keys(next).length ? next : undefined };
}

export function hasBookTTSPlaybackOverride(settings: ReaderSettings, bookId?: string): boolean {
  return Boolean(bookId && settings.ttsBookOverrides?.[bookId]);
}
