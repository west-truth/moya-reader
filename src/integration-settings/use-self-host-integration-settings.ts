import { useCallback, useEffect, useRef } from 'react';
import type { AppExtensionManager } from '../extensions/app-extension-manager';
import type { TrustedReaderAddonHostContext } from '../extensions/reader-addon-host-context';
import type { TrustedAnalysisWorkflowHostContext } from '../extensions/analysis-workflow-host-context';
import type { WebNovelMetadataCollectorBroker } from '../services/webnovel-metadata-collector-broker';
import type { ExternalSourceLocalStateStore } from '../external-sources/local-state';
import type { SuwayomiSourceAccountBroker } from '../external-sources/suwayomi/suwayomi-source-account-broker';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import {
  mergeInitialSelfHostIntegrationSettings,
  type SelfHostIntegrationSettingsV1,
} from './self-host-integration-settings';

const SAVE_DEBOUNCE_MS = 350;
const REMOTE_REFRESH_MS = 5_000;

type ExtensionManager = AppExtensionManager<TrustedReaderAddonHostContext, TrustedAnalysisWorkflowHostContext>;

export interface SelfHostIntegrationSettingsInput {
  readonly enabled: boolean;
  readonly client?: Pick<RemoteApiClient, 'getIntegrationSettings' | 'saveIntegrationSettings'>;
  readonly extensionManager: ExtensionManager;
  readonly metadataCollector: WebNovelMetadataCollectorBroker;
  readonly externalSourceState: ExternalSourceLocalStateStore;
  readonly suwayomi: SuwayomiSourceAccountBroker;
  onApplied(): void;
  notify(message: string, tone?: 'info' | 'success' | 'warning' | 'danger'): void;
}

function comparable(settings: SelfHostIntegrationSettingsV1): string {
  const { updatedAt: _updatedAt, ...content } = settings;
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
  const lastRemoteUpdatedAtRef = useRef<string>();
  const lastSavedContentRef = useRef<string>();
  const errorNotifiedRef = useRef(false);

  const capture = useCallback(async (): Promise<SelfHostIntegrationSettingsV1> => {
    const current = inputRef.current;
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      extensionEnablement: current.extensionManager.getEnablementSnapshot(),
      webNovelMetadata: current.metadataCollector.getSharedSettings(),
      externalSources: await current.externalSourceState.exportSharedState(),
    };
  }, []);

  const apply = useCallback(async (settings: SelfHostIntegrationSettingsV1) => {
    const current = inputRef.current;
    applyingRef.current = true;
    try {
      current.extensionManager.applyEnablementSnapshot(settings.extensionEnablement);
      current.metadataCollector.applySharedSettings(settings.webNovelMetadata);
      await current.externalSourceState.replaceSharedState(settings.externalSources);
      await current.suwayomi.refreshSharedConfiguration();
      lastRemoteUpdatedAtRef.current = settings.updatedAt;
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
      const response = await current.client.saveIntegrationSettings(snapshot);
      lastRemoteUpdatedAtRef.current = response.settings.updatedAt;
      lastSavedContentRef.current = comparable(response.settings);
      errorNotifiedRef.current = false;
    } catch (error) {
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
  }, [capture]);

  const scheduleSave = useCallback(() => {
    if (!hydratedRef.current || applyingRef.current) return;
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
    lastRemoteUpdatedAtRef.current = undefined;
    lastSavedContentRef.current = undefined;
    let active = true;

    const hydrate = async () => {
      if (hydrationInFlightRef.current || hydratedRef.current) return;
      hydrationInFlightRef.current = true;
      try {
        const { settings } = await input.client!.getIntegrationSettings();
        if (!active) return;
        if (settings) {
          const local = await capture();
          const merged = mergeInitialSelfHostIntegrationSettings(settings, local);
          if (comparable(merged) === comparable(settings)) {
            await apply(settings);
          } else {
            const response = await input.client!.saveIntegrationSettings(merged);
            if (!active) return;
            await apply(response.settings);
          }
        } else {
          const local = await capture();
          const response = await input.client!.saveIntegrationSettings(local);
          if (!active) return;
          lastRemoteUpdatedAtRef.current = response.settings.updatedAt;
          lastSavedContentRef.current = comparable(response.settings);
          inputRef.current.onApplied();
        }
        hydratedRef.current = true;
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
    const retryTimer = window.setInterval(() => void hydrate(), REMOTE_REFRESH_MS);
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
    const refresh = () => {
      if (
        document.visibilityState === 'hidden' ||
        !hydratedRef.current ||
        applyingRef.current ||
        saveInFlightRef.current ||
        saveTimerRef.current !== undefined
      ) {
        return;
      }
      void input
        .client!.getIntegrationSettings(lastRemoteUpdatedAtRef.current)
        .then(({ settings }) => {
          if (settings && settings.updatedAt !== lastRemoteUpdatedAtRef.current) return apply(settings);
          return undefined;
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, REMOTE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [apply, input.client, input.enabled]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );
}
