import { SlidersHorizontal } from 'lucide-react';
import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import { Dialog } from '../../shared/ui/Dialog';
import { SettingsSlider } from '../reader-settings/SettingsSlider';
import { READING_PROFILE_LIMITS } from '../reader-settings/reading-profile';
import type { ReaderRuntimeFlow } from './ReaderViewport';
import '../reader-settings/reader-settings-panel.css';

const QUICK_THEMES: ReadonlyArray<{ id: ReadingProfile['theme']; label: string; color: string }> = [
  { id: 'light', label: '밝게', color: '#f5f2e9' },
  { id: 'sepia', label: '세피아', color: '#eadfca' },
  { id: 'dark', label: '어둡게', color: '#242321' },
  { id: 'midnight', label: '밤', color: '#151923' },
];

export function ReaderQuickViewDialog({
  open,
  profile,
  readingFlow,
  bookOverrideEnabled,
  onClose,
  onUpdate,
  onSetBookOverride,
  onOpenAllSettings,
  saveState,
  onRetrySave,
}: {
  readonly saveState?: { readonly saving: boolean; readonly dirty: boolean; readonly error: boolean };
  readonly onRetrySave?: () => void;
  readonly open: boolean;
  readonly profile: ReadingProfile;
  readonly readingFlow: ReaderRuntimeFlow;
  readonly bookOverrideEnabled: boolean;
  readonly onClose: () => void;
  readonly onUpdate: (patch: ReadingProfileOverride) => void;
  readonly onSetBookOverride: (enabled: boolean) => void;
  readonly onOpenAllSettings: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="빠른 보기"
      onClose={onClose}
      className="reader-quick-view-dialog"
      backdropClassName="reader-quick-view-backdrop"
      closeLabel="빠른 보기 닫기"
    >
      <div className="reader-quick-view-content">
        <div role={saveState?.error ? 'alert' : 'status'}>
          {saveState?.error ? (
            <>
              설정을 저장하지 못했습니다.{' '}
              <button type="button" className="ghost-btn" onClick={onRetrySave}>
                다시 저장
              </button>
            </>
          ) : saveState?.saving ? (
            '저장 중…'
          ) : saveState?.dirty ? (
            '변경 사항을 곧 저장합니다.'
          ) : (
            '변경 사항은 자동 저장됩니다.'
          )}
        </div>
        <div className="reader-quick-view-scope">
          <span>
            <strong>{bookOverrideEnabled ? '이 작품에만 적용' : '이 기기의 기본값'}</strong>
            <small>
              {bookOverrideEnabled
                ? '이 작품에서 바꾼 보기만 기본값 위에 적용합니다.'
                : '작품별 설정이 없는 텍스트 작품에 적용합니다.'}
            </small>
          </span>
          <button type="button" className="ghost-btn" onClick={() => onSetBookOverride(!bookOverrideEnabled)}>
            {bookOverrideEnabled ? '기본값 사용' : '이 작품만'}
          </button>
        </div>

        <section className="reader-quick-view-section">
          <h3>테마</h3>
          <div className="reader-quick-theme-grid">
            {QUICK_THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={profile.theme === theme.id ? 'active' : ''}
                aria-pressed={profile.theme === theme.id}
                onClick={() => onUpdate({ theme: theme.id })}
              >
                <span style={{ background: theme.color }} aria-hidden="true" />
                {theme.label}
              </button>
            ))}
          </div>
        </section>

        <section className="reader-quick-view-section">
          <SettingsSlider
            label="글자 크기"
            value={profile.fontSize}
            min={READING_PROFILE_LIMITS.fontSize.min}
            max={READING_PROFILE_LIMITS.fontSize.max}
            step={1}
            suffix="px"
            onChange={(fontSize) => onUpdate({ fontSize })}
          />
          <SettingsSlider
            label="줄 간격"
            value={profile.lineHeight}
            min={READING_PROFILE_LIMITS.lineHeight.min}
            max={READING_PROFILE_LIMITS.lineHeight.max}
            step={0.05}
            onChange={(lineHeight) => onUpdate({ lineHeight })}
          />
        </section>

        <section className="reader-quick-view-section">
          <h3>읽기 방식</h3>
          <div className="segmented full" aria-label="빠른 읽기 방식">
            <button
              type="button"
              className={readingFlow === 'scroll' ? 'active' : ''}
              aria-pressed={readingFlow === 'scroll'}
              onClick={() => onUpdate({ modeLock: 'scroll', flow: 'scroll' })}
            >
              스크롤
            </button>
            <button
              type="button"
              className={readingFlow === 'paginated' ? 'active' : ''}
              aria-pressed={readingFlow === 'paginated'}
              onClick={() => onUpdate({ modeLock: 'paginated', flow: 'paginated' })}
            >
              페이지
            </button>
          </div>
          {readingFlow === 'paginated' && (
            <div className="segmented full" aria-label="페이지 펼침">
              {(
                [
                  ['single', '한 쪽'],
                  ['double', '두 쪽'],
                  ['auto', '화면에 맞게'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={profile.pageSpread === value ? 'active' : ''}
                  aria-pressed={profile.pageSpread === value}
                  onClick={() => onUpdate({ pageSpread: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </section>

        {readingFlow === 'paginated' && profile.pageSpread !== 'single' && (
          <p className="field-help">화면이 좁으면 한 쪽으로 표시합니다.</p>
        )}
        <section className="reader-quick-view-section">
          <h3>좌우 여백</h3>
          <div className="segmented full" aria-label="빠른 좌우 여백">
            {(
              [
                [4, '좁게'],
                [12, '보통'],
                [20, '넓게'],
              ] as const
            ).map(([marginX, label]) => (
              <button
                key={marginX}
                type="button"
                className={profile.marginX === marginX ? 'active' : ''}
                aria-pressed={profile.marginX === marginX}
                onClick={() => onUpdate({ marginX })}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <button
          type="button"
          className="reader-quick-view-all ghost-btn"
          onClick={() => {
            onClose();
            onOpenAllSettings();
          }}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          글꼴·색상·조판 전체 설정
        </button>
      </div>
    </Dialog>
  );
}
