import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import {
  READER_CONTENT_WIDTH_MAX,
  READER_CONTENT_WIDTH_MIN,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
} from './reader-settings-model';
import { SettingsSlider } from './SettingsSlider';
import { resolveReaderThemeColors } from './reader-theme-colors';
import type { ReaderSettingsController } from './useReaderSettingsDraft';

export function ReaderSettingsLayout({
  controller,
  profile,
  updateProfile,
}: {
  controller: ReaderSettingsController;
  profile: ReadingProfile;
  updateProfile: (patch: ReadingProfileOverride) => void;
}) {
  const { settings } = controller;
  const themeColors = resolveReaderThemeColors(profile);
  return (
    <>
      <section className="reader-settings-group reader-settings-layout-section">
        <h3>글자</h3>
        <div className="reader-settings-range-grid compact">
          <SettingsSlider
            label="크기"
            value={profile.fontSize}
            min={READER_FONT_SIZE_MIN}
            max={READER_FONT_SIZE_MAX}
            step={1}
            suffix="px"
            onChange={(fontSize) => updateProfile({ fontSize })}
          />
          <SettingsSlider
            label="굵기"
            value={profile.fontWeight}
            min={300}
            max={800}
            step={100}
            onChange={(fontWeight) => updateProfile({ fontWeight })}
          />
          <SettingsSlider
            label="자간"
            value={profile.letterSpacing}
            min={0}
            max={0.2}
            step={0.01}
            suffix="em"
            onChange={(letterSpacing) => updateProfile({ letterSpacing })}
          />
        </div>
        <div className="reader-settings-inline-choice">
          <span>문단 맞춤</span>
          <div className="segmented" aria-label="문단 맞춤">
            <button
              type="button"
              className={profile.textAlign === 'start' ? 'active' : ''}
              onClick={() => updateProfile({ textAlign: 'start' })}
              aria-pressed={profile.textAlign === 'start'}
            >
              왼쪽 맞춤
            </button>
            <button
              type="button"
              className={profile.textAlign === 'justify' ? 'active' : ''}
              onClick={() => updateProfile({ textAlign: 'justify' })}
              aria-pressed={profile.textAlign === 'justify'}
            >
              양쪽 맞춤
            </button>
          </div>
        </div>
      </section>

      <section className="reader-settings-group reader-settings-layout-section">
        <h3>간격</h3>
        <div className="reader-settings-range-grid compact">
          <SettingsSlider
            label="줄 간격"
            value={profile.lineHeight}
            min={1.35}
            max={2.6}
            step={0.05}
            onChange={(lineHeight) => updateProfile({ lineHeight })}
          />
          <SettingsSlider
            label="문단 간격"
            value={profile.paragraphSpacing}
            min={0.6}
            max={2.4}
            step={0.05}
            suffix="em"
            onChange={(paragraphSpacing) => updateProfile({ paragraphSpacing })}
          />
          <SettingsSlider
            label="첫 줄 들여쓰기"
            value={profile.firstLineIndent}
            min={0}
            max={4}
            step={0.25}
            suffix="em"
            onChange={(firstLineIndent) => updateProfile({ firstLineIndent })}
          />
        </div>
      </section>

      <section className="reader-settings-group reader-settings-layout-section">
        <h3>읽기 영역</h3>
        <div className="reader-settings-range-grid compact">
          <SettingsSlider
            label="가로 여백"
            value={profile.marginX}
            min={3}
            max={20}
            step={1}
            suffix="vw"
            onChange={(marginX) => updateProfile({ marginX })}
          />
          <SettingsSlider
            label="세로 여백"
            value={profile.marginY}
            min={0}
            max={12}
            step={1}
            suffix="vh"
            onChange={(marginY) => updateProfile({ marginY })}
          />
          <SettingsSlider
            label="본문 최대 폭"
            value={profile.contentWidth}
            min={READER_CONTENT_WIDTH_MIN}
            max={READER_CONTENT_WIDTH_MAX}
            step={20}
            suffix="px"
            onChange={(contentWidth) => updateProfile({ contentWidth })}
          />
        </div>
      </section>

      <section className="reader-settings-group reader-layout-preview" aria-label="본문 조판 미리보기">
        <div className="reader-settings-section-heading reader-layout-preview-heading">
          <h3>미리보기</h3>
          <span>
            {profile.fontSize}px · {Math.round(profile.lineHeight * 100)}%
          </span>
        </div>
        <div
          className="reader-layout-preview-canvas"
          style={{
            paddingInline: `${Math.min(profile.marginX * 2, 64)}px`,
            filter: `brightness(${profile.brightness})`,
            color: themeColors.foreground,
            background: themeColors.background,
          }}
        >
          <article
            style={{
              maxWidth: `${profile.contentWidth}px`,
              fontSize: `${profile.fontSize}px`,
              fontWeight: profile.fontWeight,
              lineHeight: profile.lineHeight,
              letterSpacing: `${profile.letterSpacing}em`,
              gap: `${profile.paragraphSpacing}em`,
              textAlign: profile.textAlign,
            }}
          >
            <p>비가 그친 뒤의 거리는 놀랄 만큼 조용했다. 젖은 가로등 아래로 오래된 약속의 흔적이 번졌다.</p>
            <p>그는 책갈피를 넘기듯 천천히 다음 기억을 떠올렸다.</p>
            <p>“이번에는 끝까지 확인해야겠어.”</p>
          </article>
        </div>
      </section>

      <section className="reader-settings-group reader-settings-choice-group">
        <h3>읽기 방식</h3>
        <div className="segmented full" aria-label="읽기 방식">
          <button
            type="button"
            className={profile.modeLock === 'auto' ? 'active' : ''}
            onClick={() => updateProfile({ modeLock: 'auto' })}
            aria-pressed={profile.modeLock === 'auto'}
          >
            자동 전환
          </button>
          <button
            type="button"
            className={profile.modeLock === 'scroll' ? 'active' : ''}
            onClick={() => updateProfile({ modeLock: 'scroll' })}
            aria-pressed={profile.modeLock === 'scroll'}
          >
            스크롤
          </button>
          <button
            type="button"
            className={profile.modeLock === 'paginated' ? 'active' : ''}
            onClick={() => updateProfile({ modeLock: 'paginated' })}
            aria-pressed={profile.modeLock === 'paginated'}
          >
            페이지
          </button>
        </div>
        {profile.modeLock === 'auto' && (
          <p className="field-help">입력 방식에 맞춰 스크롤과 페이지 보기를 전환합니다.</p>
        )}
        {profile.modeLock !== 'scroll' && (
          <div className="reader-settings-subsection">
            <h3>페이지 전환</h3>
            <div className="segmented full" aria-label="페이지 전환 효과">
              <button
                type="button"
                className={profile.pageTurnMotion === 'instant' ? 'active' : ''}
                onClick={() => updateProfile({ pageTurnMotion: 'instant' })}
                aria-pressed={profile.pageTurnMotion === 'instant'}
              >
                즉시
              </button>
              <button
                type="button"
                className={profile.pageTurnMotion === 'smooth' ? 'active' : ''}
                onClick={() => updateProfile({ pageTurnMotion: 'smooth' })}
                aria-pressed={profile.pageTurnMotion === 'smooth'}
              >
                부드럽게
              </button>
            </div>
          </div>
        )}
        <label className="reader-settings-toggle reader-settings-control-toggle">
          <input
            type="checkbox"
            checked={settings.keepScreenChrome}
            onChange={(event) => controller.updateSettings({ keepScreenChrome: event.target.checked })}
          />
          <span>도구 모음 항상 표시</span>
        </label>
      </section>
    </>
  );
}
