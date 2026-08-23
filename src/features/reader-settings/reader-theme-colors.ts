import type { ReadingProfile, ReadingProfileTheme } from '../../domain/types';

export interface ReaderThemeColors {
  foreground: string;
  background: string;
}

const READER_THEME_COLORS: Record<Exclude<ReadingProfileTheme, 'custom'>, ReaderThemeColors> = {
  light: { foreground: '#35383d', background: '#f8f7f3' },
  sepia: { foreground: '#34291f', background: '#f2e8d7' },
  dark: { foreground: '#e2e5e8', background: '#111315' },
  midnight: { foreground: '#d9e0ea', background: '#080f19' },
};

export function resolveReaderThemeColors(
  profile: Pick<ReadingProfile, 'theme' | 'foreground' | 'background'>,
): ReaderThemeColors {
  if (profile.theme !== 'custom') return READER_THEME_COLORS[profile.theme];
  return {
    foreground: profile.foreground ?? '#eeeeea',
    background: profile.background ?? '#181817',
  };
}
