import type {
  ReaderFont,
  ReaderSettings,
  ReaderTheme,
  ReadingProfile,
  ReadingProfileOverride,
} from '../../domain/types';
import { clamp } from '../../utils/format';

export const DEFAULT_READING_PROFILE: ReadingProfile = {
  schemaVersion: 1,
  theme: 'dark',
  fontId: 'builtin-serif',
  fontSize: 18,
  fontWeight: 400,
  lineHeight: 1.85,
  letterSpacing: 0,
  paragraphSpacing: 1.15,
  firstLineIndent: 0,
  textAlign: 'start',
  marginX: 12,
  marginY: 4,
  contentWidth: 760,
  brightness: 1,
  flow: 'scroll',
  pageTurnMotion: 'smooth',
};

export const DEFAULT_GESTURE_BINDINGS = {
  tapLeft: 'previous_page',
  tapCenter: 'toggle_chrome',
  tapRight: 'next_page',
  swipeLeft: 'next_page',
  swipeRight: 'previous_page',
} as const;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : undefined;
}

export function normalizeReadingProfile(
  value: Partial<ReadingProfile> | undefined,
  legacy?: Partial<ReaderSettings>,
): ReadingProfile {
  const legacyFont =
    legacy?.font === 'sans' ? 'builtin-sans' : legacy?.font === 'mono' ? 'builtin-mono' : 'builtin-serif';
  const sourceFlow = value?.flow ?? (legacy?.flow === 'page' ? 'screen_turn' : 'scroll');
  const flow = sourceFlow === 'screen_turn' ? 'paginated' : sourceFlow === 'paginated' ? 'paginated' : 'scroll';
  const pageTurnMotion =
    value?.pageTurnMotion === 'instant' || value?.pageTurnMotion === 'smooth'
      ? value.pageTurnMotion
      : sourceFlow === 'paginated'
        ? 'instant'
        : 'smooth';
  const theme = value?.theme ?? legacy?.theme ?? DEFAULT_READING_PROFILE.theme;
  return {
    schemaVersion: 1,
    theme: ['light', 'dark', 'sepia', 'midnight', 'custom'].includes(theme) ? theme : 'dark',
    fontId: value?.fontId?.trim() || legacyFont,
    fontSize: clamp(finite(value?.fontSize, legacy?.fontSize ?? 18), 11, 40),
    fontWeight: Math.round(clamp(finite(value?.fontWeight, 400), 300, 800) / 100) * 100,
    lineHeight: clamp(finite(value?.lineHeight, legacy?.lineHeight ?? 1.85), 1.2, 3),
    letterSpacing: clamp(finite(value?.letterSpacing, 0), 0, 0.2),
    paragraphSpacing: clamp(finite(value?.paragraphSpacing, legacy?.paragraphSpacing ?? 1.15), 0, 3),
    firstLineIndent: clamp(finite(value?.firstLineIndent, 0), 0, 4),
    textAlign: value?.textAlign === 'justify' ? 'justify' : 'start',
    marginX: clamp(finite(value?.marginX, legacy?.marginX ?? 12), 0, 24),
    marginY: clamp(finite(value?.marginY, legacy?.marginY ?? 4), 0, 16),
    contentWidth: clamp(finite(value?.contentWidth, legacy?.contentWidth ?? 760), 420, 1280),
    foreground: safeColor(value?.foreground),
    background: safeColor(value?.background),
    brightness: clamp(finite(value?.brightness, 1), 0.5, 1),
    flow,
    pageTurnMotion,
  };
}

export function resolveReadingProfile(settings: ReaderSettings, bookId?: string): ReadingProfile {
  const global = normalizeReadingProfile(settings.readingProfile, settings);
  return normalizeReadingProfile({ ...global, ...(bookId ? settings.readingBookOverrides?.[bookId] : undefined) });
}

export function updateGlobalReadingProfile(settings: ReaderSettings, patch: ReadingProfileOverride): ReaderSettings {
  const readingProfile = normalizeReadingProfile({
    ...normalizeReadingProfile(settings.readingProfile, settings),
    ...patch,
  });
  return { ...settings, ...legacyReaderSettings(readingProfile), readingProfile };
}

export function updateBookReadingProfile(
  settings: ReaderSettings,
  bookId: string,
  patch: ReadingProfileOverride,
): ReaderSettings {
  return {
    ...settings,
    readingBookOverrides: {
      ...settings.readingBookOverrides,
      [bookId]: { ...(settings.readingBookOverrides?.[bookId] ?? {}), ...patch },
    },
  };
}

export function resetBookReadingProfile(settings: ReaderSettings, bookId: string): ReaderSettings {
  if (!settings.readingBookOverrides?.[bookId]) return settings;
  const next = { ...settings.readingBookOverrides };
  delete next[bookId];
  return { ...settings, readingBookOverrides: Object.keys(next).length ? next : undefined };
}

export function hasBookReadingProfile(settings: ReaderSettings, bookId?: string): boolean {
  return Boolean(bookId && settings.readingBookOverrides?.[bookId]);
}

export function legacyReaderSettings(
  profile: ReadingProfile,
): Pick<
  ReaderSettings,
  'theme' | 'font' | 'fontSize' | 'lineHeight' | 'paragraphSpacing' | 'marginX' | 'marginY' | 'contentWidth' | 'flow'
> {
  const font: ReaderFont =
    profile.fontId === 'builtin-sans' ? 'sans' : profile.fontId === 'builtin-mono' ? 'mono' : 'serif';
  const theme: ReaderTheme = profile.theme === 'custom' ? 'dark' : profile.theme;
  return {
    theme,
    font,
    fontSize: profile.fontSize,
    lineHeight: profile.lineHeight,
    paragraphSpacing: profile.paragraphSpacing,
    marginX: profile.marginX,
    marginY: profile.marginY,
    contentWidth: profile.contentWidth,
    flow: profile.flow === 'scroll' ? 'scroll' : 'page',
  };
}

export function settingsWithResolvedReadingProfile(settings: ReaderSettings, bookId?: string): ReaderSettings {
  return { ...settings, ...legacyReaderSettings(resolveReadingProfile(settings, bookId)) };
}

export function readingProfileContrastWarning(profile: ReadingProfile): boolean {
  if (profile.theme !== 'custom' || !profile.foreground || !profile.background) return false;
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const foreground = luminance(profile.foreground);
  const background = luminance(profile.background);
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) < 4.5;
}
