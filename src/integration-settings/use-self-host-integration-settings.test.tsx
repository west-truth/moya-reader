import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelfHostIntegrationSettings } from './use-self-host-integration-settings';
import type { SelfHostIntegrationSettingsV1 } from './self-host-integration-settings';
import { RemoteApiError } from '../services/remote/remote-api-contracts';

const firstUpdatedAt = '2026-09-04T00:00:00.000Z';

function integrationSettings(): SelfHostIntegrationSettingsV1 {
  return {
    schemaVersion: 1,
    revision: 4,
    updatedAt: firstUpdatedAt,
    legacyImportCompleted: true,
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

function createFixture(
  getIntegrationSettings = vi.fn(async () => ({ settings: integrationSettings() })),
  saveIntegrationSettings = vi.fn(async (settings: SelfHostIntegrationSettingsV1, expectedRevision: number) => ({
    ok: true as const,
    settings: { ...settings, revision: expectedRevision + 1, updatedAt: '2026-09-04T00:00:01.000Z' },
  })),
) {
  const extensionListeners = new Set<() => void>();
  const metadataListeners = new Set<() => void>();
  const sourceListeners = new Set<() => void>();
  let local = integrationSettings();
  const applyEnablementSnapshot = vi.fn();
  const applySharedSettings = vi.fn();
  const replaceSharedState = vi.fn(async () => undefined);
  const refreshSharedConfiguration = vi.fn(async () => undefined);
  const refreshTextConfiguration = vi.fn(async () => undefined);
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
      sourceBrokers: [{ refreshSharedConfiguration }, { refreshSharedConfiguration: refreshTextConfiguration }],
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
    refreshTextConfiguration,
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      }),
    );
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hydrates live extension, metadata and source state, then saves later local changes', async () => {
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
    expect(fixture.refreshTextConfiguration).toHaveBeenCalledOnce();
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
      4,
    );

    await act(async () => renderer.unmount());
  });

  it('retries initial hydration after a transient self-host request failure', async () => {
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

  it('uses a migrated server document as authoritative instead of reviving stale local source state', async () => {
    const server = {
      ...integrationSettings(),
      externalSources: { schemaVersion: 1 as const, connections: [], links: [], subscriptions: [] },
    };
    const fixture = createFixture(vi.fn(async () => ({ settings: server })));
    fixture.updateLocal({
      ...integrationSettings(),
      externalSources: {
        schemaVersion: 1,
        connections: [
          {
            schemaVersion: 1,
            connectorId: 'moya.external.suwayomi.sources',
            accountConnectionId: 'stale-account',
            endpoint: 'https://stale.example.test',
            authMode: 'none',
            label: 'Stale',
            updatedAt: firstUpdatedAt,
          },
        ],
        links: [],
        subscriptions: [],
      },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });

    expect(fixture.replaceSharedState).toHaveBeenCalledWith(server.externalSources);
    expect(fixture.saveIntegrationSettings).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('imports meaningful device-local state once when the server migration marker is incomplete', async () => {
    const server = {
      ...integrationSettings(),
      legacyImportCompleted: false,
      extensionEnablement: { schemaVersion: 1 as const, enabledByExtensionId: {} },
      webNovelMetadata: {
        schemaVersion: 1 as const,
        includeAdult: false,
        automaticLookup: false,
        automaticApply: 'off' as const,
      },
      externalSources: { schemaVersion: 1 as const, connections: [], links: [], subscriptions: [] },
    };
    const fixture = createFixture(vi.fn(async () => ({ settings: server })));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });

    expect(fixture.saveIntegrationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ legacyImportCompleted: true }),
      4,
    );
    await act(async () => renderer.unmount());
  });

  it('reloads current server state instead of overwriting it after a stale revision conflict', async () => {
    const latest = {
      ...integrationSettings(),
      revision: 5,
      externalSources: { schemaVersion: 1 as const, connections: [], links: [], subscriptions: [] },
    };
    const getIntegrationSettings = vi
      .fn()
      .mockResolvedValueOnce({ settings: integrationSettings() })
      .mockResolvedValueOnce({ settings: latest });
    const saveIntegrationSettings = vi.fn(async () => {
      throw new RemoteApiError('integration settings changed', 409);
    });
    const fixture = createFixture(getIntegrationSettings, saveIntegrationSettings);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });
    fixture.updateLocal({
      ...integrationSettings(),
      extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { 'moya.extension.metadata': false } },
    });
    await act(async () => {
      for (const listener of fixture.extensionListeners) listener();
      await vi.advanceTimersByTimeAsync(350);
      await flush();
    });

    expect(saveIntegrationSettings).toHaveBeenCalledWith(expect.any(Object), 4);
    expect(fixture.replaceSharedState).toHaveBeenLastCalledWith(latest.externalSources);
    expect(fixture.notify).toHaveBeenCalledWith(
      '다른 기기에서 설정이 바뀌어 최신 설정을 불러왔습니다. 변경을 다시 시도해 주세요.',
      'warning',
    );
    await act(async () => renderer.unmount());
  });

  it('polls once per minute while visible and refreshes a stale tab on return', async () => {
    const fixture = createFixture();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fixture.getIntegrationSettings).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(fixture.getIntegrationSettings).toHaveBeenCalledTimes(2);
    expect(fixture.getIntegrationSettings).toHaveBeenLastCalledWith(4);
    Object.assign(document, { visibilityState: 'hidden' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fixture.getIntegrationSettings).toHaveBeenCalledTimes(2);
    Object.assign(document, { visibilityState: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await flush();
    });
    expect(fixture.getIntegrationSettings).toHaveBeenCalledTimes(3);
    await act(async () => renderer.unmount());
  });

  it('coalesces focus, visibility and timer events while a slow request is pending', async () => {
    let resolve!: (value: { settings: SelfHostIntegrationSettingsV1 }) => void;
    const delayed = new Promise<{ settings: SelfHostIntegrationSettingsV1 }>((done) => {
      resolve = done;
    });
    const get = vi.fn().mockResolvedValueOnce({ settings: integrationSettings() }).mockReturnValue(delayed);
    const fixture = createFixture(get);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
      window.dispatchEvent(new Event('focus'));
    });
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve({ settings: { ...integrationSettings(), revision: 5 } });
      await flush();
    });
    expect(fixture.onApplied).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it.each([100, 700])('does not apply a delayed poll over a local edit (%i ms response delay)', async (delay) => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ settings: integrationSettings() })
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  settings: {
                    ...integrationSettings(),
                    revision: 5,
                    extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { remote: true } },
                  },
                }),
              delay,
            ),
          ),
      );
    const fixture = createFixture(get);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    fixture.updateLocal({
      ...integrationSettings(),
      extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { local: true } },
    });
    await act(async () => {
      fixture.extensionListeners.forEach((listener) => listener());
      await vi.advanceTimersByTimeAsync(349);
    });
    expect(fixture.saveIntegrationSettings).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fixture.saveIntegrationSettings).toHaveBeenCalledOnce();
    expect(fixture.saveIntegrationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { local: true } },
      }),
      4,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(fixture.onApplied).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it('ignores late background responses and removes focus listeners after unmount', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ settings: integrationSettings() })
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ settings: { ...integrationSettings(), revision: 5 } }), 700),
          ),
      );
    const fixture = createFixture(get);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<fixture.Harness />);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await act(async () => renderer.unmount());
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(get).toHaveBeenCalledTimes(2);
    expect(fixture.onApplied).toHaveBeenCalledOnce();
  });
});
