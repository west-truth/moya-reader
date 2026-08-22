import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { DEFAULT_READING_PROFILE } from './reading-profile';
import { ReaderSettingsLayout } from './ReaderSettingsLayout';
import type { ReaderSettingsController } from './useReaderSettingsDraft';

describe('ReaderSettingsLayout', () => {
  it('keeps the real layout, mode-lock and chrome settings in the reference presentation', () => {
    const markup = renderToStaticMarkup(
      <ReaderSettingsLayout
        controller={
          {
            settings: defaultSettings,
            updateSettings: vi.fn(),
          } as unknown as ReaderSettingsController
        }
        profile={{ ...DEFAULT_READING_PROFILE, modeLock: 'auto', pageTurnMotion: 'smooth' }}
        updateProfile={vi.fn()}
      />,
    );

    expect(markup).toContain('본문 최대 폭');
    expect(markup).toContain('aria-label="본문 조판 미리보기"');
    expect(markup).toContain('aria-label="문단 맞춤"');
    expect(markup).toContain('aria-label="읽기 방식"');
    expect(markup).toContain('>스크롤<');
    expect(markup).not.toContain('연속 스크롤');
    expect(markup).toContain('입력 방식에 맞춰');
    expect(markup).toContain('aria-label="페이지 전환 효과"');
    expect(markup).toContain('도구 모음 항상 표시');
  });
});
