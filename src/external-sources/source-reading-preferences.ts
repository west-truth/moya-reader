/** Device preferences: browsing caches must never change another reader's downloads. */
export interface SourceReadingPreferences {
  mode: 'stream-save' | 'stream' | 'download';
  listMinutes: 0 | 2 | 30 | 360;
  coverHours: 0 | 1 | 24 | 168;
  imageMinutes: 0 | 2 | 10;
  prefetch: 0 | 2 | 4 | 8;
}
export const sourceReadingDefaults: SourceReadingPreferences = {
  mode: 'stream',
  listMinutes: 30,
  coverHours: 24,
  imageMinutes: 2,
  prefetch: 8,
};
const key = 'moya.source-reading.v1';
export const sourceReadingPreferenceEvent = 'moya-source-reading-preferences';
export function sourceReadingPreferences(): SourceReadingPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      mode: ['stream-save', 'stream', 'download'].includes(value.mode) ? value.mode : sourceReadingDefaults.mode,
      listMinutes: [0, 2, 30, 360].includes(value.listMinutes) ? value.listMinutes : 30,
      coverHours: [0, 1, 24, 168].includes(value.coverHours) ? value.coverHours : 24,
      imageMinutes: [0, 2, 10].includes(value.imageMinutes) ? value.imageMinutes : 2,
      prefetch: [0, 2, 4, 8].includes(value.prefetch) ? value.prefetch : 8,
    };
  } catch {
    return { ...sourceReadingDefaults };
  }
}
export function saveSourceReadingPreferences(patch: Partial<SourceReadingPreferences>) {
  localStorage.setItem(key, JSON.stringify({ ...sourceReadingPreferences(), ...patch }));
  window.dispatchEvent(new Event(sourceReadingPreferenceEvent));
}
