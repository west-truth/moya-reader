import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlatformRuntimeKind } from '../../platform/runtime';
import { BrowserAudioSession } from '../../providers/browser-audio-session';
import {
  defaultProviderSecretName,
  desktopProviderCatalog,
  loadDesktopLocalProviderSettings,
  providerCatalogForScope,
  providerSecretDisplayLabel,
  providerSecretDraftKey,
  providerSettingsForScope,
  replaceProviderSettingsInBundle,
  replaceSecretStatus,
  saveDesktopLocalProviderSettings,
} from '../../providers/desktop-provider-catalog';
import type { ProviderControlClient } from '../../providers/provider-control-client';
import type { ProviderCatalogItem, ProviderSecretStatus } from '../../providers/provider-jobs';
import {
  buildProviderSettingsSaveInput,
  createProviderSettingsDraft,
  type ProviderSettingsDraft,
} from '../../providers/provider-settings-ui';
import type { TTSVoice } from '../../providers/tts';
import type {
  RemoteApiClient,
  RemoteProviderCatalog,
  RemoteProviderSettings,
  RemoteProviderSettingsBundle,
} from '../../services/remote/remote-api-client';
import type { ProviderSettingsPanelController } from './ProviderSettingsPanel';
import { createProviderControllerInitialState } from './provider-sample-format';

type Scope = RemoteProviderSettings['scope'];
type NoticeTone = 'success' | 'warning' | 'info' | 'danger';
const SAMPLE_TEXT = '안녕하세요. 모야 TTS 샘플입니다.';

function providerSampleInputMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'provider_sample_input') return;
  return error instanceof Error ? error.message : undefined;
}

export interface ProviderSettingsControllerInput {
  readonly apiClient?: RemoteApiClient;
  readonly controlClient?: ProviderControlClient;
  readonly desktopMode: boolean;
  readonly platformKind: PlatformRuntimeKind;
  readonly analysisRunning: boolean;
  readonly ttsPlaybackBusy: boolean;
  readonly notify: (message: string, tone: NoticeTone) => void;
}

