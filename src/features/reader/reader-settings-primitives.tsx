import type { ReaderSettings } from '../../domain/types';
import { defaultSettings } from '../../repositories/reader-defaults';

export const readingPresets = [
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
] satisfies Array<{
  id: string;
  label: string;
  description: string;
  settings: Pick<
    ReaderSettings,
    'font' | 'fontSize' | 'lineHeight' | 'paragraphSpacing' | 'marginX' | 'marginY' | 'contentWidth'
  >;
}>;

export function SettingsSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <section>
      <div className="setting-line">
        <h3>{label}</h3>
        <span>
          {value}
          {suffix}
        </span>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </section>
  );
}
