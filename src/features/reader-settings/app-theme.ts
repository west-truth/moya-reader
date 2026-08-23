import type { ApplicationThemeColors, ReadingProfileTheme } from '../../domain/types';

export type AppTheme = ReadingProfileTheme;

export const DEFAULT_CUSTOM_APP_THEME_COLORS: ApplicationThemeColors = {
  background: '#111315',
  surface: '#1b1e22',
  text: '#e2e5e8',
  accent: '#4c7df0',
};

const APP_THEME_COLORS: Record<Exclude<AppTheme, 'custom'>, string> = {
  light: '#f8f7f3',
  sepia: '#f2e8d7',
  dark: '#111416',
  midnight: '#09111b',
};

export function resolveAppTheme(theme: ReadingProfileTheme): AppTheme {
  return theme;
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeApplicationThemeColors(colors?: Partial<ApplicationThemeColors>): ApplicationThemeColors {
  return {
    background: isHexColor(colors?.background) ? colors.background : DEFAULT_CUSTOM_APP_THEME_COLORS.background,
    surface: isHexColor(colors?.surface) ? colors.surface : DEFAULT_CUSTOM_APP_THEME_COLORS.surface,
    text: isHexColor(colors?.text) ? colors.text : DEFAULT_CUSTOM_APP_THEME_COLORS.text,
    accent: isHexColor(colors?.accent) ? colors.accent : DEFAULT_CUSTOM_APP_THEME_COLORS.accent,
  };
}

export function appThemeColor(theme: AppTheme, colors?: Partial<ApplicationThemeColors>): string {
  return theme === 'custom' ? normalizeApplicationThemeColors(colors).background : APP_THEME_COLORS[theme];
}

export function isDarkThemeColor(color: string): boolean {
  const value = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return true;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 < 146;
}
