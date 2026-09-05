import { useCallback, useEffect, useRef } from 'react';
import type { AppExtensionManager } from '../extensions/app-extension-manager';
import type { TrustedReaderAddonHostContext } from '../extensions/reader-addon-host-context';
import type { TrustedAnalysisWorkflowHostContext } from '../extensions/analysis-workflow-host-context';
import type { WebNovelMetadataCollectorBroker } from '../services/webnovel-metadata-collector-broker';
import type { ExternalSourceLocalStateStore } from '../external-sources/local-state';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteApiError } from '../services/remote/remote-api-contracts';
import {
  hasMeaningfulSelfHostIntegrationState,
  mergeInitialSelfHostIntegrationSettings,
  type SelfHostIntegrationSettingsV1,
} from './self-host-integration-settings';

const SAVE_DEBOUNCE_MS = 350;
const HYDRATION_RETRY_MS = 5_000;
const REMOTE_REFRESH_MS = 60_000;
const FOCUS_REFRESH_MIN_AGE_MS = 30_000;

type ExtensionManager = AppExtensionManager<TrustedReaderAddonHostContext, TrustedAnalysisWorkflowHostContext>;

export interface SelfHostIntegrationSettingsInput {
  readonly enabled: boolean;
  readonly client?: Pick<RemoteApiClient, 'getIntegrationSettings' | 'saveIntegrationSettings'>;
  readonly extensionManager: ExtensionManager;
  readonly metadataCollector: WebNovelMetadataCollectorBroker;
  readonly externalSourceState: ExternalSourceLocalStateStore;
  readonly sourceBrokers: readonly { refreshSharedConfiguration(): Promise<void> }[];
  onApplied(): void;
  notify(message: string, tone?: 'info' | 'success' | 'warning' | 'danger'): void;
}

function comparable(settings: SelfHostIntegrationSettingsV1): string {
  const { updatedAt: _updatedAt, revision: _revision, ...content } = settings;
  return JSON.stringify(content);
}

