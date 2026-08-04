import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import TTSAddonPanel, { type TTSAddonPanelProps } from './TTSAddonPanel';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';

function props(): TTSAddonPanelProps {
  const action = vi.fn();
  return {
    statusTone: 'ready',
    selectedVoiceMissing: false,
    unavailable: false,
    hostedPlaybackReady: false,
    paragraphCount: 10,
    paragraphIndex: 2,
    playing: false,
    paused: false,
    speed: 1,
    playbackSettings: DEFAULT_TTS_PLAYBACK_SETTINGS,
    bookOverrideEnabled: false,
    pitchSupported: true,
    voices: [],
    characters: [],
    voiceProfiles: [],
    selectedHostedProviderLabel: '선택 안 됨',
    selectedHostedVoices: [],
    hostedBusy: false,
    hostedWarmupDisabled: true,
    offlineDownloadJob: undefined,
    offlineDownloadError: undefined,
    offlineDownloadPolicy: undefined,
    hostedOfflineCacheStatus: undefined,
    providers: [],
    providerController: {
      available: false,
      loading: false,
      secretStatuses: [],
      secretDrafts: {},
      desktopMode: false,
      analysisRunning: false,
      hostedTTSBusy: false,
      updateDraft: action,
      updateSecretDraft: action,
      refresh: action,
      saveSettings: action,
      saveSecret: action,
      deleteSecret: action,
      testSecret: action,
      runDesktopLLMSample: action,
      playDesktopTTSSample: action,
    },
    voiceProductBusy: false,
    voiceProductSummary: { major: 0, approved: 0, stale: 0 },
    spokenTextRules: [],
    voicePoolViews: {},
    bookCharacterCount: 0,
    refreshStatus: action,
    jump: action,
    start: action,
    resume: action,
    pause: action,
    stop: action,
    changeSpeed: action,
    changePlaybackSettings: action,
    setBookOverrideEnabled: action,
    resetBookOverride: action,
    resumeSavedPlayback: action,
    changeSystemVoice: action,
    saveSystemVoice: action,
    saveHostedVoice: action,
    saveHostedVoiceOption: action,
    refreshHostedVoices: action,
    warmup: action,
    changeOfflineDownloadPolicy: action,
    requestHostedOfflineStorage: action,
    removeStaleHostedOfflineAudio: action,
    generateVoiceDraft: action,
    saveVoicePool: action,
    playVoiceSample: action,
    decideVoice: action,
    savePronunciationRule: action,
    deletePronunciationRule: action,
    saveSpokenTextSkipRule: action,
    deleteSpokenTextSkipRule: action,
    previewSpokenTextRuleImpact: async () => ({
      scannedParagraphCount: 0,
      affectedParagraphCount: 0,
      fullySkippedParagraphCount: 0,
      skippedRangeCount: 0,
      samples: [],
    }),
    setMinorFallbackEnabled: action,
    setMajorCharacterLimit: action,
  };
}

