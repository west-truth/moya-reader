import type { ReaderSettings } from '../../domain/types';
import { defaultSettings } from '../../repositories/reader-defaults';

export const READER_FONT_SIZE_MIN = 13;
export const READER_FONT_SIZE_MAX = 28;
export const READER_CONTENT_WIDTH_MIN = 560;
export const READER_CONTENT_WIDTH_MAX = 1040;

type ReadingPresetSettings = Pick<
  ReaderSettings,
  'font' | 'fontSize' | 'lineHeight' | 'paragraphSpacing' | 'marginX' | 'marginY' | 'contentWidth'
>;

export interface ReadingPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly settings: ReadingPresetSettings;
}

export const readingPresets: readonly ReadingPreset[] = [
  {
    id: 'default',
    label: '기본',
    description: '균형 잡힌 기본 독서 화면',
    settings: {
      font: defaultSettings.font,
      fontSize: defaultSettings.fontSize,
      lineHeight: defaultSettings.lineHeight,
      paragraphSpacing: defaultSettings.paragraphSpacing,
      marginX: defaultSettings.marginX,
      marginY: defaultSettings.marginY,
      contentWidth: defaultSettings.contentWidth,
    },
  },
  {
    id: 'compact',
    label: '촘촘',
    description: '한 화면에 더 많은 문단 표시',
    settings: {
      font: 'sans',
      fontSize: 15,
      lineHeight: 1.55,
      paragraphSpacing: 0.75,
      marginX: 6,
      marginY: 1,
      contentWidth: 920,
    },
  },
  {
    id: 'comfortable',
    label: '편안',
    description: '긴 독서에 맞춘 여백과 줄 간격',
    settings: {
      font: 'serif',
      fontSize: 18,
      lineHeight: 1.9,
      paragraphSpacing: 1.25,
      marginX: 12,
      marginY: 4,
      contentWidth: 760,
    },
  },
  {
    id: 'large',
    label: '큰 글씨',
    description: '큰 글자와 넓은 줄 간격',
    settings: {
      font: 'sans',
      fontSize: 22,
      lineHeight: 2.05,
      paragraphSpacing: 1.35,
      marginX: 10,
      marginY: 3,
      contentWidth: 840,
    },
  },
];

export const readingSettingsDefaults: Partial<ReaderSettings> = {
  theme: defaultSettings.theme,
  font: defaultSettings.font,
  fontSize: defaultSettings.fontSize,
  lineHeight: defaultSettings.lineHeight,
  paragraphSpacing: defaultSettings.paragraphSpacing,
  marginX: defaultSettings.marginX,
  marginY: defaultSettings.marginY,
  contentWidth: defaultSettings.contentWidth,
  flow: defaultSettings.flow,
  keepScreenChrome: defaultSettings.keepScreenChrome,
};

export function readerSettingsEqual(left: ReaderSettings, right: ReaderSettings): boolean {
  return (
    left.applicationTheme === right.applicationTheme &&
    JSON.stringify(left.applicationThemeColors) === JSON.stringify(right.applicationThemeColors) &&
    left.theme === right.theme &&
    left.font === right.font &&
    left.fontSize === right.fontSize &&
    left.lineHeight === right.lineHeight &&
    left.paragraphSpacing === right.paragraphSpacing &&
    left.marginX === right.marginX &&
    left.marginY === right.marginY &&
    left.contentWidth === right.contentWidth &&
    left.flow === right.flow &&
    left.ttsSpeed === right.ttsSpeed &&
    left.ttsVoiceURI === right.ttsVoiceURI &&
    JSON.stringify(left.ttsPlayback) === JSON.stringify(right.ttsPlayback) &&
    JSON.stringify(left.ttsBookOverrides) === JSON.stringify(right.ttsBookOverrides) &&
    JSON.stringify(left.readingProfile) === JSON.stringify(right.readingProfile) &&
    JSON.stringify(left.readingBookOverrides) === JSON.stringify(right.readingBookOverrides) &&
    JSON.stringify(left.aiWorkflows) === JSON.stringify(right.aiWorkflows) &&
    JSON.stringify(left.gestureBindings) === JSON.stringify(right.gestureBindings) &&
    left.keepScreenChrome === right.keepScreenChrome
  );
}