/** Mirrors non-secret integration preferences through the self-host account while this tab is alive. */
export function useSelfHostIntegrationSettings(input: SelfHostIntegrationSettingsInput): void {
  const inputRef = useRef(input);
  inputRef.current = input;
  const hydratedRef = useRef(false);
  const hydrationInFlightRef = useRef(false);
  const applyingRef = useRef(false);
  const saveTimerRef = useRef<number>();
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const lastRemoteRevisionRef = useRef(0);
  const lastSavedContentRef = useRef<string>();
  const legacyImportCompletedRef = useRef(false);
  const errorNotifiedRef = useRef(false);
  const lastRemoteCheckRef = useRef(0);
  const localChangeRef = useRef(0);

  const capture = useCallback(async (): Promise<SelfHostIntegrationSettingsV1> => {
    const current = inputRef.current;
    const snapshot = {
      schemaVersion: 1 as const,
      revision: lastRemoteRevisionRef.current,
      updatedAt: new Date().toISOString(),
      legacyImportCompleted: legacyImportCompletedRef.current,
      extensionEnablement: current.extensionManager.getEnablementSnapshot(),
      webNovelMetadata: current.metadataCollector.getSharedSettings(),
      externalSources: await current.externalSourceState.exportSharedState(),
    };
    return {
      ...snapshot,
      legacyImportCompleted: snapshot.legacyImportCompleted || hasMeaningfulSelfHostIntegrationState(snapshot),
    };
  }, []);

  const apply = useCallback(async (settings: SelfHostIntegrationSettingsV1) => {
    const current = inputRef.current;
    applyingRef.current = true;
    try {
      current.extensionManager.applyEnablementSnapshot(settings.extensionEnablement);
      current.metadataCollector.applySharedSettings(settings.webNovelMetadata);
      await current.externalSourceState.replaceSharedState(settings.externalSources);
      await Promise.all(current.sourceBrokers.map((broker) => broker.refreshSharedConfiguration()));
      legacyImportCompletedRef.current = settings.legacyImportCompleted;
      lastRemoteRevisionRef.current = settings.revision;
      lastSavedContentRef.current = comparable(settings);
      current.onApplied();
    } finally {
      applyingRef.current = false;
    }
  }, []);

  const save = useCallback(async () => {
    const current = inputRef.current;
    if (!current.enabled || !current.client || !hydratedRef.current || applyingRef.current) return;
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return;
    }
    saveInFlightRef.current = true;
    try {
      const snapshot = await capture();
      const content = comparable(snapshot);
      if (content === lastSavedContentRef.current) return;
      const response = await current.client.saveIntegrationSettings(snapshot, lastRemoteRevisionRef.current);
      legacyImportCompletedRef.current = response.settings.legacyImportCompleted;
      lastRemoteRevisionRef.current = response.settings.revision;
      lastSavedContentRef.current = comparable(response.settings);
      lastRemoteCheckRef.current = Date.now();
      errorNotifiedRef.current = false;
    } catch (error) {
      if (error instanceof RemoteApiError && error.status === 409) {
        try {
          const latest = await current.client.getIntegrationSettings();
          if (latest.settings) await apply(latest.settings);
        } catch {
          // The warning below still explains why the local snapshot was not written.
        }
        current.notify('다른 기기에서 설정이 바뀌어 최신 설정을 불러왔습니다. 변경을 다시 시도해 주세요.', 'warning');
        return;
      }
      if (!errorNotifiedRef.current) {
        errorNotifiedRef.current = true;
        current.notify(
          error instanceof Error
            ? `기기 간 설정을 저장하지 못했습니다. ${error.message}`
            : '기기 간 설정을 저장하지 못했습니다.',
          'warning',
        );
      }
    } finally {
      saveInFlightRef.current = false;
      if (saveAgainRef.current) {
        saveAgainRef.current = false;
        void save();
      }
    }
  }, [apply, capture]);

  const scheduleSave = useCallback(() => {
    if (!hydratedRef.current || applyingRef.current) return;
    localChangeRef.current += 1;
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      void save();
    }, SAVE_DEBOUNCE_MS);
  }, [save]);

  useEffect(() => {
    if (!input.enabled || !input.client) {
      hydratedRef.current = false;
      return;
    }
    hydratedRef.current = false;
    lastRemoteRevisionRef.current = 0;
    lastSavedContentRef.current = undefined;
    legacyImportCompletedRef.current = false;
    let active = true;

    const hydrate = async () => {
      if (hydrationInFlightRef.current || hydratedRef.current) return;
      hydrationInFlightRef.current = true;
      try {
        const { settings } = await input.client!.getIntegrationSettings();
        if (!active) return;
        if (settings) {
          if (settings.legacyImportCompleted) {
            await apply(settings);
          } else {
            const local = await capture();
            if (hasMeaningfulSelfHostIntegrationState(local)) {
              const merged = mergeInitialSelfHostIntegrationSettings(settings, local);
              const response = await input.client!.saveIntegrationSettings(merged, settings.revision);
              if (!active) return;
              await apply(response.settings);
            } else {
              await apply(settings);
            }
          }
        } else {
          const local = await capture();
          const response = await input.client!.saveIntegrationSettings(local, 0);
          if (!active) return;
          legacyImportCompletedRef.current = response.settings.legacyImportCompleted;
          lastRemoteRevisionRef.current = response.settings.revision;
          lastSavedContentRef.current = comparable(response.settings);
          inputRef.current.onApplied();
        }
        hydratedRef.current = true;
        lastRemoteCheckRef.current = Date.now();
        errorNotifiedRef.current = false;
      } catch (error) {
        if (!active || errorNotifiedRef.current) return;
        errorNotifiedRef.current = true;
        inputRef.current.notify(
          error instanceof Error
            ? `기기 간 설정을 불러오지 못했습니다. ${error.message}`
            : '기기 간 설정을 불러오지 못했습니다.',
          'warning',
        );
      } finally {
        hydrationInFlightRef.current = false;
      }
    };

    void hydrate();
    const retryTimer = window.setInterval(() => void hydrate(), HYDRATION_RETRY_MS);
    return () => {
      active = false;
      window.clearInterval(retryTimer);
    };
  }, [apply, capture, input.client, input.enabled]);

  useEffect(() => {
    if (!input.enabled || !input.client) return;
    const unsubscribeExtensions = input.extensionManager.subscribe(scheduleSave);
    const unsubscribeMetadata = input.metadataCollector.subscribe(scheduleSave);
    const unsubscribeSources = input.externalSourceState.subscribeSharedChanges(scheduleSave);
    return () => {
      unsubscribeExtensions();
      unsubscribeMetadata();
      unsubscribeSources();
    };
  }, [
    input.client,
    input.enabled,
    input.extensionManager,
    input.externalSourceState,
    input.metadataCollector,
    scheduleSave,
  ]);

  useEffect(() => {
    if (!input.enabled || !input.client) return;
    let active = true;
    let inFlight = false;
    const refresh = (minimumAge: number) => {
      if (
        !active ||
        inFlight ||
        document.visibilityState === 'hidden' ||
        !hydratedRef.current ||
        applyingRef.current ||
        saveInFlightRef.current ||
        saveTimerRef.current !== undefined ||
        Date.now() - lastRemoteCheckRef.current < minimumAge
      ) {
        return;
      }
      inFlight = true;
      lastRemoteCheckRef.current = Date.now();
      const revision = lastRemoteRevisionRef.current;
      const localChange = localChangeRef.current;
      void input
        .client!.getIntegrationSettings(revision)
        .then(async ({ settings }) => {
          // A slow background read must not overwrite a more recent local edit/save.
          if (
            !active ||
            localChange !== localChangeRef.current ||
            revision !== lastRemoteRevisionRef.current ||
            applyingRef.current ||
            saveInFlightRef.current ||
            saveTimerRef.current !== undefined
          )
            return;
          if (settings && settings.revision !== lastRemoteRevisionRef.current) await apply(settings);
          lastRemoteCheckRef.current = Date.now();
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    const onFocus = () => refresh(FOCUS_REFRESH_MIN_AGE_MS);
    const timer = window.setInterval(onFocus, REMOTE_REFRESH_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [apply, input.client, input.enabled]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );
}
