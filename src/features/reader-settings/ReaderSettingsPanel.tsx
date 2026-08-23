import {
  BookOpenText,
  ChevronRight,
  Info,
  Keyboard,
  LayoutPanelTop,
  Palette,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import type { GestureBindings, ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import type { PlatformRuntimeInfo, ProviderExecutionRuntimeKind } from '../../platform/runtime';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { Dialog } from '../../shared/ui/Dialog';
import { ApplicationInfoSettings } from './ApplicationInfoSettings';
import { ReaderGestureSettings } from './ReaderGestureSettings';
import { ReaderSettingsAppearance } from './ReaderSettingsAppearance';
import { ReaderSettingsLayout } from './ReaderSettingsLayout';
import { resolveReaderThemeColors } from './reader-theme-colors';
import type { ReaderSettingsController } from './useReaderSettingsDraft';
import './reader-settings-panel.css';

type SettingsTab = 'appearance' | 'layout' | 'gesture' | 'application';

interface SettingsSection {
  readonly id: SettingsTab;
  readonly label: string;
  readonly detail: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'appearance',
    label: '화면',
    detail: '테마, 글꼴, 밝기',
    description: '앱과 리더의 색상, 본문 글꼴을 선택합니다.',
    icon: Palette,
  },
  {
    id: 'layout',
    label: '본문',
    detail: '글자, 여백, 읽기 방식',
    description: '본문 조판과 이동 방식을 조정합니다.',
    icon: LayoutPanelTop,
  },
  {
    id: 'gesture',
    label: '조작',
    detail: '탭, 스와이프, 화면 유지',
    description: '화면 입력과 기기 동작을 설정합니다.',
    icon: Keyboard,
  },
  {
    id: 'application',
    label: '정보',
    detail: '버전, 환경, 라이선스',
    description: '앱과 실행 환경 정보를 확인합니다.',
    icon: BookOpenText,
  },
];

export interface ReaderSettingsPanelProps {
  readonly controller: ReaderSettingsController;
  readonly profile: ReadingProfile;
  readonly bookOverrideEnabled: boolean;
  readonly contrastWarning: boolean;
  readonly gestureBindings: GestureBindings;
  readonly personalizationRepository?: ReaderPersonalizationRepository;
  readonly platformRuntime: PlatformRuntimeInfo;
  readonly providerExecutionRuntime: ProviderExecutionRuntimeKind;
  updateProfile(patch: ReadingProfileOverride): void;
  setBookOverrideEnabled(enabled: boolean): void;
  resetProfile(): void;
  updateGestureBindings(patch: Partial<GestureBindings>): void;
}

function saveStatusLabel(controller: ReaderSettingsController): string {
  if (controller.saveError) return '저장하지 못했습니다.';
  if (controller.saveStatus === 'saving') return '변경 사항을 저장하는 중입니다.';
  if (controller.isDirty) return '변경 사항을 곧 자동 저장합니다.';
  return '변경 사항은 이 기기에 자동 저장됩니다.';
}

export default function ReaderSettingsPanel(props: ReaderSettingsPanelProps) {
  const { controller, profile } = props;
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [appearanceThemeTarget, setAppearanceThemeTarget] = useState<'application' | 'reader'>('application');
  const current = SETTINGS_SECTIONS.find((section) => section.id === tab) ?? SETTINGS_SECTIONS[0];
  const readerThemeColors = resolveReaderThemeColors(profile);
  const readingTab = tab !== 'application';
  const showReadingFooter = readingTab && !(tab === 'appearance' && appearanceThemeTarget === 'application');

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? SETTINGS_SECTIONS.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
    const next = SETTINGS_SECTIONS[nextIndex];
    if (!next) return;
    setTab(next.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <Dialog
      open={controller.open}
      title={
        <span className="reader-settings-dialog-title">
          <span className="reader-settings-brand">
            <img src="/icons/moya-192.png" alt="" aria-hidden="true" />
            <span>설정</span>
          </span>
        </span>
      }
      onClose={controller.closePanel}
      className="reader-settings-dialog"
      backdropClassName="reader-settings-backdrop"
      closeLabel="설정 닫기"
    >
      <div className="reader-settings-body">
        <nav className="reader-settings-tabs" role="tablist" aria-label="설정 분류">
          {SETTINGS_SECTIONS.map((section, index) => {
            const Icon = section.icon;
            const selected = section.id === tab;
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                id={`reader-settings-tab-${section.id}`}
                aria-controls={`reader-settings-panel-${section.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={selected ? 'active' : ''}
                onClick={() => setTab(section.id)}
                onKeyDown={(event) => navigateTabs(event, index)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>
                  <strong>{section.label}</strong>
                  <small>{section.detail}</small>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            );
          })}
          <p className="reader-settings-save-note" role="status" aria-live="polite">
            <Info size={15} aria-hidden="true" />
            <span>{saveStatusLabel(controller)}</span>
          </p>
        </nav>

        <main className="reader-settings-main" data-has-footer={showReadingFooter || undefined}>
          <div className="reader-settings-content">
            <header className="reader-settings-page-title">
              <h2>{current.label}</h2>
              <span>{current.description}</span>
            </header>
            <div
              id={`reader-settings-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`reader-settings-tab-${tab}`}
              className="reader-settings-panel"
            >
              {tab === 'appearance' && (
                <ReaderSettingsAppearance
                  controller={controller}
                  profile={profile}
                  updateProfile={props.updateProfile}
                  personalizationRepository={props.personalizationRepository}
                  themeTarget={appearanceThemeTarget}
                  setThemeTarget={setAppearanceThemeTarget}
                />
              )}
              {tab === 'layout' && (
                <ReaderSettingsLayout controller={controller} profile={profile} updateProfile={props.updateProfile} />
              )}
              {tab === 'gesture' && (
                <ReaderGestureSettings bindings={props.gestureBindings} update={props.updateGestureBindings} />
              )}
              {tab === 'application' && (
                <ApplicationInfoSettings
                  platformRuntime={props.platformRuntime}
                  providerExecutionRuntime={props.providerExecutionRuntime}
                />
              )}
            </div>
            {showReadingFooter && props.contrastWarning && (
              <div className="reader-settings-error" role="alert">
                <span>글자와 배경의 대비가 낮아 읽기 어려울 수 있습니다.</span>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => props.updateProfile({ foreground: '#eeeeea', background: '#181817' })}
                >
                  기본 대비
                </button>
              </div>
            )}
            {readingTab && controller.saveError && (
              <div className="reader-settings-error" role="alert">
                <span>읽기 설정을 저장하지 못했습니다.</span>
                <button type="button" className="ghost-btn" onClick={controller.retrySave}>
                  다시 저장
                </button>
              </div>
            )}
            {tab === 'appearance' && appearanceThemeTarget === 'reader' && (
              <div
                className={`reader-settings-preview font-${controller.settings.font}`}
                style={{
                  color: readerThemeColors.foreground,
                  background: readerThemeColors.background,
                  fontSize: `${profile.fontSize}px`,
                  fontWeight: profile.fontWeight,
                  lineHeight: profile.lineHeight,
                  letterSpacing: `${profile.letterSpacing}em`,
                  textAlign: profile.textAlign,
                  filter: `brightness(${profile.brightness})`,
                }}
                aria-label="본문 미리보기"
              >
                <p>
                  비가 그친 뒤의 거리는 조용했다. 활자는 적당한 간격으로 놓였고, 눈은 다음 문장으로 자연스럽게 이동했다.
                </p>
                <p>“이 정도면 오래 읽어도 피로하지 않겠군요.”</p>
              </div>
            )}
          </div>

          {showReadingFooter && (
            <footer className="reader-settings-footer">
              <label className="reader-settings-toggle">
                <input
                  type="checkbox"
                  checked={props.bookOverrideEnabled}
                  onChange={(event) => props.setBookOverrideEnabled(event.target.checked)}
                />
                <span>이 책에만 적용</span>
              </label>
              <button type="button" className="ghost-btn" onClick={props.resetProfile}>
                <RefreshCw size={15} aria-hidden="true" />
                {props.bookOverrideEnabled ? '책 설정 초기화' : '기본값으로 재설정'}
              </button>
            </footer>
          )}
        </main>
      </div>
    </Dialog>
  );
}
