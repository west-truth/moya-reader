import {
  Check,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { projectSpokenText } from '@noveldesk/text-core/spoken-text';
import type {
  Character,
  SpokenTextRule,
  TTSDownloadJob,
  TTSPlaybackSettings,
  TTSPlaybackSettingsOverride,
  VoiceProfile,
} from '../../domain/types';
import type { ProviderCatalogItem, ProviderOptionConfig } from '../../providers/provider-jobs';
import {
  providerOptionValueFromRecord,
  providerVoiceProfileOptionConfigs,
  type ProviderSettingsDraft,
} from '../../providers/provider-settings-ui';
import type { ActiveTTSPlayback } from '../../providers/tts-playback-session';
import type { TTSStatus, TTSVoice } from '../../providers/tts';
import { voiceApprovalForProfile, type VoiceProductStateV1, type VoiceSampleKind } from '../../providers/voice-product';
import type { RemoteProviderJob, RemoteProviderSettings } from '../../services/remote/remote-api-client';
import type { HostedTTSOfflineCacheStatus } from '../../storage/hosted-tts-offline-cache';
import { formatBytes, formatCount } from '../../utils/format';
import ProviderSettingsPanel, { type ProviderSettingsPanelController } from '../providers/ProviderSettingsPanel';
import type { SpokenTextRuleImpactSummary } from './spoken-text-rule-impact';
import type { VoiceCastingPoolView } from './useVoiceProductController';

export interface VoiceTarget {
  readonly role: VoiceProfile['role'];
  readonly characterId?: string;
  readonly label: string;
}

interface DisplayVoiceTarget extends VoiceTarget {
  readonly color?: string;
}

export interface TTSAddonPanelProps {
  readonly status?: TTSStatus;
  readonly statusTone: string;
  readonly selectedVoiceMissing: boolean;
  readonly unavailable: boolean;
  readonly hostedPlaybackReady: boolean;
  readonly paragraphCount: number;
  readonly bookLanguage?: string;
  readonly paragraphIndex?: number;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly speed: number;
  readonly playbackSettings: TTSPlaybackSettings;
  readonly bookOverrideEnabled: boolean;
  readonly pitchSupported: boolean;
  readonly resumeLabel?: string;
  readonly selectedSystemVoiceId?: string;
  readonly voices: readonly TTSVoice[];
  readonly characters: readonly Character[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly selectedHostedProvider?: ProviderCatalogItem;
  readonly selectedHostedProviderLabel: string;
  readonly selectedHostedVoices: readonly TTSVoice[];
  readonly savedTTSSettings?: RemoteProviderSettings;
  readonly hostedBusy: boolean;
  readonly hostedVoicesLoadingProvider?: string;
  readonly hostedWarmupDisabled: boolean;
  readonly hostedStatus?: string;
  readonly hostedJob?: RemoteProviderJob;
  readonly offlineDownloadJob?: TTSDownloadJob;
  readonly offlineDownloadError?: string;
  readonly offlineDownloadPolicy?: Pick<TTSDownloadJob['policy'], 'network' | 'charging'>;
  readonly hostedOfflineCacheStatus?: HostedTTSOfflineCacheStatus;
  readonly activePlayback?: ActiveTTSPlayback;
  readonly providers: readonly ProviderCatalogItem[];
  readonly providerDraft?: ProviderSettingsDraft;
  readonly providerController: ProviderSettingsPanelController;
  readonly voiceProductState?: VoiceProductStateV1;
  readonly voiceProductBusy: boolean;
  readonly voiceSampleBusyProfileId?: string;
  readonly voiceProductSummary: { readonly major: number; readonly approved: number; readonly stale: number };
  readonly spokenTextRules: readonly SpokenTextRule[];
  readonly spokenPreviewRequest?: { readonly id: number; readonly text: string };
  readonly voiceCastingSummary?: {
    readonly assigned: number;
    readonly reviews: number;
    readonly unresolved: number;
    readonly stale: boolean;
  };
  readonly voicePoolViews: {
    readonly system?: VoiceCastingPoolView;
    readonly hosted?: VoiceCastingPoolView;
  };
  readonly bookCharacterCount: number;
  refreshStatus(): void | Promise<unknown>;
  jump(direction: -1 | 1): void;
  start(): void | Promise<unknown>;
  resume(): void;
  pause(): void;
  stop(): void;
  changeSpeed(value: number): void;
  changePlaybackSettings(patch: TTSPlaybackSettingsOverride): void;
  setBookOverrideEnabled(enabled: boolean): void;
  resetBookOverride(): void;
  resumeSavedPlayback(): void | Promise<unknown>;
  changeSystemVoice(value?: string): void;
  saveSystemVoice(target: VoiceTarget, providerVoiceId: string): void | Promise<unknown>;
  saveHostedVoice(target: VoiceTarget, providerVoiceId: string): void | Promise<unknown>;
  saveHostedVoiceOption(
    target: VoiceTarget,
    option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
    value: string | number | boolean | undefined,
  ): void | Promise<unknown>;
  refreshHostedVoices(providerId: string): void | Promise<unknown>;
  warmup(scope: 'current' | 'nearby' | 'book'): void | Promise<unknown>;
  changeOfflineDownloadPolicy(patch: Partial<Pick<TTSDownloadJob['policy'], 'network' | 'charging'>>): void;
  requestHostedOfflineStorage(): void | Promise<unknown>;
  removeStaleHostedOfflineAudio(): void | Promise<unknown>;
  generateVoiceDraft(scope: 'system' | 'hosted'): void | Promise<unknown>;
  saveVoicePool(
    scope: 'system' | 'hosted',
    voiceProfileIds: readonly string[],
    userPinned: boolean,
  ): void | Promise<unknown>;
  playVoiceSample(profile: VoiceProfile, kind: VoiceSampleKind): void | Promise<unknown>;
  decideVoice(profile: VoiceProfile, decision: 'approved' | 'rejected'): void | Promise<unknown>;
  savePronunciationRule(input: { sourceTerm: string; replacement: string; mode: 'literal' }): void | Promise<unknown>;
  deletePronunciationRule(id: string): void | Promise<unknown>;
  saveSpokenTextSkipRule(
    pattern: string,
    kind: Extract<SpokenTextRule['kind'], 'skip_line' | 'skip_prefix' | 'skip_suffix'>,
  ): void | Promise<unknown>;
  deleteSpokenTextSkipRule(id: string): void | Promise<unknown>;
  previewSpokenTextRuleImpact(signal: AbortSignal): Promise<SpokenTextRuleImpactSummary>;
  setMinorFallbackEnabled(enabled: boolean): void | Promise<unknown>;
  setMajorCharacterLimit(value: number): void | Promise<unknown>;
}

const ROLE_TARGETS: readonly DisplayVoiceTarget[] = [
  { role: 'narrator', label: '내레이터' },
  { role: 'system', label: '시스템 문구' },
  { role: 'unknown', label: '화자 미정' },
];

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function statusTitle(status?: TTSStatus): string {
  if (!status) return 'TTS 상태 확인 중';
  if (!status.canSpeak) return 'TTS 사용 불가';
  if (!status.voicesAvailable) return '기본 음성 사용';
  return '시스템 TTS 준비됨';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function lifecycleCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function profileMatchesTarget(profile: VoiceProfile, target: VoiceTarget): boolean {
  return (
    profile.role === target.role &&
    (target.characterId ? profile.characterId === target.characterId : !profile.characterId)
  );
}

function VoiceOptionControl({
  target,
  profile,
  option,
  disabled,
  onChange,
}: {
  readonly target: DisplayVoiceTarget;
  readonly profile?: VoiceProfile;
  readonly option: ProviderOptionConfig;
  readonly disabled: boolean;
  readonly onChange: TTSAddonPanelProps['saveHostedVoiceOption'];
}) {
  const value = providerOptionValueFromRecord(profile?.providerOptions, option.optionKey);
  const label = (
    <span>
      <strong>{option.displayName}</strong>
      <small>{option.optionKey}</small>
    </span>
  );

  if (option.valueType === 'boolean') {
    return (
      <label className="voice-profile-option-control">
        {label}
        <select
          disabled={disabled}
          value={value === undefined ? '' : String(value)}
          onChange={(event) =>
            void onChange(target, option, event.target.value === '' ? undefined : event.target.value === 'true')
          }
        >
          <option value="">Default</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      </label>
    );
  }

  if (option.valueType === 'select') {
    return (
      <label className="voice-profile-option-control">
        {label}
        <select
          disabled={disabled}
          value={value === undefined ? '' : String(value)}
          onChange={(event) => void onChange(target, option, event.target.value || undefined)}
        >
          <option value="">Default</option>
          {(option.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (option.valueType === 'number') {
    return (
      <label className="voice-profile-option-control">
        {label}
        <input
          className="text-input"
          type="number"
          min={option.min}
          max={option.max}
          step={option.step ?? 'any'}
          disabled={disabled}
          value={value === undefined ? '' : String(value)}
          placeholder={option.defaultValue === undefined ? '' : String(option.defaultValue)}
          onChange={(event) =>
            void onChange(target, option, event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
      </label>
    );
  }

  return (
    <label className="voice-profile-option-control">
      {label}
      <input
        className="text-input"
        disabled={disabled}
        value={value === undefined ? '' : String(value)}
        placeholder={option.defaultValue === undefined ? '' : String(option.defaultValue)}
        onChange={(event) => void onChange(target, option, event.target.value || undefined)}
      />
    </label>
  );
}

function HostedVoiceRow({
  target,
  profile,
  provider,
  voices,
  defaultVoiceId,
  options,
  onSave,
  onSaveOption,
}: {
  readonly target: DisplayVoiceTarget;
  readonly profile?: VoiceProfile;
  readonly provider?: ProviderCatalogItem;
  readonly voices: readonly TTSVoice[];
  readonly defaultVoiceId: string;
  readonly options: readonly ProviderOptionConfig[];
  readonly onSave: TTSAddonPanelProps['saveHostedVoice'];
  readonly onSaveOption: TTSAddonPanelProps['saveHostedVoiceOption'];
}) {
  return (
    <div className="hosted-voice-profile-item">
      <label className="voice-profile-row hosted">
        <span>
          {target.color ? <i style={{ background: target.color }} /> : null}
          {target.label}
        </span>
        {voices.length > 0 ? (
          <select
            value={profile?.providerVoiceId ?? ''}
            disabled={!provider}
            onChange={(event) => void onSave(target, event.target.value)}
          >
            <option value="">기본 음성</option>
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="text-input"
            key={`${target.role}-${target.characterId ?? 'default'}-${profile?.id ?? 'empty'}`}
            defaultValue={profile?.providerVoiceId ?? ''}
            disabled={!provider}
            placeholder={defaultVoiceId}
            onBlur={(event) => void onSave(target, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        )}
      </label>
      {options.length > 0 && (
        <div className="voice-profile-option-grid">
          {options.map((option) => (
            <VoiceOptionControl
              key={option.optionKey}
              target={target}
              profile={profile}
              option={option}
              disabled={!provider}
              onChange={onSaveOption}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VoicePoolEditor({
  scope,
  label,
  view,
  busy,
  sampleBusyProfileId,
  onSave,
  onSample,
}: {
  readonly scope: 'system' | 'hosted';
  readonly label: string;
  readonly view: VoiceCastingPoolView;
  readonly busy: boolean;
  readonly sampleBusyProfileId?: string;
  readonly onSave: TTSAddonPanelProps['saveVoicePool'];
  readonly onSample: TTSAddonPanelProps['playVoiceSample'];
}) {
  const selectedIds = view.options.filter((option) => option.selected).map((option) => option.profile.id);
  const allIds = view.options.map((option) => option.profile.id);
  return (
    <div className="voice-pool-editor">
      <div className="setting-line">
        <strong>{label}</strong>
        <span>{view.userPinned ? `${selectedIds.length}개 고정` : `${selectedIds.length}개 자동`}</span>
      </div>
      <div className="voice-pool-options">
        {view.options.map((option) => {
          const nextIds = option.selected
            ? selectedIds.filter((profileId) => profileId !== option.profile.id)
            : [...selectedIds, option.profile.id];
          return (
            <div className="voice-pool-option" key={option.profile.id}>
              <label>
                <input
                  type="checkbox"
                  checked={option.selected}
                  disabled={busy || (option.selected && selectedIds.length === 1)}
                  onChange={() => void onSave(scope, nextIds, true)}
                />
                <span>{option.voice.label}</span>
              </label>
              <button
                className="icon-btn"
                title={`${option.voice.label} 샘플 재생`}
                aria-label={`${option.voice.label} 샘플 재생`}
                disabled={sampleBusyProfileId === option.profile.id}
                onClick={() => void onSample(option.profile, 'neutral')}
              >
                <Play size={14} />
              </button>
            </div>
          );
        })}
      </div>
      {view.userPinned && (
        <button className="ghost-btn compact" disabled={busy} onClick={() => void onSave(scope, allIds, false)}>
          <RotateCcw size={14} /> 자동 구성
        </button>
      )}
    </div>
  );
}

export default function TTSAddonPanel(props: TTSAddonPanelProps) {
  const speedId = useId();
  const chapterEndId = useId();
  const sleepTimerId = useId();
  const systemVoiceId = useId();
  const [pronunciationSource, setPronunciationSource] = useState('');
  const [pronunciationReplacement, setPronunciationReplacement] = useState('');
  const [skipPattern, setSkipPattern] = useState('');
  const [skipKind, setSkipKind] = useState<'skip_line' | 'skip_prefix' | 'skip_suffix'>('skip_prefix');
  const [spokenPreviewSource, setSpokenPreviewSource] = useState('2026-08-01 12:30, API 문서를 확인했다.');
  const [spokenRuleImpact, setSpokenRuleImpact] = useState<SpokenTextRuleImpactSummary>();
  const [spokenRuleImpactBusy, setSpokenRuleImpactBusy] = useState(false);
  const [spokenRuleImpactError, setSpokenRuleImpactError] = useState<string>();
  const spokenRuleImpactControllerRef = useRef<AbortController | undefined>(undefined);
  const [panelView, setPanelView] = useState<'playback' | 'advanced'>('playback');
  useEffect(() => {
    const source = props.spokenPreviewRequest?.text.trim();
    if (!source) return;
    setSpokenPreviewSource(source);
    setPanelView('advanced');
  }, [props.spokenPreviewRequest]);
  const spokenPreview = useMemo(
    () =>
      projectSpokenText({
        text: spokenPreviewSource,
        language: props.bookLanguage ?? 'ko-KR',
        rules: [
          ...props.spokenTextRules,
          ...(props.voiceProductState?.pronunciationProfile.rules ?? []).map<SpokenTextRule>((rule) => ({
            id: rule.id,
            scope: 'book',
            bookId: props.voiceProductState?.novelId,
            kind: 'replace_literal',
            pattern: rule.sourceTerm,
            replacement: rule.replacement,
            enabled: true,
            priority: 100,
            updatedAt: props.voiceProductState?.pronunciationProfile.updatedAt ?? '',
          })),
        ],
        rubyPolicy: 'reading',
        footnotePolicy: 'skip_marker',
      }),
    [props.bookLanguage, props.spokenTextRules, props.voiceProductState, spokenPreviewSource],
  );
  const spokenPreviewPattern = spokenPreviewSource.trim();
  const spokenPreviewAlreadySkipped = props.spokenTextRules.some(
    (rule) => rule.enabled && rule.kind === 'skip_line' && rule.pattern === spokenPreviewPattern,
  );
  const activeSkipRuleSignature = props.spokenTextRules
    .filter((rule) => rule.enabled && rule.kind !== 'replace_literal' && rule.pattern.trim())
    .map((rule) => `${rule.id}:${rule.updatedAt}:${rule.kind}:${rule.pattern}`)
    .join('|');
  const hasActiveSkipRules = activeSkipRuleSignature.length > 0;
  useEffect(() => {
    spokenRuleImpactControllerRef.current?.abort();
    spokenRuleImpactControllerRef.current = undefined;
    setSpokenRuleImpact(undefined);
    setSpokenRuleImpactError(undefined);
    setSpokenRuleImpactBusy(false);
  }, [activeSkipRuleSignature]);
  useEffect(
    () => () => {
      spokenRuleImpactControllerRef.current?.abort();
    },
    [],
  );
  const inspectSpokenRuleImpact = async () => {
    spokenRuleImpactControllerRef.current?.abort();
    const controller = new AbortController();
    spokenRuleImpactControllerRef.current = controller;
    setSpokenRuleImpactBusy(true);
    setSpokenRuleImpactError(undefined);
    try {
      const summary = await props.previewSpokenTextRuleImpact(controller.signal);
      if (!controller.signal.aborted) setSpokenRuleImpact(summary);
    } catch (error) {
      if (!controller.signal.aborted) {
        setSpokenRuleImpactError(error instanceof Error ? error.message : '책 전체 영향을 확인하지 못했습니다.');
      }
    } finally {
      if (spokenRuleImpactControllerRef.current === controller) {
        spokenRuleImpactControllerRef.current = undefined;
        setSpokenRuleImpactBusy(false);
      }
    }
  };
  const systemProfiles = props.voiceProfiles.filter((profile) => profile.providerId === 'system');
  const hostedProfiles = props.selectedHostedProvider
    ? props.voiceProfiles.filter((profile) => profile.providerId === props.selectedHostedProvider?.providerId)
    : [];
  const hostedOptions = props.selectedHostedProvider
    ? providerVoiceProfileOptionConfigs(props.selectedHostedProvider)
    : [];
  const defaultVoiceOption = props.selectedHostedProvider
    ? props.savedTTSSettings?.providerOptionsByProvider[props.selectedHostedProvider.providerId]?.voice
    : undefined;
  const defaultVoiceId =
    typeof defaultVoiceOption === 'string' && defaultVoiceOption.trim()
      ? defaultVoiceOption.trim()
      : props.selectedHostedProvider?.providerId === 'openai-tts'
        ? 'alloy'
        : 'default';
  const hostedLifecycle = recordValue(recordValue(props.hostedJob?.progress)?.renderLifecycle);
  const offlineRetryScope =
    props.offlineDownloadJob?.scope.kind === 'book'
      ? 'book'
      : (props.offlineDownloadJob?.scope.chapterIds.length ?? 0) > 1
        ? 'nearby'
        : 'current';
  const characterTargets: DisplayVoiceTarget[] = props.characters.map((character) => ({
    role: 'character',
    characterId: character.id,
    label: character.canonicalName,
    color: character.color,
  }));

  return (
    <div className="panel-body tts-addon-body">
      <header className="addon-intro">
        <h3>TTS</h3>
        <p className="muted">시스템 음성과 설정된 provider 음성을 같은 재생 제어로 사용합니다.</p>
      </header>
      <div className="segmented tts-panel-tabs" role="tablist" aria-label="TTS 설정 화면">
        <button
          role="tab"
          aria-selected={panelView === 'playback'}
          aria-controls="tts-playback-panel"
          className={panelView === 'playback' ? 'active' : ''}
          onClick={() => setPanelView('playback')}
        >
          기본 청취
        </button>
        <button
          role="tab"
          aria-selected={panelView === 'advanced'}
          aria-controls="tts-advanced-panel"
          className={panelView === 'advanced' ? 'active' : ''}
          onClick={() => setPanelView('advanced')}
        >
          고급 음성
        </button>
      </div>
      <div className={classNames('addon-status', 'tts-status', props.statusTone)}>
        <div>
          <strong>{statusTitle(props.status)}</strong>
          <span>{props.status?.message ?? '시스템 음성 지원 여부를 확인하고 있습니다.'}</span>
          {props.selectedVoiceMissing && <span>저장된 음성을 찾을 수 없어 자동 선택으로 재생합니다.</span>}
        </div>
        <button
          className="icon-btn"
          onClick={() => void props.refreshStatus()}
          title="TTS 상태 새로고침"
          aria-label="TTS 상태 새로고침"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div id="tts-playback-panel" className="tts-panel-section" role="tabpanel" hidden={panelView !== 'playback'}>
        <div className="tts-controls">
          <button
            className="icon-btn"
            onClick={() => props.jump(-1)}
            disabled={
              (props.unavailable && !props.hostedPlaybackReady) ||
              !props.paragraphCount ||
              (props.paragraphIndex ?? 0) <= 0
            }
            title="이전 문단"
          >
            <SkipBack size={17} />
          </button>
          <button
            className="icon-btn"
            onClick={() => props.jump(1)}
            disabled={
              (props.unavailable && !props.hostedPlaybackReady) ||
              !props.paragraphCount ||
              (props.paragraphIndex ?? 0) >= props.paragraphCount - 1
            }
            title="다음 문단"
          >
            <SkipForward size={17} />
          </button>
          {!props.playing ? (
            <button
              className="primary-btn"
              onClick={() => void props.start()}
              disabled={props.unavailable && !props.hostedPlaybackReady}
            >
              <Play size={18} /> 재생
            </button>
          ) : props.paused ? (
            <button className="primary-btn" onClick={props.resume}>
              <Play size={18} /> 계속
            </button>
          ) : (
            <button className="primary-btn" onClick={props.pause}>
              <Pause size={18} /> 일시정지
            </button>
          )}
          <button className="ghost-btn" onClick={props.stop}>
            <Square size={17} /> 정지
          </button>
          {props.resumeLabel && !props.playing && (
            <button className="ghost-btn" onClick={() => void props.resumeSavedPlayback()}>
              <Play size={17} /> {props.resumeLabel}
            </button>
          )}
        </div>

        <label className="field-label" htmlFor={speedId}>
          재생 속도 {props.speed.toFixed(1)}x
        </label>
        <input
          id={speedId}
          type="range"
          min="0.6"
          max="1.8"
          step="0.1"
          value={props.speed}
          disabled={props.unavailable}
          onChange={(event) => props.changeSpeed(Number(event.target.value))}
        />
        <div className="tts-playback-setting-grid">
          <label>
            <span>피치 {props.playbackSettings.pitch.toFixed(1)}</span>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={props.playbackSettings.pitch}
              disabled={!props.pitchSupported}
              onChange={(event) => props.changePlaybackSettings({ pitch: Number(event.target.value) })}
            />
            {!props.pitchSupported && <small>이 음성에서는 지원하지 않음</small>}
          </label>
          <label>
            <span>볼륨 {Math.round(props.playbackSettings.volume * 100)}%</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={props.playbackSettings.volume}
              onChange={(event) => props.changePlaybackSettings({ volume: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>문장 간격 {props.playbackSettings.sentencePauseMs}ms</span>
            <input
              type="range"
              min="0"
              max="1200"
              step="10"
              value={props.playbackSettings.sentencePauseMs}
              onChange={(event) => props.changePlaybackSettings({ sentencePauseMs: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>문단 간격 {props.playbackSettings.paragraphPauseMs}ms</span>
            <input
              type="range"
              min="0"
              max="2500"
              step="20"
              value={props.playbackSettings.paragraphPauseMs}
              onChange={(event) => props.changePlaybackSettings({ paragraphPauseMs: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>화 간격 {props.playbackSettings.chapterPauseMs}ms</span>
            <input
              type="range"
              min="0"
              max="5000"
              step="100"
              value={props.playbackSettings.chapterPauseMs}
              onChange={(event) => props.changePlaybackSettings({ chapterPauseMs: Number(event.target.value) })}
            />
          </label>
        </div>
        <label className="field-label" htmlFor={chapterEndId}>
          화가 끝나면
        </label>
        <select
          id={chapterEndId}
          value={props.playbackSettings.chapterEndBehavior}
          onChange={(event) =>
            props.changePlaybackSettings({
              chapterEndBehavior: event.target.value === 'continue' ? 'continue' : 'stop',
            })
          }
        >
          <option value="stop">현재 화에서 정지</option>
          <option value="continue">다음 화 계속 재생</option>
        </select>
        <label className="field-label" htmlFor={`${chapterEndId}-footnotes`}>
          EPUB 각주
        </label>
        <select
          id={`${chapterEndId}-footnotes`}
          value={props.playbackSettings.footnotePlayback}
          onChange={(event) =>
            props.changePlaybackSettings({
              footnotePlayback:
                event.target.value === 'skip' || event.target.value === 'immediate'
                  ? event.target.value
                  : 'end_of_chapter',
            })
          }
        >
          <option value="end_of_chapter">화 끝에서 읽기</option>
          <option value="immediate">표식 뒤에 바로 읽기</option>
          <option value="skip">읽지 않기</option>
        </select>
        <label className="field-label" htmlFor={sleepTimerId}>
          기본 수면 타이머
        </label>
        <select
          id={sleepTimerId}
          value={
            props.playbackSettings.sleepTimerDefault === undefined
              ? ''
              : String(props.playbackSettings.sleepTimerDefault)
          }
          onChange={(event) => {
            const value = event.target.value;
            props.changePlaybackSettings({
              sleepTimerDefault:
                value === 'end_of_chapter' ? value : value ? (Number(value) as 10 | 20 | 30 | 60) : undefined,
            });
          }}
        >
          <option value="">사용 안 함</option>
          <option value="10">10분</option>
          <option value="20">20분</option>
          <option value="30">30분</option>
          <option value="60">60분</option>
          <option value="end_of_chapter">현재 화 끝</option>
        </select>
        <fieldset className="tts-skip-types">
          <legend>네트워크 없이 듣기</legend>
          <label>
            <input
              type="checkbox"
              checked={props.playbackSettings.offlineOnly}
              onChange={(event) => props.changePlaybackSettings({ offlineOnly: event.target.checked })}
            />
            준비된 음성만 사용
          </label>
          <small>저장된 provider 음성이 없으면 네트워크 요청 없이 시스템 음성으로 이어서 읽습니다.</small>
        </fieldset>
        <fieldset className="tts-skip-types">
          <legend>읽지 않을 내용</legend>
          {(
            [
              ['author_note', '작가의 말'],
              ['system_message', '시스템 문구'],
              ['sfx', '효과음'],
            ] as const
          ).map(([type, label]) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={props.playbackSettings.skippedContentTypes.includes(type)}
                onChange={(event) =>
                  props.changePlaybackSettings({
                    skippedContentTypes: event.target.checked
                      ? [...props.playbackSettings.skippedContentTypes, type]
                      : props.playbackSettings.skippedContentTypes.filter((item) => item !== type),
                  })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="voice-profile-section pronunciation-section">
          <div className="setting-line">
            <h4>문구 건너뛰기</h4>
            <span>원문은 변경하지 않음</span>
          </div>
          <div className="pronunciation-editor">
            <select value={skipKind} onChange={(event) => setSkipKind(event.target.value as typeof skipKind)}>
              <option value="skip_prefix">이 문구로 시작</option>
              <option value="skip_suffix">이 문구로 끝남</option>
              <option value="skip_line">문장 전체 일치</option>
            </select>
            <input
              className="text-input"
              value={skipPattern}
              placeholder="예: [작가의 말]"
              onChange={(event) => setSkipPattern(event.target.value)}
            />
            <button
              className="primary-btn"
              disabled={!skipPattern.trim()}
              onClick={() => {
                void props.saveSpokenTextSkipRule(skipPattern, skipKind);
                setSkipPattern('');
              }}
            >
              <Check size={15} /> 추가
            </button>
          </div>
          <div className="pronunciation-list">
            {props.spokenTextRules
              .filter((rule) => rule.kind !== 'replace_literal')
              .map((rule) => (
                <div key={rule.id}>
                  <span>
                    <strong>{rule.pattern}</strong> ·{' '}
                    {rule.kind === 'skip_prefix' ? '시작 문구' : rule.kind === 'skip_suffix' ? '끝 문구' : '전체 일치'}
                  </span>
                  <button
                    className="icon-btn"
                    title="건너뛰기 규칙 삭제"
                    aria-label={`${rule.pattern} 건너뛰기 규칙 삭제`}
                    onClick={() => void props.deleteSpokenTextSkipRule(rule.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
          </div>
        </div>
        <div className="setting-line tts-book-override">
          <label>
            <input
              type="checkbox"
              checked={props.bookOverrideEnabled}
              onChange={(event) => props.setBookOverrideEnabled(event.target.checked)}
            />
            이 책에만 적용
          </label>
          {props.bookOverrideEnabled && (
            <button className="ghost-btn" onClick={props.resetBookOverride}>
              책 설정 초기화
            </button>
          )}
        </div>
        <label className="field-label" htmlFor={systemVoiceId}>
          음성
        </label>
        <select
          id={systemVoiceId}
          value={props.selectedSystemVoiceId ?? ''}
          disabled={props.voices.length === 0}
          onChange={(event) => props.changeSystemVoice(event.target.value || undefined)}
        >
          {props.selectedVoiceMissing && <option value={props.selectedSystemVoiceId}>저장된 음성 없음</option>}
          <option value="">자동 선택</option>
          {props.voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.label}
            </option>
          ))}
        </select>
        {props.paragraphIndex !== undefined && (
          <p className="muted">
            현재 문단 {props.paragraphIndex + 1} / {props.paragraphCount}
          </p>
        )}
        {props.activePlayback && (
          <p className="muted">
            TTS focus: {props.activePlayback.speakerLabel} · {props.activePlayback.segmentIds.length || 1} segment
          </p>
        )}
      </div>

      <div id="tts-advanced-panel" className="tts-panel-section" role="tabpanel" hidden={panelView !== 'advanced'}>
        <div className="voice-profile-section spoken-preview-section">
          <div className="setting-line">
            <h4>읽기 미리보기</h4>
            <span>저장하지 않음</span>
          </div>
          <textarea
            className="text-input"
            value={spokenPreviewSource}
            rows={3}
            aria-label="읽기 미리보기 원문"
            onChange={(event) => setSpokenPreviewSource(event.target.value)}
          />
          <div className="spoken-preview-grid">
            <div>
              <span>원문</span>
              <p>{spokenPreviewSource || '—'}</p>
            </div>
            <div>
              <span>실제로 읽는 문장</span>
              <p>{spokenPreview.spokenText || '이 문장은 건너뜁니다.'}</p>
            </div>
          </div>
          {spokenPreview.skipped.length > 0 && (
            <small>{formatCount(spokenPreview.skipped.length)}개 구간이 건너뛰기 규칙으로 제외됩니다.</small>
          )}
          <div className="spoken-preview-actions">
            <button
              className="ghost-btn compact"
              disabled={!spokenPreviewPattern || spokenPreviewAlreadySkipped}
              aria-label={spokenPreviewAlreadySkipped ? '이미 등록된 건너뛰기 문장' : '이 문장 TTS에서 건너뛰기'}
              onClick={() => void props.saveSpokenTextSkipRule(spokenPreviewPattern, 'skip_line')}
            >
              <Check size={14} /> {spokenPreviewAlreadySkipped ? '이미 건너뜀' : '이 문장 건너뛰기'}
            </button>
            <small>현재 책의 원문 전체가 일치할 때만 건너뜁니다.</small>
          </div>
          <div className="spoken-rule-impact" aria-live="polite">
            <div className="setting-line">
              <div>
                <strong>책 전체 영향</strong>
                <small>저장된 건너뛰기 규칙만 검사하며 음성 합성은 실행하지 않습니다.</small>
              </div>
              <button
                className="ghost-btn compact"
                disabled={!hasActiveSkipRules || spokenRuleImpactBusy}
                aria-label="책 전체 건너뛰기 영향 확인"
                onClick={() => void inspectSpokenRuleImpact()}
              >
                {spokenRuleImpactBusy ? '확인 중…' : '영향 확인'}
              </button>
            </div>
            {!hasActiveSkipRules && <small>활성 건너뛰기 규칙이 없습니다.</small>}
            {spokenRuleImpactError && <small className="error-text">{spokenRuleImpactError}</small>}
            {spokenRuleImpact && (
              <div className="spoken-rule-impact-result">
                <strong>
                  {formatCount(spokenRuleImpact.scannedParagraphCount)}개 문단 중{' '}
                  {formatCount(spokenRuleImpact.affectedParagraphCount)}개 영향
                </strong>
                <small>
                  완전 생략 {formatCount(spokenRuleImpact.fullySkippedParagraphCount)}개 · 제외 구간{' '}
                  {formatCount(spokenRuleImpact.skippedRangeCount)}개
                </small>
                {spokenRuleImpact.samples.length > 0 && (
                  <ul>
                    {spokenRuleImpact.samples.map((sample) => (
                      <li key={`${sample.chapterTitle}:${sample.paragraphIndex}:${sample.source}`}>
                        <span>
                          {sample.chapterTitle} · {sample.paragraphIndex + 1}번째 문단
                        </span>
                        <p>{sample.source}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="voice-profile-section">
          <div className="setting-line">
            <h4>캐릭터별 음성</h4>
            <span>{formatCount(systemProfiles.length)}개 지정</span>
          </div>
          <div className="voice-profile-list">
            {[...ROLE_TARGETS, ...characterTargets].map((target) => {
              const profile = systemProfiles.find((candidate) => profileMatchesTarget(candidate, target));
              return (
                <label key={`${target.role}-${target.characterId ?? 'default'}`} className="voice-profile-row">
                  <span>
                    {target.color ? <i style={{ background: target.color }} /> : null}
                    {target.label}
                  </span>
                  <select
                    value={profile?.providerVoiceId ?? ''}
                    disabled={props.voices.length === 0}
                    onChange={(event) => void props.saveSystemVoice(target, event.target.value)}
                  >
                    <option value="">기본 음성</option>
                    {props.voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            {props.characters.length === 0 && (
              <p className="muted">화자 라벨링 후 캐릭터별 음성을 지정할 수 있습니다.</p>
            )}
          </div>
        </div>

        <div className="voice-profile-section voice-approval-section">
          <div className="setting-line">
            <h4>음성 초안과 승인</h4>
            <span>
              주요 {props.voiceProductSummary.approved}/{props.voiceProductSummary.major}
              {props.voiceProductSummary.stale ? ` · 재검토 ${props.voiceProductSummary.stale}` : ''}
            </span>
          </div>
          <div className="voice-product-actions">
            <button
              className="ghost-btn"
              disabled={props.voiceProductBusy || props.voices.length === 0}
              onClick={() => void props.generateVoiceDraft('system')}
            >
              <Wand2 size={16} /> 시스템 음성 초안
            </button>
            <button
              className="ghost-btn"
              disabled={
                props.voiceProductBusy || !props.selectedHostedProvider || props.selectedHostedVoices.length === 0
              }
              onClick={() => void props.generateVoiceDraft('hosted')}
            >
              <Wand2 size={16} /> Hosted 음성 초안
            </button>
          </div>
          <p className="muted">
            자동 초안은 직접 고른 음성을 유지합니다. 주요 음성은 샘플 승인 전 책 전체 캐시에 사용되지 않습니다.
          </p>
          {props.voiceCastingSummary && (
            <p
              className={
                props.voiceCastingSummary.reviews || props.voiceCastingSummary.stale ? 'muted warning' : 'muted'
              }
            >
              {props.voiceCastingSummary.stale && '설정 변경 후 재배정 필요 · '}
              작품 전체 배정 {formatCount(props.voiceCastingSummary.assigned)} · 검토{' '}
              {formatCount(props.voiceCastingSummary.reviews)} · 미배정{' '}
              {formatCount(props.voiceCastingSummary.unresolved)}
            </p>
          )}
          <div className="voice-cost-summary">
            <label>
              주요 캐릭터
              <input
                type="number"
                min="1"
                max="50"
                value={props.voiceProductState?.majorCharacterLimit ?? 5}
                onChange={(event) => void props.setMajorCharacterLimit(Number(event.target.value))}
              />
            </label>
            <span>
              샘플{' '}
              {formatCount(
                (props.voiceProductState?.sampleRequests ?? []).reduce(
                  (sum, item) => sum + item.estimatedCharacters,
                  0,
                ),
              )}
              자 · 책 전체 {formatCount(props.bookCharacterCount)}자
            </span>
            <small>정확한 예상 요금은 provider가 가격 정보를 제공할 때 표시됩니다.</small>
          </div>
          <div className="voice-approval-list">
            {(props.voiceProductState?.suggestions ?? [])
              .filter((suggestion) => suggestion.major)
              .map((suggestion) => {
                const profile = props.voiceProfiles.find((item) => item.id === suggestion.voiceProfileId);
                if (!profile) return null;
                const approval = props.voiceProductState
                  ? voiceApprovalForProfile(props.voiceProductState, profile)
                  : undefined;
                const status = approval?.staleReason
                  ? '재검토 필요'
                  : approval?.decision === 'approved'
                    ? '승인됨'
                    : approval?.decision === 'rejected'
                      ? '제외됨'
                      : '샘플 필요';
                return (
                  <div className="voice-approval-item" key={suggestion.id}>
                    <div>
                      <strong>{profile.label}</strong>
                      <small>
                        {suggestion.metadataLimitations.length
                          ? '특성 미확인 · 샘플 비교 권장'
                          : 'Provider metadata 확인됨'}
                      </small>
                    </div>
                    <span
                      className={approval?.staleReason ? 'warning' : approval?.decision === 'approved' ? 'ready' : ''}
                    >
                      {status}
                    </span>
                    <div className="voice-approval-actions">
                      <button
                        className="icon-btn"
                        title="중립 샘플"
                        aria-label={`${profile.label} 중립 샘플`}
                        disabled={props.voiceSampleBusyProfileId === profile.id}
                        onClick={() => void props.playVoiceSample(profile, 'neutral')}
                      >
                        <Play size={15} />
                      </button>
                      <button
                        className="ghost-btn compact"
                        disabled={props.voiceSampleBusyProfileId === profile.id}
                        onClick={() => void props.playVoiceSample(profile, 'in_context')}
                      >
                        문맥 샘플
                      </button>
                      <button
                        className="icon-btn"
                        title="승인"
                        aria-label={`${profile.label} 승인`}
                        disabled={props.voiceProductBusy}
                        onClick={() => void props.decideVoice(profile, 'approved')}
                      >
                        <Check size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        title="제외"
                        aria-label={`${profile.label} 제외`}
                        disabled={props.voiceProductBusy}
                        onClick={() => void props.decideVoice(profile, 'rejected')}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            {(props.voiceProductState?.suggestions ?? []).filter((item) => item.major).length === 0 && (
              <p className="muted">음성 목록을 불러온 뒤 자동 초안을 생성하세요.</p>
            )}
          </div>
          <label className="setting-check">
            <input
              type="checkbox"
              checked={props.voiceProductState?.minorFallbackEnabled ?? false}
              onChange={(event) => void props.setMinorFallbackEnabled(event.target.checked)}
            />
            <span>비주요 캐릭터에 fallback 음성 허용</span>
          </label>
        </div>

        {(props.voicePoolViews.system || props.voicePoolViews.hosted) && (
          <div className="voice-profile-section voice-pool-section">
            <div className="setting-line">
              <h4>공유 음성 풀</h4>
              <span>단역 자동 배정</span>
            </div>
            {props.voicePoolViews.system && (
              <VoicePoolEditor
                scope="system"
                label="시스템 음성"
                view={props.voicePoolViews.system}
                busy={props.voiceProductBusy}
                sampleBusyProfileId={props.voiceSampleBusyProfileId}
                onSave={props.saveVoicePool}
                onSample={props.playVoiceSample}
              />
            )}
            {props.voicePoolViews.hosted && (
              <VoicePoolEditor
                scope="hosted"
                label={props.selectedHostedProviderLabel}
                view={props.voicePoolViews.hosted}
                busy={props.voiceProductBusy}
                sampleBusyProfileId={props.voiceSampleBusyProfileId}
                onSave={props.saveVoicePool}
                onSample={props.playVoiceSample}
              />
            )}
          </div>
        )}

        <div className="voice-profile-section pronunciation-section">
          <div className="setting-line">
            <h4>발음 사전</h4>
            <span>revision {props.voiceProductState?.pronunciationProfile.revision ?? 0}</span>
          </div>
          <div className="pronunciation-editor">
            <input
              className="text-input"
              value={pronunciationSource}
              placeholder="원문 표기"
              onChange={(event) => setPronunciationSource(event.target.value)}
            />
            <input
              className="text-input"
              value={pronunciationReplacement}
              placeholder="읽을 발음"
              onChange={(event) => setPronunciationReplacement(event.target.value)}
            />
            <button
              className="primary-btn"
              disabled={!pronunciationSource.trim() || !pronunciationReplacement.trim() || props.voiceProductBusy}
              onClick={() => {
                void props.savePronunciationRule({
                  sourceTerm: pronunciationSource,
                  replacement: pronunciationReplacement,
                  mode: 'literal',
                });
                setPronunciationSource('');
                setPronunciationReplacement('');
              }}
            >
              <Check size={15} /> 저장
            </button>
          </div>
          <div className="pronunciation-list">
            {(props.voiceProductState?.pronunciationProfile.rules ?? []).map((rule) => (
              <div key={rule.id}>
                <span>
                  <strong>{rule.sourceTerm}</strong> → {rule.replacement}
                </span>
                <button
                  className="icon-btn"
                  title="발음 규칙 삭제"
                  aria-label={`${rule.sourceTerm} 발음 규칙 삭제`}
                  onClick={() => void props.deletePronunciationRule(rule.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="voice-profile-section hosted-voice-section">
          <div className="setting-line">
            <h4>Hosted 캐릭터 음성</h4>
            <span>{props.hostedPlaybackReady ? props.selectedHostedProviderLabel : '대기'}</span>
          </div>
          <div className="addon-status">
            <span>{props.hostedBusy ? 'Cache 작업 중' : 'Cache 재생'}</span>
            <strong>
              {props.hostedPlaybackReady
                ? `${formatCount(hostedProfiles.length)}개 지정`
                : props.selectedHostedProvider
                  ? '음성 ID 필요'
                  : 'provider 미선택'}
            </strong>
          </div>
          {props.offlineDownloadPolicy && (
            <fieldset className="tts-skip-types">
              <legend>Android 백그라운드 재개 조건</legend>
              <label>
                <input
                  type="checkbox"
                  aria-label="무제한 네트워크에서만 백그라운드 재개"
                  checked={props.offlineDownloadPolicy.network === 'unmetered'}
                  onChange={(event) =>
                    props.changeOfflineDownloadPolicy({ network: event.target.checked ? 'unmetered' : 'any' })
                  }
                />
                무제한 네트워크에서만 재개
              </label>
              <label>
                <input
                  type="checkbox"
                  aria-label="충전 중에만 백그라운드 재개"
                  checked={props.offlineDownloadPolicy.charging === 'required'}
                  onChange={(event) =>
                    props.changeOfflineDownloadPolicy({ charging: event.target.checked ? 'required' : 'any' })
                  }
                />
                충전 중에만 재개
              </label>
              <small>앱이 종료된 뒤 남은 음성을 복구할 때만 적용됩니다. 현재 화면의 준비 작업은 바로 시작합니다.</small>
            </fieldset>
          )}
          <button
            className="ghost-btn wide"
            onClick={() =>
              props.selectedHostedProvider && void props.refreshHostedVoices(props.selectedHostedProvider.providerId)
            }
            disabled={
              !props.selectedHostedProvider ||
              props.hostedVoicesLoadingProvider === props.selectedHostedProvider?.providerId
            }
          >
            <RefreshCw size={16} /> Hosted 음성 새로고침
          </button>
          {(['current', 'nearby', 'book'] as const).map((scope) => (
            <button
              key={scope}
              className="ghost-btn wide"
              onClick={() => void props.warmup(scope)}
              disabled={props.hostedWarmupDisabled}
            >
              <RefreshCw size={16} />{' '}
              {scope === 'current' ? '현재 화' : scope === 'nearby' ? '현재+다음 2화' : '책 전체'} 캐시 준비
            </button>
          ))}
          {props.offlineDownloadJob && (
            <div className="provider-job-card" aria-label="최근 오프라인 TTS 준비 작업">
              <strong>
                오프라인 음성 {props.offlineDownloadJob.readyItems}/{props.offlineDownloadJob.plannedItems}
              </strong>
              <span>
                {props.offlineDownloadJob.state === 'completed'
                  ? '준비 완료'
                  : `실패 ${props.offlineDownloadJob.failedItems} · 준비된 항목은 그대로 유지`}
              </span>
              {props.offlineDownloadError && <small>{props.offlineDownloadError}</small>}
              {(props.offlineDownloadJob.state === 'partial' || props.offlineDownloadJob.state === 'failed') && (
                <button
                  className="ghost-btn wide"
                  aria-label="실패한 오프라인 음성 다시 준비"
                  disabled={props.hostedWarmupDisabled}
                  onClick={() => void props.warmup(offlineRetryScope)}
                >
                  <RefreshCw size={16} /> 실패 항목 다시 준비
                </button>
              )}
            </div>
          )}
          {props.hostedOfflineCacheStatus && (
            <div className="provider-job-card" aria-label="브라우저 오프라인 음성 저장소">
              <strong>브라우저 오프라인 저장소</strong>
              <span>
                이 책 {props.hostedOfflineCacheStatus.itemCount}개 ·{' '}
                {formatBytes(props.hostedOfflineCacheStatus.byteSize)}
              </span>
              {props.hostedOfflineCacheStatus.originUsage !== undefined &&
                props.hostedOfflineCacheStatus.originQuota !== undefined && (
                  <small>
                    앱 전체 {formatBytes(props.hostedOfflineCacheStatus.originUsage)} /{' '}
                    {formatBytes(props.hostedOfflineCacheStatus.originQuota)}
                  </small>
                )}
              <small>
                {props.hostedOfflineCacheStatus.persisted
                  ? '브라우저의 자동 저장소 정리에서 보호됩니다.'
                  : '저장 공간이 부족하면 브라우저가 정리할 수 있습니다.'}
              </small>
              {props.hostedOfflineCacheStatus.staleItemCount > 0 && (
                <button
                  className="ghost-btn wide"
                  aria-label="이전 본문 버전의 오프라인 음성 정리"
                  onClick={() => void props.removeStaleHostedOfflineAudio()}
                >
                  <Trash2 size={16} /> 이전 본문 음성 {props.hostedOfflineCacheStatus.staleItemCount}개 정리 ·{' '}
                  {formatBytes(props.hostedOfflineCacheStatus.staleByteSize)}
                </button>
              )}
              {props.hostedOfflineCacheStatus.protectedStaleItemCount > 0 && (
                <small>
                  수동 보관 중인 이전 음성 {props.hostedOfflineCacheStatus.protectedStaleItemCount}개는 유지됩니다.
                </small>
              )}
              {props.hostedOfflineCacheStatus.persistenceSupported && !props.hostedOfflineCacheStatus.persisted && (
                <button
                  className="ghost-btn wide"
                  aria-label="오프라인 음성 저장소 보호 요청"
                  onClick={() => void props.requestHostedOfflineStorage()}
                >
                  <Check size={16} /> 저장소 보호 요청
                </button>
              )}
            </div>
          )}
          {props.hostedStatus && (
            <div className="provider-job-card">
              <strong>{props.hostedStatus}</strong>
              <span>
                {props.hostedJob
                  ? `${props.hostedJob.providerId}${props.hostedJob.modelId ? ` · ${props.hostedJob.modelId}` : ''}`
                  : props.selectedHostedProviderLabel}
              </span>
              {props.hostedJob?.errorMessage && <small>{props.hostedJob.errorMessage}</small>}
            </div>
          )}
          {hostedLifecycle && (
            <div className="tts-lifecycle-summary">
              <strong>오디오 {String(hostedLifecycle.state ?? 'planned')}</strong>
              <span>
                완료 {lifecycleCount(hostedLifecycle.succeeded) + lifecycleCount(hostedLifecycle.cacheHit)} · 실행{' '}
                {lifecycleCount(hostedLifecycle.running)} · 대기 {lifecycleCount(hostedLifecycle.queued)} · 실패{' '}
                {lifecycleCount(hostedLifecycle.failed) + lifecycleCount(hostedLifecycle.corrupt)}
              </span>
            </div>
          )}
          <div className="voice-profile-list">
            {[...ROLE_TARGETS, ...characterTargets].map((target) => (
              <HostedVoiceRow
                key={`hosted-${target.role}-${target.characterId ?? 'default'}`}
                target={target}
                profile={hostedProfiles.find((candidate) => profileMatchesTarget(candidate, target))}
                provider={props.selectedHostedProvider}
                voices={props.selectedHostedVoices}
                defaultVoiceId={defaultVoiceId}
                options={hostedOptions}
                onSave={props.saveHostedVoice}
                onSaveOption={props.saveHostedVoiceOption}
              />
            ))}
            {props.characters.length === 0 && (
              <p className="muted">라벨링 후 등장인물별 hosted 음성을 지정할 수 있습니다.</p>
            )}
          </div>
        </div>

        <ProviderSettingsPanel
          scope="tts_synthesis"
          title="TTS provider"
          providers={props.providers}
          draft={props.providerDraft}
          controller={props.providerController}
        />
      </div>
    </div>
  );
}
