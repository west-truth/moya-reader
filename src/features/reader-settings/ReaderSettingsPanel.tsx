import {
  ArrowLeft,
  BookOpenText,
  ChevronRight,
  Cloud,
  Download,
  Info,
  Keyboard,
  LayoutPanelTop,
  Palette,
  Puzzle,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GestureBindings, ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import type { PlatformRuntimeInfo, ProviderExecutionRuntimeKind } from '../../platform/runtime';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { Dialog } from '../../shared/ui/Dialog';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { AppExtensionSnapshot } from '../../extensions/app-extension-manager';
import { WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID } from '../../extensions/builtin/webnovel-metadata-enrichment-extension';
import type { BookEnrichmentAutomationController } from '../book-enrichment/useBookEnrichmentAutomation';
import type { SelfHostAccount } from '../auth/self-host-auth-client';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';
import { ExtensionSettingsPanel } from '../extensions/ExtensionSettingsPanel';
import { WebNovelMetadataExtensionSettings } from '../extensions/WebNovelMetadataExtensionSettings';
import { ExternalSourceSettingsPanel } from '../external-sources/ExternalSourceSettingsPanel';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import { ApplicationInfoSettings } from './ApplicationInfoSettings';
import { DownloadSettingsPanel } from './DownloadSettingsPanel';
import { ReaderGestureSettings } from './ReaderGestureSettings';
import { ReaderSettingsAppearance } from './ReaderSettingsAppearance';
import { ReaderSettingsLayout } from './ReaderSettingsLayout';
import { SyncAndBackupSettings } from './SyncAndBackupSettings';
import { resolveReaderThemeColors } from './reader-theme-colors';
import type { ReaderSettingsController } from './useReaderSettingsDraft';
import './reader-settings-panel.css';

export type SettingsTab =
  'appearance' | 'layout' | 'gesture' | 'sources' | 'extensions' | 'downloads' | 'sync' | 'application';

interface SettingsSection {
  readonly id: SettingsTab;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'appearance',
    label: '모양',
    detail: '앱 테마',
    icon: Palette,
  },
  {
    id: 'layout',
    label: '리더 보기',
    detail: '글자, 여백, 읽기 방식',
    icon: LayoutPanelTop,
  },
  {
    id: 'gesture',
    label: '리더 조작',
    detail: '탭, 스와이프, 화면 유지',
    icon: Keyboard,
  },
  {
    id: 'sources',
    label: '콘텐츠 소스',
    detail: '연결, 패키지, 다운로드',
    icon: Cloud,
  },
  {
    id: 'extensions',
    label: '기능 확장',
    detail: '부가 기능, 권한',
    icon: Puzzle,
  },
  {
    id: 'sync',
    label: '동기화',
    detail: '연결, 상태, 백업',
    icon: Cloud,
  },
  {
    id: 'application',
    label: '앱 정보',
    detail: '버전, 환경, 라이선스',
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
  readonly selfHostAccount?: SelfHostAccount;
  readonly logoutSelfHostAccount?: () => Promise<void>;
  readonly extensions: readonly AppExtensionSnapshot[];
  readonly installedPackages?: ReactNode;
  readonly externalSources: ExternalSourceController;
  readonly webNovelMetadataCollector?: WebNovelMetadataCollectorBroker;
  readonly bookEnrichmentAutomation?: BookEnrichmentAutomationController;
  readonly libraryCount?: number;
  readonly initialTab?: SettingsTab;
  readonly openSync: () => void;
  readonly openBackup: () => void;
  renderExtensionDetails?(extension: AppExtensionSnapshot): ReactNode;
  updateProfile(patch: ReadingProfileOverride): void;
  setBookOverrideEnabled(enabled: boolean): void;
  resetProfile(): void;
  updateGestureBindings(patch: Partial<GestureBindings>): void;
  setExtensionEnabled(extensionId: ExtensionContributionId, enabled: boolean): void;
}

function saveStatusLabel(controller: ReaderSettingsController): string {
  if (controller.saveError) return '저장하지 못했습니다.';
  if (controller.saveStatus === 'saving') return '저장 중…';
  if (controller.isDirty) return '저장 대기 중…';
  return '자동 저장';
}

export default function ReaderSettingsPanel(props: ReaderSettingsPanelProps) {
  const { controller, profile } = props;
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'appearance');
  const [mobileDetail, setMobileDetail] = useState(Boolean(props.initialTab));
  const titleRef = useRef<HTMLHeadingElement>(null);
  const selectTab = (next: SettingsTab) => {
    setTab(next);
    setMobileDetail(true);
    requestAnimationFrame(() => {
      titleRef.current?.focus({ preventScroll: true });
      const content = titleRef.current?.closest('.reader-settings-content');
      if (content) content.scrollTop = 0;
    });
  };
  const backToCategories = () => {
    if (tab === 'downloads') {
      selectTab('sources');
      return;
    }
    setMobileDetail(false);
    requestAnimationFrame(() => document.getElementById(`reader-settings-tab-${tab}`)?.focus());
  };
  const current =
    tab === 'downloads'
      ? { label: '다운로드' }
      : (SETTINGS_SECTIONS.find((section) => section.id === tab) ?? SETTINGS_SECTIONS[0]);
  const readerThemeColors = resolveReaderThemeColors(profile);
  const readingTab = tab === 'appearance' || tab === 'layout' || tab === 'gesture';
  const showReadingFooter = tab === 'layout';
  const openDestination = (destination: () => void) => {
    controller.closePanel();
    destination();
  };

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? SETTINGS_SECTIONS.length - 1
          : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + SETTINGS_SECTIONS.length) %
            SETTINGS_SECTIONS.length;
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
            <span>설정</span>
          </span>
        </span>
      }
      onClose={(reason) => {
        if (reason === 'escape' && mobileDetail && window.matchMedia('(max-width: 699px)').matches) backToCategories();
        else controller.closePanel();
      }}
      className="reader-settings-dialog"
      backdropClassName="reader-settings-backdrop"
      closeLabel="설정 닫기"
    >
      <div className="reader-settings-body" data-mobile-detail={mobileDetail}>
        <nav className="reader-settings-tabs" role="tablist" aria-label="설정 분류">
          {SETTINGS_SECTIONS.map((section, index) => {
            const Icon = section.icon;
            const selected = section.id === tab || (section.id === 'sources' && tab === 'downloads');
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                id={`reader-settings-tab-${section.id}`}
                aria-controls={`reader-settings-panel-${section.id}`}
                aria-selected={selected}
                tabIndex={0}
                className={selected ? 'active' : ''}
                onClick={() => selectTab(section.id)}
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
              <button
                type="button"
                className={`ghost-btn reader-settings-mobile-back${tab === 'downloads' ? ' is-subpage' : ''}`}
                onClick={backToCategories}
              >
                <ArrowLeft size={18} />
                {tab === 'downloads' ? '콘텐츠 소스' : '설정 목록'}
              </button>
              <h2 ref={titleRef} tabIndex={-1}>
                {current.label}
              </h2>
              <small className="reader-settings-mobile-status" role="status">
                {saveStatusLabel(controller)}
              </small>
            </header>
            <div
              id={`reader-settings-panel-${tab === 'downloads' ? 'sources' : tab}`}
              role="tabpanel"
              aria-labelledby={`reader-settings-tab-${tab === 'downloads' ? 'sources' : tab}`}
              className="reader-settings-panel"
            >
              {tab === 'appearance' && (
                <ReaderSettingsAppearance
                  controller={controller}
                  profile={profile}
                  updateProfile={props.updateProfile}
                  personalizationRepository={props.personalizationRepository}
                  themeTarget="application"
                />
              )}
              {tab === 'layout' && (
                <>
                  <ReaderSettingsAppearance
                    controller={controller}
                    profile={profile}
                    updateProfile={props.updateProfile}
                    personalizationRepository={props.personalizationRepository}
                    themeTarget="reader"
                  />
                  <ReaderSettingsLayout controller={controller} profile={profile} updateProfile={props.updateProfile} />
                </>
              )}
              {tab === 'gesture' && (
                <ReaderGestureSettings bindings={props.gestureBindings} update={props.updateGestureBindings} />
              )}
              {tab === 'extensions' && (
                <ExtensionSettingsPanel
                  extensions={props.extensions}
                  setEnabled={props.setExtensionEnabled}
                  renderDetails={(extension) =>
                    props.renderExtensionDetails?.(extension) ??
                    (extension.id === WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID &&
                    props.webNovelMetadataCollector &&
                    props.bookEnrichmentAutomation ? (
                      <WebNovelMetadataExtensionSettings
                        broker={props.webNovelMetadataCollector}
                        automation={props.bookEnrichmentAutomation}
                        extensionEnabled={extension.enabled}
                        libraryCount={props.libraryCount ?? 0}
                        confirm={(message) => window.confirm(message)}
                      />
                    ) : undefined)
                  }
                />
              )}
              {tab === 'sources' && (
                <div className="reader-settings-source-sections">
                  <section className="reader-settings-source-intro" aria-label="콘텐츠 소스 구성">
                    <span>
                      <strong>사용 중</strong>
                      <small>연결하고 켠 작품 제공자</small>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                    <span>
                      <strong>패키지</strong>
                      <small>소스를 설치·업데이트하는 단위</small>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                    <span>
                      <strong>저장소</strong>
                      <small>설치 가능한 패키지 목록 주소</small>
                    </span>
                  </section>
                  <button type="button" className="ghost-btn" onClick={() => selectTab('downloads')}>
                    <Download size={18} aria-hidden="true" /> 다운로드 및 저장공간
                  </button>
                  {props.installedPackages}
                  <ExternalSourceSettingsPanel
                    controller={props.externalSources}
                    onBrowse={(id) => openDestination(() => props.externalSources.show(id))}
                  />
                </div>
              )}
              {tab === 'downloads' && <DownloadSettingsPanel controller={props.externalSources} />}
              {tab === 'sync' && (
                <SyncAndBackupSettings
                  openSync={() => openDestination(props.openSync)}
                  openBackup={() => openDestination(props.openBackup)}
                />
              )}
              {tab === 'application' && (
                <ApplicationInfoSettings
                  platformRuntime={props.platformRuntime}
                  providerExecutionRuntime={props.providerExecutionRuntime}
                  selfHostAccount={props.selfHostAccount}
                  logoutSelfHostAccount={props.logoutSelfHostAccount}
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
            {tab === 'layout' && (
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
