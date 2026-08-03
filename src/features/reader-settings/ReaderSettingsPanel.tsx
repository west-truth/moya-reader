import { RefreshCw } from 'lucide-react';
import { Dialog } from '../../shared/ui/Dialog';
import { ReaderSettingsAppearance } from './ReaderSettingsAppearance';
import { ReaderSettingsLayout } from './ReaderSettingsLayout';
import { ReaderGestureSettings } from './ReaderGestureSettings';
import type { ReaderSettingsController } from './useReaderSettingsDraft';
import type { GestureBindings, ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import './reader-settings-panel.css';
import { useState } from 'react';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { ApplicationInfoSettings } from './ApplicationInfoSettings';
import type { PlatformRuntimeInfo, ProviderExecutionRuntimeKind } from '../../platform/runtime';

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

export default function ReaderSettingsPanel(props: ReaderSettingsPanelProps) {
  const { controller, profile } = props;
  const [tab, setTab] = useState<'appearance' | 'layout' | 'gesture' | 'application'>('appearance');
  const readingTab = tab !== 'application';
  return (
    <Dialog
      open={controller.open}
      title="설정"
      onClose={controller.closePanel}
      className="reader-settings-dialog"
      closeLabel="설정 닫기"
    >
      <div className="reader-settings-body">
        <div className="segmented full reader-settings-tabs" role="tablist" aria-label="읽기 설정 분류">
          <button
            role="tab"
            id="reader-settings-tab-appearance"
            aria-controls="reader-settings-panel-appearance"
            aria-selected={tab === 'appearance'}
            className={tab === 'appearance' ? 'active' : ''}
            onClick={() => setTab('appearance')}
          >
            테마·글꼴
          </button>
          <button
            role="tab"
            id="reader-settings-tab-layout"
            aria-controls="reader-settings-panel-layout"
            aria-selected={tab === 'layout'}
            className={tab === 'layout' ? 'active' : ''}
            onClick={() => setTab('layout')}
          >
            조판
          </button>
          <button
            role="tab"
            id="reader-settings-tab-gesture"
            aria-controls="reader-settings-panel-gesture"
            aria-selected={tab === 'gesture'}
            className={tab === 'gesture' ? 'active' : ''}
            onClick={() => setTab('gesture')}
          >
            제스처
          </button>
          <button
            role="tab"
            id="reader-settings-tab-application"
            aria-controls="reader-settings-panel-application"
            aria-selected={tab === 'application'}
            className={tab === 'application' ? 'active' : ''}
            onClick={() => setTab('application')}
          >
            앱 정보
          </button>
        </div>
        <div className="reader-settings-content">
          <div
            id={`reader-settings-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`reader-settings-tab-${tab}`}
            className="reader-settings-panel"
          >
            {tab === 'appearance' && (
              <ReaderSettingsAppearance
                profile={profile}
                updateProfile={props.updateProfile}
                personalizationRepository={props.personalizationRepository}
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
          {readingTab && props.contrastWarning && (
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
          {readingTab && (
            <div className="reader-settings-footer">
              <label className="reader-settings-toggle">
                <input
                  type="checkbox"
                  checked={props.bookOverrideEnabled}
                  onChange={(event) => props.setBookOverrideEnabled(event.target.checked)}
                />
                <span>이 책에만 적용</span>
              </label>
              <button type="button" className="ghost-btn" onClick={props.resetProfile}>
                <RefreshCw size={17} /> {props.bookOverrideEnabled ? '책 설정 초기화' : '기본값'}
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
          {readingTab && (
            <div
              className={`reader-settings-preview font-${controller.settings.font}`}
              style={{
                fontWeight: profile.fontWeight,
                lineHeight: profile.lineHeight,
                letterSpacing: `${profile.letterSpacing}em`,
                textAlign: profile.textAlign,
              }}
            >
              <p>
                비가 그친 뒤의 거리는 조용했다. 활자는 적당한 간격으로 놓였고, 눈은 다음 문장으로 자연스럽게 이동했다.
              </p>
              <p>"이 정도면 오래 읽어도 피로하지 않겠군요."</p>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
