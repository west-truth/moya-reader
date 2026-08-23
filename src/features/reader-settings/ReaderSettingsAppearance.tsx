import { Check } from 'lucide-react';
import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import { readingPresets } from './reader-settings-model';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { normalizeApplicationThemeColors } from './app-theme';
import { ReaderUserFontManager } from './ReaderUserFontManager';
import { SettingsSlider } from './SettingsSlider';
import { resolveReaderThemeColors } from './reader-theme-colors';
import type { ReaderSettingsController } from './useReaderSettingsDraft';

const THEMES: Array<{ id: ReadingProfile['theme']; label: string; description: string }> = [
  { id: 'midnight', label: '미드나이트', description: '차분한 네이비' },
  { id: 'dark', label: '그래파이트', description: '중립적인 다크' },
  { id: 'light', label: '페이퍼', description: '선명한 밝은 화면' },
  { id: 'sepia', label: '웜 페이퍼', description: '부드러운 종이색' },
  { id: 'custom', label: '사용자 설정', description: '색상을 직접 선택' },
];

export function ReaderSettingsAppearance({
  controller,
  profile,
  updateProfile,
  personalizationRepository,
  themeTarget,
  setThemeTarget,
}: {
  controller: ReaderSettingsController;
  profile: ReadingProfile;
  updateProfile: (patch: ReadingProfileOverride) => void;
  personalizationRepository?: ReaderPersonalizationRepository;
  themeTarget: 'application' | 'reader';
  setThemeTarget: (target: 'application' | 'reader') => void;
}) {
  const appTheme = controller.settings.applicationTheme ?? 'dark';
  const appColors = normalizeApplicationThemeColors(controller.settings.applicationThemeColors);
  const readerColors = resolveReaderThemeColors(profile);
  const activeTheme = themeTarget === 'application' ? appTheme : profile.theme;
  const selectTheme = (theme: ReadingProfile['theme']) => {
    if (themeTarget === 'application') {
      controller.updateSettings({ applicationTheme: theme });
      return;
    }
    updateProfile({ theme });
  };

  return (
    <>
      <section className="reader-settings-group">
        <div className="reader-settings-section-heading">
          <h3>테마</h3>
          <div className="segmented reader-theme-target" aria-label="테마 적용 대상">
            <button
              type="button"
              className={themeTarget === 'application' ? 'active' : ''}
              onClick={() => setThemeTarget('application')}
              aria-pressed={themeTarget === 'application'}
            >
              앱 UI
            </button>
            <button
              type="button"
              className={themeTarget === 'reader' ? 'active' : ''}
              onClick={() => setThemeTarget('reader')}
              aria-pressed={themeTarget === 'reader'}
            >
              리더
            </button>
          </div>
        </div>
        <p className="field-help reader-theme-scope-help">
          {themeTarget === 'application'
            ? '책장과 설정 등 앱 화면에 적용됩니다.'
            : '소설 본문에 적용되며 책별로 다르게 저장할 수 있습니다.'}
        </p>
        <div className="reader-theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`${theme.id === 'custom' ? 'reader-theme-custom-option ' : ''}${activeTheme === theme.id ? 'active' : ''}`}
              onClick={() => selectTheme(theme.id)}
              aria-pressed={activeTheme === theme.id}
            >
              <span
                className={`reader-theme-swatch ${theme.id}`}
                aria-hidden="true"
                style={
                  theme.id === 'custom'
                    ? {
                        background: themeTarget === 'application' ? appColors.background : readerColors.background,
                        color: themeTarget === 'application' ? appColors.text : readerColors.foreground,
                      }
                    : undefined
                }
              >
                <i
                  style={
                    theme.id === 'custom'
                      ? { background: themeTarget === 'application' ? appColors.surface : readerColors.foreground }
                      : undefined
                  }
                />
                <i style={theme.id === 'custom' ? { background: 'currentColor', opacity: 0.38 } : undefined} />
                <i
                  style={
                    theme.id === 'custom' && themeTarget === 'application'
                      ? { background: appColors.accent }
                      : undefined
                  }
                />
              </span>
              <span>
                <strong>{theme.label}</strong>
                <small>{theme.description}</small>
              </span>
              {activeTheme === theme.id && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </section>
      {themeTarget === 'application' && appTheme === 'custom' && (
        <section className="reader-settings-group">
          <h3>앱 UI 색상</h3>
          <div className="reader-color-controls reader-color-controls-grid">
            {(
              [
                ['background', '배경'],
                ['surface', '패널'],
                ['text', '글자'],
                ['accent', '강조'],
              ] as const
            ).map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  type="color"
                  value={appColors[field]}
                  onChange={(event) =>
                    controller.updateSettings({
                      applicationTheme: 'custom',
                      applicationThemeColors: { ...appColors, [field]: event.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="field-help">배경과 패널을 구분하고, 글자 대비가 충분한 색을 권장합니다.</p>
        </section>
      )}
      {themeTarget === 'reader' && profile.theme === 'custom' && (
        <section className="reader-settings-group">
          <h3>리더 색상</h3>
          <div className="reader-color-controls">
            <label>
              글자 색
              <input
                type="color"
                value={profile.foreground ?? '#eeeeea'}
                onChange={(event) => updateProfile({ theme: 'custom', foreground: event.target.value })}
              />
            </label>
            <label>
              배경 색
              <input
                type="color"
                value={profile.background ?? '#181817'}
                onChange={(event) => updateProfile({ theme: 'custom', background: event.target.value })}
              />
            </label>
          </div>
        </section>
      )}
      {themeTarget === 'reader' && (
        <>
          <section className="reader-settings-group reader-settings-brightness">
            <SettingsSlider
              label="리더 밝기"
              value={profile.brightness}
              min={0.5}
              max={1}
              step={0.05}
              onChange={(brightness) => updateProfile({ brightness })}
            />
          </section>
          <section className="reader-settings-group">
            <h3>리더 글꼴</h3>
            <div className="segmented full" aria-label="본문 글꼴">
              <button
                type="button"
                className={profile.fontId === 'builtin-serif' ? 'active' : ''}
                onClick={() => updateProfile({ fontId: 'builtin-serif' })}
                aria-pressed={profile.fontId === 'builtin-serif'}
              >
                명조
              </button>
              <button
                type="button"
                className={profile.fontId === 'builtin-sans' ? 'active' : ''}
                onClick={() => updateProfile({ fontId: 'builtin-sans' })}
                aria-pressed={profile.fontId === 'builtin-sans'}
              >
                고딕
              </button>
              <button
                type="button"
                className={profile.fontId === 'builtin-mono' ? 'active' : ''}
                onClick={() => updateProfile({ fontId: 'builtin-mono' })}
                aria-pressed={profile.fontId === 'builtin-mono'}
              >
                고정폭
              </button>
            </div>
            <ReaderUserFontManager
              repository={personalizationRepository}
              activeFontId={profile.fontId}
              selectFont={(fontId) => updateProfile({ fontId })}
            />
          </section>
          <section className="reader-settings-group">
            <h3>리더 프리셋</h3>
            <div className="reader-preset-grid">
              {readingPresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() =>
                    updateProfile({
                      fontId:
                        preset.settings.font === 'sans'
                          ? 'builtin-sans'
                          : preset.settings.font === 'mono'
                            ? 'builtin-mono'
                            : 'builtin-serif',
                      fontSize: preset.settings.fontSize,
                      lineHeight: preset.settings.lineHeight,
                      paragraphSpacing: preset.settings.paragraphSpacing,
                      marginX: preset.settings.marginX,
                      marginY: preset.settings.marginY,
                      contentWidth: preset.settings.contentWidth,
                    })
                  }
                >
                  <strong>{preset.label}</strong>
                  <span>{preset.description}</span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
