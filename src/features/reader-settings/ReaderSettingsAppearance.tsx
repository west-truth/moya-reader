import { Check } from 'lucide-react';
import type { ReaderSettings } from '../../domain/types';
import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import { readingPresets } from './reader-settings-model';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { ReaderUserFontManager } from './ReaderUserFontManager';

const THEMES: Array<{ id: ReaderSettings['theme']; label: string }> = [
  { id: 'dark', label: '다크' },
  { id: 'light', label: '라이트' },
  { id: 'sepia', label: '세피아' },
  { id: 'midnight', label: '미드나이트' },
];

export function ReaderSettingsAppearance({
  profile,
  updateProfile,
  personalizationRepository,
}: {
  profile: ReadingProfile;
  updateProfile: (patch: ReadingProfileOverride) => void;
  personalizationRepository?: ReaderPersonalizationRepository;
}) {
  return (
    <>
      <section>
        <h3>테마</h3>
        <div className="reader-theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={profile.theme === theme.id ? 'active' : ''}
              onClick={() => updateProfile({ theme: theme.id })}
              aria-pressed={profile.theme === theme.id}
            >
              <span className={`reader-theme-swatch ${theme.id}`} aria-hidden="true" />
              {theme.label}
              {profile.theme === theme.id && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>사용자 색상</h3>
        <div className="reader-color-controls">
          <label>
            글자
            <input
              type="color"
              value={profile.foreground ?? '#eeeeea'}
              onChange={(event) => updateProfile({ theme: 'custom', foreground: event.target.value })}
            />
          </label>
          <label>
            배경
            <input
              type="color"
              value={profile.background ?? '#181817'}
              onChange={(event) => updateProfile({ theme: 'custom', background: event.target.value })}
            />
          </label>
        </div>
      </section>
      <section>
        <h3>글꼴</h3>
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
      <section>
        <h3>프리셋</h3>
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
  );
}