export function useProviderSettingsController(input: ProviderSettingsControllerInput) {
  const initial = createProviderControllerInitialState(input.desktopMode, input.platformKind);
  const [bundle, setBundle] = useState<RemoteProviderSettingsBundle | undefined>(initial.bundle);
  const [catalog, setCatalog] = useState<RemoteProviderCatalog | undefined>(initial.catalog);
  const [drafts, setDrafts] = useState<Partial<Record<Scope, ProviderSettingsDraft>>>(initial.drafts);
  const [secretStatuses, setSecretStatuses] = useState<ProviderSecretStatus[]>([]);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretBusyKey, setSecretBusyKey] = useState<string>();
  const [voicesByProvider, setVoicesByProvider] = useState<Record<string, TTSVoice[]>>({});
  const [voicesLoadingProvider, setVoicesLoadingProvider] = useState<string>();
  const [llmSampleBusyProvider, setLlmSampleBusyProvider] = useState<string>();
  const [ttsSampleBusyProvider, setTtsSampleBusyProvider] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [savingScope, setSavingScope] = useState<Scope>();
  const [error, setError] = useState<string>();
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const settingsBusyRef = useRef(false);
  const secretBusyRef = useRef(false);
  const voiceBusyRef = useRef(false);
  const sampleVersionRef = useRef(0);
  const dataRevisionRef = useRef(0);
  const sampleAudio = useMemo(() => new BrowserAudioSession(), []);
  const bundleRef = useRef(bundle);
  const statusesRef = useRef(secretStatuses);
  bundleRef.current = bundle;
  statusesRef.current = secretStatuses;

  const isCurrent = useCallback((epoch: number) => mountedRef.current && epochRef.current === epoch, []);
  const invalidateVoices = useCallback((providerId: string) => {
    setVoicesByProvider((current) => {
      if (!current[providerId]) return current;
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  }, []);
  const stopSamples = useCallback(() => {
    sampleVersionRef.current += 1;
    sampleAudio.stop(true);
    setTtsSampleBusyProvider(undefined);
  }, [sampleAudio]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    settingsBusyRef.current = false;
    secretBusyRef.current = false;
    voiceBusyRef.current = false;
    sampleVersionRef.current += 1;
    dataRevisionRef.current += 1;
    setLoading(false);
    setSavingScope(undefined);
    setSecretBusyKey(undefined);
    setVoicesLoadingProvider(undefined);
    setLlmSampleBusyProvider(undefined);
    setTtsSampleBusyProvider(undefined);
    setSecretStatuses([]);
    setSecretDrafts({});
    setVoicesByProvider({});
    const next = createProviderControllerInitialState(input.desktopMode, input.platformKind);
    setBundle(next.bundle);
    setCatalog(next.catalog);
    setDrafts(next.drafts);
    return () => {
      if (epochRef.current === epoch) epochRef.current += 1;
    };
  }, [input.apiClient, input.controlClient, input.desktopMode, input.platformKind]);

  useEffect(() => {
    if (!input.ttsPlaybackBusy) return;
    stopSamples();
  }, [input.ttsPlaybackBusy, stopSamples]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      sampleAudio.stop(true);
    };
  }, [sampleAudio]);

  const applyBundle = useCallback(
    (
      settings: RemoteProviderSettingsBundle,
      nextCatalog: RemoteProviderCatalog,
      nextStatuses: ProviderSecretStatus[],
      onlyScope?: Scope,
    ) => {
      setBundle(settings);
      setCatalog(nextCatalog);
      setSecretStatuses(nextStatuses);
      setDrafts((current) => ({
        ...(onlyScope ? current : {}),
        ...(!onlyScope || onlyScope === 'llm_labeling'
          ? { llm_labeling: createProviderSettingsDraft(settings.llmLabeling, nextCatalog.aiProviders) }
          : {}),
        ...(!onlyScope || onlyScope === 'tts_synthesis'
          ? { tts_synthesis: createProviderSettingsDraft(settings.ttsSynthesis, nextCatalog.ttsProviders) }
          : {}),
      }));
      setError(undefined);
    },
    [],
  );

  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if ((!input.apiClient && !input.desktopMode) || loading) return undefined;
      if (settingsBusyRef.current || secretBusyRef.current) {
        if (!options.silent) input.notify('진행 중인 provider 작업이 끝난 뒤 새로고침하세요.', 'info');
        return undefined;
      }
      const epoch = epochRef.current;
      const revision = dataRevisionRef.current;
      setLoading(true);
      try {
        if (input.apiClient) {
          const response = await input.apiClient.getProviderSettings();
          if (isCurrent(epoch) && dataRevisionRef.current === revision)
            applyBundle(response.settings, response.catalog, response.secretStatuses);
          return response;
        }
        const settings = loadDesktopLocalProviderSettings(input.platformKind);
        const baseCatalog = desktopProviderCatalog([], input.platformKind);
        const nextStatuses = input.controlClient?.getProviderSecretStatus
          ? (
              await Promise.all(
                [
                  ...baseCatalog.aiProviders.map((provider) => ({ scope: 'llm_labeling' as const, provider })),
                  ...baseCatalog.ttsProviders.map((provider) => ({ scope: 'tts_synthesis' as const, provider })),
                ].map(async ({ scope, provider }) => {
                  const secretName = defaultProviderSecretName(scope, provider.providerId);
                  if (!secretName) return undefined;
                  return (await input.controlClient?.getProviderSecretStatus?.(scope, provider.providerId, secretName))
                    ?.status;
                }),
              )
            ).filter((status): status is ProviderSecretStatus => Boolean(status))
          : [];
        const nextCatalog = desktopProviderCatalog(nextStatuses, input.platformKind);
        if (isCurrent(epoch) && dataRevisionRef.current === revision) applyBundle(settings, nextCatalog, nextStatuses);
        return { settings, catalog: nextCatalog, secretStatuses: nextStatuses };
      } catch {
        if (isCurrent(epoch)) {
          setError('Provider 설정을 불러오지 못했습니다.');
          if (!options.silent) input.notify('Provider 설정을 불러오지 못했습니다.', 'warning');
        }
        return undefined;
      } finally {
        if (isCurrent(epoch)) setLoading(false);
      }
    },
    [applyBundle, input, isCurrent, loading],
  );

  const updateDraft = useCallback((scope: Scope, updater: (draft: ProviderSettingsDraft) => ProviderSettingsDraft) => {
    setDrafts((current) => (current[scope] ? { ...current, [scope]: updater(current[scope]!) } : current));
  }, []);

  const saveSettings = useCallback(
    async (scope: Scope) => {
      if (settingsBusyRef.current) {
        input.notify('다른 provider 설정을 저장하고 있습니다.', 'info');
        return;
      }
      if (!input.apiClient && !input.desktopMode) {
        input.notify('서버 연결 또는 데스크톱 앱에서만 provider 설정을 저장할 수 있습니다.', 'warning');
        return;
      }
      const draft = drafts[scope];
      const providers = providerCatalogForScope(catalog, scope);
      if (!draft || providers.length === 0) return refresh();
      const built = buildProviderSettingsSaveInput(draft, providers);
      if (!built.ok || !built.input) {
        setError(built.message ?? 'Provider 설정을 확인하세요.');
        input.notify(built.message ?? 'Provider 설정을 확인하세요.', 'warning');
        return;
      }
      const epoch = epochRef.current;
      dataRevisionRef.current += 1;
      settingsBusyRef.current = true;
      setSavingScope(scope);
      try {
        if (input.apiClient) {
          const response = await input.apiClient.saveProviderSettings(scope, built.input);
          if (!isCurrent(epoch)) return;
          const current = bundleRef.current ?? (await input.apiClient.getProviderSettings()).settings;
          if (!isCurrent(epoch)) return;
          applyBundle(
            replaceProviderSettingsInBundle(current, response.settings),
            response.catalog,
            response.secretStatuses,
            scope,
          );
        } else {
          const current = bundleRef.current ?? loadDesktopLocalProviderSettings(input.platformKind);
          const saved = providerSettingsForScope(current, scope)!;
          const nextSettings: RemoteProviderSettings = {
            ...saved,
            defaultProviderId: built.input.defaultProviderId,
            enabledProviderIds: built.input.enabledProviderIds ?? saved.enabledProviderIds,
            modelByProvider: built.input.modelByProvider ?? saved.modelByProvider,
            providerOptionsByProvider: built.input.providerOptionsByProvider ?? saved.providerOptionsByProvider,
            updatedAt: new Date().toISOString(),
          };
          const next = replaceProviderSettingsInBundle(current, nextSettings);
          saveDesktopLocalProviderSettings(next);
          if (!isCurrent(epoch)) return;
          applyBundle(
            next,
            desktopProviderCatalog(statusesRef.current, input.platformKind),
            statusesRef.current,
            scope,
          );
        }
        input.notify(
          scope === 'llm_labeling' ? 'LLM provider 설정을 저장했습니다.' : 'TTS provider 설정을 저장했습니다.',
          'success',
        );
      } catch {
        if (isCurrent(epoch)) {
          setError('Provider 설정을 저장하지 못했습니다.');
          input.notify('Provider 설정을 저장하지 못했습니다.', 'danger');
        }
      } finally {
        settingsBusyRef.current = false;
        if (isCurrent(epoch)) setSavingScope(undefined);
      }
    },
    [applyBundle, catalog, drafts, input, isCurrent, refresh],
  );

  const runSecretAction = useCallback(
    async (action: 'save' | 'delete' | 'test', scope: Scope, providerId: string, secretName: string) => {
      if (!input.controlClient) return;
      if (secretBusyRef.current) {
        input.notify('다른 provider 키 작업이 진행 중입니다.', 'info');
        return;
      }
      const key = providerSecretDraftKey(scope, providerId, secretName);
      const value = secretDrafts[key]?.trim();
      if (action === 'save' && !value) {
        input.notify(`${providerId} ${providerSecretDisplayLabel(secretName)} 값을 입력하세요.`, 'warning');
        return;
      }
      const epoch = epochRef.current;
      dataRevisionRef.current += 1;
      secretBusyRef.current = true;
      setSecretBusyKey(key);
      try {
        const response =
          action === 'save'
            ? await input.controlClient.saveProviderSecret(scope, providerId, secretName, value!)
            : action === 'delete'
              ? await input.controlClient.deleteProviderSecret(scope, providerId, secretName)
              : await input.controlClient.testProviderSecret(scope, providerId, secretName);
        if (!isCurrent(epoch)) return;
        const nextStatuses =
          response.secretStatuses ??
          (response.status ? replaceSecretStatus(statusesRef.current, response.status) : statusesRef.current);
        setSecretStatuses(nextStatuses);
        setCatalog(
          response.catalog ?? (input.desktopMode ? desktopProviderCatalog(nextStatuses, input.platformKind) : catalog),
        );
        if (action === 'save')
          setSecretDrafts((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        if (action !== 'test') invalidateVoices(providerId);
        input.notify(
          action === 'save'
            ? `${providerId} provider 키를 저장했습니다.`
            : action === 'delete'
              ? `${providerId} provider 키를 삭제했습니다.`
              : `${providerId} provider 키가 설정되어 있습니다.`,
          'success',
        );
      } catch {
        if (isCurrent(epoch))
          input.notify(
            `${providerId} provider ${action === 'test' ? '키가 아직 설정되지 않았습니다.' : '키 작업을 완료하지 못했습니다.'}`,
            action === 'test' ? 'warning' : 'danger',
          );
      } finally {
        secretBusyRef.current = false;
        if (isCurrent(epoch)) setSecretBusyKey(undefined);
      }
    },
    [catalog, input, invalidateVoices, isCurrent, secretDrafts],
  );

  const refreshVoices = useCallback(
    async (providerId: string) => {
      if (!input.controlClient?.listTTSProviderVoices) return;
      if (voiceBusyRef.current) {
        input.notify('다른 TTS 음성 목록을 불러오고 있습니다.', 'info');
        return;
      }
      const epoch = epochRef.current;
      voiceBusyRef.current = true;
      setVoicesLoadingProvider(providerId);
      try {
        const response = await input.controlClient.listTTSProviderVoices(providerId);
        if (!isCurrent(epoch)) return;
        setVoicesByProvider((current) => ({ ...current, [providerId]: response.voices }));
        input.notify(
          response.voices.length
            ? `${response.voices.length}개 서버 TTS 음성을 불러왔습니다.`
            : '사용 가능한 서버 TTS 음성이 없습니다.',
          'success',
        );
      } catch {
        if (isCurrent(epoch)) input.notify('서버 TTS 음성 목록을 불러오지 못했습니다.', 'warning');
      } finally {
        voiceBusyRef.current = false;
        if (isCurrent(epoch)) setVoicesLoadingProvider(undefined);
      }
    },
    [input, isCurrent],
  );

  const runDesktopLLMSample = useCallback(
    async (provider: ProviderCatalogItem, draft: ProviderSettingsDraft) => {
      if (!input.desktopMode || !input.controlClient || llmSampleBusyProvider) return;
      const epoch = epochRef.current;
      setLlmSampleBusyProvider(provider.providerId);
      try {
        const { runDesktopLLMSampleRequest } = await import('./provider-sample-runner');
        await runDesktopLLMSampleRequest(provider, draft);
        if (isCurrent(epoch)) input.notify(`${provider.displayName} 샘플 JSON 요청이 성공했습니다.`, 'success');
      } catch (sampleError) {
        if (isCurrent(epoch)) {
          const inputMessage = providerSampleInputMessage(sampleError);
          input.notify(
            inputMessage ?? `${provider.displayName} 샘플 JSON 요청에 실패했습니다.`,
            inputMessage ? 'warning' : 'danger',
          );
        }
      } finally {
        if (isCurrent(epoch)) setLlmSampleBusyProvider(undefined);
      }
    },
    [input, isCurrent, llmSampleBusyProvider],
  );

  const playDesktopTTSSample = useCallback(
    async (provider: ProviderCatalogItem, draft: ProviderSettingsDraft) => {
      if (!input.desktopMode || !input.controlClient || input.ttsPlaybackBusy || ttsSampleBusyProvider) return;
      const epoch = epochRef.current;
      const sampleVersion = ++sampleVersionRef.current;
      setTtsSampleBusyProvider(provider.providerId);
      sampleAudio.stop(true);
      try {
        const { playDesktopTTSSampleRequest } = await import('./provider-sample-runner');
        const played = await playDesktopTTSSampleRequest({
          provider,
          draft,
          voices: voicesByProvider[provider.providerId] ?? [],
          audio: sampleAudio,
          text: SAMPLE_TEXT,
        });
        if (!isCurrent(epoch) || sampleVersionRef.current !== sampleVersion) return;
        input.notify(
          played
            ? `${provider.displayName} 샘플 합성을 재생했습니다.`
            : `${provider.displayName} 샘플 오디오를 재생하지 못했습니다.`,
          played ? 'success' : 'warning',
        );
      } catch (sampleError) {
        if (isCurrent(epoch) && sampleVersionRef.current === sampleVersion) {
          const inputMessage = providerSampleInputMessage(sampleError);
          input.notify(
            inputMessage ?? `${provider.displayName} 샘플 합성에 실패했습니다.`,
            inputMessage ? 'warning' : 'danger',
          );
        }
      } finally {
        if (isCurrent(epoch) && sampleVersionRef.current === sampleVersion) setTtsSampleBusyProvider(undefined);
      }
    },
    [input, isCurrent, sampleAudio, ttsSampleBusyProvider, voicesByProvider],
  );

  const playDesktopVoiceSample = useCallback(
    async (provider: ProviderCatalogItem, draft: ProviderSettingsDraft, text: string, voiceId: string) => {
      if (!input.desktopMode || !input.controlClient || input.ttsPlaybackBusy || ttsSampleBusyProvider) return false;
      const epoch = epochRef.current;
      const sampleVersion = ++sampleVersionRef.current;
      setTtsSampleBusyProvider(provider.providerId);
      sampleAudio.stop(true);
      try {
        const { playDesktopTTSSampleRequest } = await import('./provider-sample-runner');
        return await playDesktopTTSSampleRequest({
          provider,
          draft,
          voices: voicesByProvider[provider.providerId] ?? [],
          audio: sampleAudio,
          text,
          voiceId,
        });
      } finally {
        if (isCurrent(epoch) && sampleVersionRef.current === sampleVersion) setTtsSampleBusyProvider(undefined);
      }
    },
    [input, isCurrent, sampleAudio, ttsSampleBusyProvider, voicesByProvider],
  );

  const available = Boolean(input.apiClient) || (input.desktopMode && Boolean(input.controlClient));
  const panelController: ProviderSettingsPanelController = {
    available,
    loading,
    error,
    savingScope,
    secretStatuses,
    secretDrafts,
    secretBusyKey,
    desktopMode: input.desktopMode,
    analysisRunning: input.analysisRunning,
    hostedTTSBusy: input.ttsPlaybackBusy,
    desktopLLMSampleBusyProvider: llmSampleBusyProvider,
    desktopTTSSampleBusyProvider: ttsSampleBusyProvider,
    updateDraft,
    updateSecretDraft: (key, value) => setSecretDrafts((current) => ({ ...current, [key]: value })),
    refresh,
    saveSettings,
    saveSecret: (scope, providerId, secretName) => runSecretAction('save', scope, providerId, secretName),
    deleteSecret: (scope, providerId, secretName) => runSecretAction('delete', scope, providerId, secretName),
    testSecret: (scope, providerId, secretName) => runSecretAction('test', scope, providerId, secretName),
    runDesktopLLMSample,
    playDesktopTTSSample,
  };

  return {
    bundle,
    catalog,
    drafts,
    secretStatuses,
    voicesByProvider,
    voicesLoadingProvider,
    refresh,
    refreshVoices,
    stopSamples,
    playDesktopVoiceSample,
    panelController,
  } as const;
}
