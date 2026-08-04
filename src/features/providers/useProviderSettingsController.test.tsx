import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteApiClient, RemoteProviderSettingsResponse } from '../../services/remote/remote-api-client';
import { normalizeProviderSampleFormat } from './provider-sample-format';
import { useProviderSettingsController, type ProviderSettingsControllerInput } from './useProviderSettingsController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('provider settings controller', () => {
  it('keeps plain browser mode unavailable without exposing a secret draft', () => {
    let snapshot: ReturnType<typeof useProviderSettingsController> | undefined;
    const input: ProviderSettingsControllerInput = {
      desktopMode: false,
      platformKind: 'browser',
      analysisRunning: false,
      ttsPlaybackBusy: false,
      notify: vi.fn(),
    };
    function Harness() {
      snapshot = useProviderSettingsController(input);
      return null;
    }

    renderToStaticMarkup(<Harness />);

    expect(snapshot?.panelController.available).toBe(false);
    expect(snapshot?.panelController.secretDrafts).toEqual({});
    expect(snapshot?.bundle).toBeUndefined();
  });

  it('allows only supported non-secret sample formats', () => {
    expect(normalizeProviderSampleFormat('wav')).toBe('wav');
    expect(normalizeProviderSampleFormat('provider-key')).toBe('mp3');
    expect(normalizeProviderSampleFormat(undefined)).toBe('mp3');
  });

  it('does not commit a hosted refresh after the provider runtime changes', async () => {
    const response = deferred<RemoteProviderSettingsResponse>();
    const notify = vi.fn();
    const apiClient = {
      getProviderSettings: vi.fn(() => response.promise),
    } as unknown as RemoteApiClient;
    let input: ProviderSettingsControllerInput = {
      apiClient,
      desktopMode: false,
      platformKind: 'browser',
      analysisRunning: false,
      ttsPlaybackBusy: false,
      notify,
    };
    let controller!: ReturnType<typeof useProviderSettingsController>;
    function Harness() {
      controller = useProviderSettingsController(input);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    let refresh!: ReturnType<typeof controller.refresh>;
    await act(async () => {
      refresh = controller.refresh();
    });
    input = { ...input, apiClient: undefined };
    await act(async () => renderer.update(<Harness />));
    await act(async () => {
      response.resolve({
        settings: {
          llmLabeling: {
            scope: 'llm_labeling',
            defaultProviderId: 'stale-provider',
            enabledProviderIds: ['stale-provider'],
            modelByProvider: {},
            providerOptionsByProvider: {},
          },
          ttsSynthesis: {
            scope: 'tts_synthesis',
            enabledProviderIds: [],
            modelByProvider: {},
            providerOptionsByProvider: {},
          },
        },
        catalog: { aiProviders: [], ttsProviders: [] },
        secretStatuses: [],
      });
      await refresh;
    });

    expect(controller.bundle).toBeUndefined();
    expect(controller.panelController.available).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});
