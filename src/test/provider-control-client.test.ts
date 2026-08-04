import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSecretStatus } from '../providers/provider-jobs';
import { DesktopProviderControlClient } from '../providers/provider-control-client';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

const status = (overrides: Partial<ProviderSecretStatus> = {}): ProviderSecretStatus => ({
  scope: 'llm_labeling',
  providerId: 'openai',
  secretName: 'api_key',
  configured: true,
  source: 'desktop_secure_store',
  updatedAt: '2026-07-06T00:00:00.000Z',
  ...overrides,
});

describe('DesktopProviderControlClient', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('maps provider secret set/delete/test/status to Tauri commands', async () => {
    const setStatus = status();
    const deletedStatus = status({ configured: false });
    invokeMock
      .mockResolvedValueOnce(setStatus)
      .mockResolvedValueOnce(deletedStatus)
      .mockResolvedValueOnce(setStatus)
      .mockResolvedValueOnce(setStatus);

    const client = new DesktopProviderControlClient();

    await expect(client.saveProviderSecret('llm_labeling', 'openai', 'api_key', 'sk-test')).resolves.toEqual({
      status: setStatus,
    });
    await expect(client.deleteProviderSecret('llm_labeling', 'openai', 'api_key')).resolves.toEqual({
      status: deletedStatus,
    });
    await expect(client.testProviderSecret('llm_labeling', 'openai', 'api_key')).resolves.toEqual({
      ok: true,
      status: setStatus,
    });
    await expect(client.getProviderSecretStatus('llm_labeling', 'openai', 'api_key')).resolves.toEqual({
      status: setStatus,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'provider_secret_set', {
      scope: 'llm_labeling',
      providerId: 'openai',
      secretName: 'api_key',
      secretValue: 'sk-test',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'provider_secret_delete', {
      scope: 'llm_labeling',
      providerId: 'openai',
      secretName: 'api_key',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'provider_secret_test', {
      scope: 'llm_labeling',
      providerId: 'openai',
      secretName: 'api_key',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'provider_secret_status', {
      scope: 'llm_labeling',
      providerId: 'openai',
      secretName: 'api_key',
    });
  });

  it('lists TTS voices through the desktop Tauri voice discovery command', async () => {
    const voices = [{ id: 'alloy', label: 'Alloy', lang: 'en-US' }];
    invokeMock.mockResolvedValueOnce({ voices });

    const client = new DesktopProviderControlClient();

    await expect(client.listTTSProviderVoices('openai-tts')).resolves.toEqual({ voices });
    expect(invokeMock).toHaveBeenCalledWith('desktop_tts_list_voices', { providerId: 'openai-tts' });
  });
});
