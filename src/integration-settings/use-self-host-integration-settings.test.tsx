import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSelfHostIntegrationSettings } from './use-self-host-integration-settings';
import type { SelfHostIntegrationSettingsV1 } from './self-host-integration-settings';

const firstUpdatedAt = '2026-09-04T00:00:00.000Z';

function integrationSettings(): SelfHostIntegrationSettingsV1 {
  return {
    schemaVersion: 1,
    updatedAt: firstUpdatedAt,
    extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { 'moya.extension.metadata': true } },
    webNovelMetadata: {
      schemaVersion: 1,
      includeAdult: false,
      automaticLookup: true,
      automaticApply: 'missing_fields',
    },
    externalSources: {
      schemaVersion: 1,
      connections: [],
      links: [],
      subscriptions: [],
    },
  };
}

function createFixture(getIntegrationSettings = vi.fn(async () => ({ settings: integrationSettings() }))) {
  const extensionListeners = new Set<() => void>();
  const metadataListeners = new Set<() => void>();
  const sourceListeners = new Set<() => void>();
  let local = integrationSettings();
  const saveIntegrationSettings = vi.fn(async (settings: SelfHostIntegrationSettingsV1) => ({
    ok: true as const,
    settings: { ...settings, updatedAt: '2026-09-04T00:00:01.000Z' },
  }));
  const applyEnablementSnapshot = vi.fn();
  const applySharedSettings = vi.fn();
  const replaceSharedState = vi.fn(async () => undefined);
  const refreshSharedConfiguration = vi.fn(async () => undefined);
  const onApplied = vi.fn();
  const notify = vi.fn();

  function Harness() {
    useSelfHostIntegrationSettings({
      enabled: true,
      client: { getIntegrationSettings, saveIntegrationSettings },
      extensionManager: {
        subscribe: (listener: () => void) => {
          extensionListeners.add(listener);
          return () => extensionListeners.delete(listener);
        },
        getEnablementSnapshot: () => local.extensionEnablement,
        applyEnablementSnapshot,
      } as never,
      metadataCollector: {
        subscribe: (listener: () => void) => {
          metadataListeners.add(listener);
          return () => metadataListeners.delete(listener);
        },
        getSharedSettings: () => local.webNovelMetadata,
        applySharedSettings,
      } as never,
      externalSourceState: {
        subscribeSharedChanges: (listener: () => void) => {
          sourceListeners.add(listener);
          return () => sourceListeners.delete(listener);
        },
        exportSharedState: async () => local.externalSources,
        replaceSharedState,
      } as never,
      suwayomi: { refreshSharedConfiguration } as never,
      onApplied,
      notify,
    });
    return null;
  }

  return {
    Harness,
    extensionListeners,
    getIntegrationSettings,
    saveIntegrationSettings,
    applyEnablementSnapshot,
    applySharedSettings,
    replaceSharedState,
    refreshSharedConfiguration,
    onApplied,
    notify,
    updateLocal(update: SelfHostIntegrationSettingsV1) {
      local = update;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useSelfHostIntegrationSettings', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hydrates live extension, metadata and source state, then saves later local changes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const fixture = createFixture();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });

    expect(fixture.applyEnablementSnapshot).toHaveBeenCalledWith(integrationSettings().extensionEnablement);
    expect(fixture.applySharedSettings).toHaveBeenCalledWith(integrationSettings().webNovelMetadata);
    expect(fixture.replaceSharedState).toHaveBeenCalledWith(integrationSettings().externalSources);
    expect(fixture.refreshSharedConfiguration).toHaveBeenCalledOnce();
    expect(fixture.onApplied).toHaveBeenCalledOnce();

    fixture.updateLocal({
      ...integrationSettings(),
      extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { 'moya.extension.metadata': false } },
    });
    await act(async () => {
      for (const listener of fixture.extensionListeners) listener();
      await vi.advanceTimersByTimeAsync(350);
      await flush();
    });
    expect(fixture.saveIntegrationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { 'moya.extension.metadata': false } },
      }),
    );

    await act(async () => renderer.unmount());
  });

  it('retries initial hydration after a transient self-host request failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const getIntegrationSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue({ settings: integrationSettings() });
    const fixture = createFixture(getIntegrationSettings);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });
    expect(fixture.notify).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
    });
    expect(getIntegrationSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.onApplied).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });
});