describe('TTSAddonPanel', () => {
  it('keeps playback controls separate from advanced voice setup', () => {
    const renderer = create(<TTSAddonPanel {...props()} />);
    const playbackPanel = renderer.root.findByProps({ id: 'tts-playback-panel' });
    const advancedPanel = renderer.root.findByProps({ id: 'tts-advanced-panel' });
    const tabs = renderer.root.findAllByProps({ role: 'tab' });

    expect(playbackPanel.props.hidden).toBe(false);
    expect(advancedPanel.props.hidden).toBe(true);
    expect(tabs[0].props['aria-selected']).toBe(true);

    act(() => tabs[1].props.onClick());

    expect(renderer.root.findByProps({ id: 'tts-playback-panel' }).props.hidden).toBe(true);
    expect(renderer.root.findByProps({ id: 'tts-advanced-panel' }).props.hidden).toBe(false);
    expect(renderer.root.findAllByProps({ role: 'tab' })[1].props['aria-selected']).toBe(true);
  });

  it('retries a partial offline job with its original nearby scope', () => {
    const warmup = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        hostedWarmupDisabled={false}
        warmup={warmup}
        offlineDownloadJob={{
          id: 'download-1',
          bookId: 'book-1',
          contentRevisionId: 'revision-1',
          scope: { kind: 'chapter', chapterIds: ['chapter-1', 'chapter-2'] },
          state: 'partial',
          plannedItems: 10,
          readyItems: 8,
          failedItems: 2,
          byteSize: 1_024,
          policy: { network: 'any', charging: 'any', retryLimit: 3, retainUntil: 'space_needed' },
          updatedAt: '2026-08-01T00:00:00.000Z',
        }}
      />,
    );
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    act(() => renderer.root.findByProps({ 'aria-label': '실패한 오프라인 음성 다시 준비' }).props.onClick());
    expect(warmup).toHaveBeenCalledWith('nearby');
  });

  it('changes Android headless recovery constraints without delaying foreground work', () => {
    const changeOfflineDownloadPolicy = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        offlineDownloadPolicy={{ network: 'unmetered', charging: 'any' }}
        changeOfflineDownloadPolicy={changeOfflineDownloadPolicy}
      />,
    );
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    act(() =>
      renderer.root
        .findByProps({ 'aria-label': '무제한 네트워크에서만 백그라운드 재개' })
        .props.onChange({ target: { checked: false } }),
    );
    act(() =>
      renderer.root
        .findByProps({ 'aria-label': '충전 중에만 백그라운드 재개' })
        .props.onChange({ target: { checked: true } }),
    );
    expect(changeOfflineDownloadPolicy).toHaveBeenNthCalledWith(1, { network: 'any' });
    expect(changeOfflineDownloadPolicy).toHaveBeenNthCalledWith(2, { charging: 'required' });
  });

  it('requests browser storage protection only from the explicit user action', () => {
    const requestHostedOfflineStorage = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        hostedOfflineCacheStatus={{
          itemCount: 3,
          byteSize: 4_096,
          staleItemCount: 0,
          staleByteSize: 0,
          protectedStaleItemCount: 0,
          originUsage: 8_192,
          originQuota: 16_384,
          persisted: false,
          persistenceSupported: true,
        }}
        requestHostedOfflineStorage={requestHostedOfflineStorage}
      />,
    );
    expect(requestHostedOfflineStorage).not.toHaveBeenCalled();
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    act(() => renderer.root.findByProps({ 'aria-label': '오프라인 음성 저장소 보호 요청' }).props.onClick());
    expect(requestHostedOfflineStorage).toHaveBeenCalledOnce();
  });

  it('cleans only cache reported as belonging to an older content revision', () => {
    const removeStaleHostedOfflineAudio = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        hostedOfflineCacheStatus={{
          itemCount: 5,
          byteSize: 12_288,
          staleItemCount: 2,
          staleByteSize: 4_096,
          protectedStaleItemCount: 1,
          persisted: true,
          persistenceSupported: true,
        }}
        removeStaleHostedOfflineAudio={removeStaleHostedOfflineAudio}
      />,
    );
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    act(() => renderer.root.findByProps({ 'aria-label': '이전 본문 버전의 오프라인 음성 정리' }).props.onClick());
    expect(removeStaleHostedOfflineAudio).toHaveBeenCalledOnce();
    expect(
      renderer.root
        .findAllByType('small')
        .some((node) => node.children.join('') === '수동 보관 중인 이전 음성 1개는 유지됩니다.'),
    ).toBe(true);
  });

  it('lets the user pin discovered shared voices without leaving advanced TTS settings', () => {
    const saveVoicePool = vi.fn();
    const base = props();
    const profiles = ['pool-a', 'pool-b'].map((id, index) => ({
      id,
      novelId: 'book-1',
      role: 'character' as const,
      providerId: 'system',
      providerVoiceId: `voice-${index + 1}`,
      label: `Pool ${index + 1}`,
      speed: 1,
      isUserSelected: false,
    }));
    const renderer = create(
      <TTSAddonPanel
        {...base}
        voiceProfiles={profiles}
        voicePoolViews={{
          system: {
            providerId: 'system',
            userPinned: false,
            options: profiles.map((profile) => ({
              profile,
              voice: { id: profile.providerVoiceId, label: profile.label, lang: 'ko-KR' },
              selected: true,
            })),
          },
        }}
        saveVoicePool={saveVoicePool}
      />,
    );
    const advancedTab = renderer.root.findAllByProps({ role: 'tab' })[1];
    act(() => advancedTab.props.onClick());
    const poolOptions = renderer.root.findAllByProps({ className: 'voice-pool-option' });

    expect(poolOptions).toHaveLength(2);
    act(() => poolOptions[0]!.findByType('input').props.onChange());
    expect(saveVoicePool).toHaveBeenCalledWith('system', ['pool-b'], true);
  });

  it('shows that synced voice settings need a fresh assignment before playback', () => {
    const renderer = create(
      <TTSAddonPanel {...props()} voiceCastingSummary={{ assigned: 3, reviews: 0, unresolved: 0, stale: true }} />,
    );
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());

    expect(JSON.stringify(renderer.toJSON())).toContain('설정 변경 후 재배정 필요');
  });

  it('previews the normalized spoken sentence without saving the sample', () => {
    const renderer = create(<TTSAddonPanel {...props()} />);
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    const input = renderer.root.findByProps({ 'aria-label': '읽기 미리보기 원문' });
    act(() => input.props.onChange({ target: { value: '2026-08-01 12:30' } }));

    const output = JSON.stringify(renderer.toJSON());
    expect(output).toContain('실제로 읽는 문장');
    expect(output).toContain('이천이십육년 팔월 일일');
    expect(output).toContain('십이시 삼십분');
  });

  it('saves the preview source as an exact book skip rule', () => {
    const saveSpokenTextSkipRule = vi.fn();
    const renderer = create(<TTSAddonPanel {...props()} saveSpokenTextSkipRule={saveSpokenTextSkipRule} />);
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    act(() =>
      renderer.root
        .findByProps({ 'aria-label': '읽기 미리보기 원문' })
        .props.onChange({ target: { value: '  [작가의 말] 다음 화에서 계속  ' } }),
    );
    act(() => renderer.root.findByProps({ 'aria-label': '이 문장 TTS에서 건너뛰기' }).props.onClick());

    expect(saveSpokenTextSkipRule).toHaveBeenCalledWith('[작가의 말] 다음 화에서 계속', 'skip_line');
  });

  it('does not offer a duplicate exact skip rule from the spoken preview', () => {
    const base = props();
    const renderer = create(
      <TTSAddonPanel
        {...base}
        spokenTextRules={[
          {
            id: 'skip-preview',
            scope: 'book',
            bookId: 'book-1',
            kind: 'skip_line',
            pattern: '2026-08-01 12:30, API 문서를 확인했다.',
            enabled: true,
            priority: 0,
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ]}
      />,
    );
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());

    expect(renderer.root.findByProps({ 'aria-label': '이미 등록된 건너뛰기 문장' }).props.disabled).toBe(true);
  });

  it('shows a bounded whole-book impact summary for active skip rules', async () => {
    const previewSpokenTextRuleImpact = vi.fn(async () => ({
      scannedParagraphCount: 120,
      affectedParagraphCount: 4,
      fullySkippedParagraphCount: 3,
      skippedRangeCount: 4,
      samples: [{ chapterTitle: '3화', paragraphIndex: 7, source: '[작가의 말] 다음 화에서 계속' }],
    }));
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        spokenTextRules={[
          {
            id: 'skip-author-note',
            scope: 'book',
            bookId: 'book-1',
            kind: 'skip_prefix',
            pattern: '[작가의 말]',
            enabled: true,
            priority: 0,
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ]}
        previewSpokenTextRuleImpact={previewSpokenTextRuleImpact}
      />,
    );
    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '책 전체 건너뛰기 영향 확인' }).props.onClick();
    });

    const output = JSON.stringify(renderer.toJSON());
    expect(previewSpokenTextRuleImpact).toHaveBeenCalledOnce();
    expect(output).toContain('120');
    expect(output).toContain('개 문단 중');
    expect(output).toContain('개 영향');
    expect(output).toContain('3화');
    expect(output).toContain('[작가의 말] 다음 화에서 계속');
  });

  it('opens the advanced spoken preview with text selected in the reader', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TTSAddonPanel {...props()} spokenPreviewRequest={{ id: 1, text: '  선택한 원문 문장  ' }} />);
    });

    expect(renderer.root.findByProps({ id: 'tts-playback-panel' }).props.hidden).toBe(true);
    expect(renderer.root.findByProps({ id: 'tts-advanced-panel' }).props.hidden).toBe(false);
    expect(renderer.root.findByProps({ 'aria-label': '읽기 미리보기 원문' }).props.value).toBe('선택한 원문 문장');
  });
});
