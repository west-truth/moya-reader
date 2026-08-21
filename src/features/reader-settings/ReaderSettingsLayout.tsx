import type { ReaderSettingsController } from './useReaderSettingsDraft';
import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import {
  READER_CONTENT_WIDTH_MAX,
  READER_CONTENT_WIDTH_MIN,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
} from './reader-settings-model';
import { SettingsSlider } from './SettingsSlider';

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
  return (
    <>
      <SettingsSlider
        label="글자 크기"
        value={profile.fontSize}
        min={READER_FONT_SIZE_MIN}
        max={READER_FONT_SIZE_MAX}
        step={1}
        suffix="px"
        onChange={(fontSize) => updateProfile({ fontSize })}
      />
      <SettingsSlider
        label="글자 굵기"
        value={profile.fontWeight}
        min={300}
        max={800}
        step={100}
        onChange={(fontWeight) => updateProfile({ fontWeight })}
      />
      <SettingsSlider
        label="줄 간격"
        value={profile.lineHeight}
        min={1.35}
        max={2.6}
        step={0.05}
        onChange={(lineHeight) => updateProfile({ lineHeight })}
      />
      <SettingsSlider
        label="글자 간격"
        value={profile.letterSpacing}
        min={0}
        max={0.2}
        step={0.01}
        suffix="em"
        onChange={(letterSpacing) => updateProfile({ letterSpacing })}
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
      <SettingsSlider
        label="좌우 여백"
        value={profile.marginX}
        min={3}
        max={20}
        step={1}
        suffix="vw"
        onChange={(marginX) => updateProfile({ marginX })}
      />
      <SettingsSlider
        label="상하 여백"
        value={profile.marginY}
        min={0}
        max={12}
        step={1}
        suffix="vh"
        onChange={(marginY) => updateProfile({ marginY })}
      />
      <SettingsSlider
        label="데스크톱 본문 폭"
        value={profile.contentWidth}
        min={READER_CONTENT_WIDTH_MIN}
        max={READER_CONTENT_WIDTH_MAX}
        step={20}
        suffix="px"
        onChange={(contentWidth) => updateProfile({ contentWidth })}
      />
      <SettingsSlider
        label="밝기"
        value={profile.brightness}
        min={0.5}
        max={1}
        step={0.05}
        onChange={(brightness) => updateProfile({ brightness })}
      />
      <section>
        <h3>문단 정렬</h3>
        <div className="segmented full">
          <button
            className={profile.textAlign === 'start' ? 'active' : ''}
            onClick={() => updateProfile({ textAlign: 'start' })}
          >
            기본
          </button>
          <button
            className={profile.textAlign === 'justify' ? 'active' : ''}
            onClick={() => updateProfile({ textAlign: 'justify' })}
          >
            양쪽 맞춤
          </button>
        </div>
      </section>
      <section>
        <h3>모드 잠금</h3>
        <div className="segmented full" aria-label="모드 잠금">
          <button
            type="button"
            className={profile.modeLock === 'auto' ? 'active' : ''}
            onClick={() => updateProfile({ modeLock: 'auto' })}
            aria-pressed={profile.modeLock === 'auto'}
          >
            자동
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
          <p className="field-help">휠과 세로 스와이프는 스크롤로, 방향키와 화면 넘김은 페이지로 전환됩니다.</p>
        )}
        {profile.modeLock !== 'scroll' && (
          <div className="reader-settings-subsection">
            <h3>페이지 이동 효과</h3>
            <div className="segmented full" aria-label="페이지 이동 효과">
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
        <label className="reader-settings-toggle">
          <input
            type="checkbox"
            checked={settings.keepScreenChrome}
            onChange={(event) => controller.updateSettings({ keepScreenChrome: event.target.checked })}
          />
          <span>상단/하단 컨트롤 항상 표시</span>
        </label>
      </section>
    </>
  );
}
