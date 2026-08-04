import { describe, expect, it } from 'vitest';
import type { ProviderSecretStatus } from '../providers/provider-jobs';
import {
  defaultProviderSecretName,
  desktopLocalProviderSettingsBundle,
  desktopProviderCatalog,
  loadDesktopLocalProviderSettings,
  nativeLocalLLMProviderIds,
  providerSecretCanDelete,
  providerSecretDraftKey,
  providerSecretStatusLabel,
  replaceSecretStatus,
  saveDesktopLocalProviderSettings,
} from '../providers/desktop-provider-catalog';
import { catalogProviderReady } from '../providers/provider-settings-ui';

function secretStatus(patch: Partial<ProviderSecretStatus> = {}): ProviderSecretStatus {
  return {
    scope: 'llm_labeling',
    providerId: 'openai',
    secretName: 'api_key',
    configured: true,
    source: 'desktop_secure_store',
    last4: '1234',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...patch,
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('desktop provider catalog helpers', () => {
  it('exposes Vertex only for desktop native local mode', () => {
    expect(nativeLocalLLMProviderIds('tauri-desktop')).toContain('gemini-vertex');
    expect(nativeLocalLLMProviderIds('tauri-mobile')).not.toContain('gemini-vertex');

    const desktopCatalog = desktopProviderCatalog([], 'tauri-desktop');
    const mobileCatalog = desktopProviderCatalog([], 'tauri-mobile');

    expect(desktopCatalog.aiProviders.map((provider) => provider.providerId)).toEqual([
      'openai',
      'gemini-ai-studio',
      'gemini-vertex',
      'anthropic',
    ]);
    expect(mobileCatalog.aiProviders.map((provider) => provider.providerId)).toEqual([
      'openai',
      'gemini-ai-studio',
      'anthropic',
    ]);
    expect(mobileCatalog.aiProviders.every((provider) => provider.displayName.includes('Android'))).toBe(true);
    for (const provider of desktopCatalog.aiProviders) {
      const compactProfile = provider.capabilities.supportedRequestProfiles?.find(
        (profile) => profile.profileId === 'speaker-attribution-v3-compact',
      );
      expect(compactProfile).toMatchObject({ enabled: true });
      expect(compactProfile?.description).toContain('durable batch checkpoints');
    }
  });

  it('maps secure-store secret status into catalog readiness without returning secret values', () => {
    const openAiStatus = secretStatus({ last4: 'abcd' });
    const endpointStatus = secretStatus({
      scope: 'tts_synthesis',
      providerId: 'local-endpoint',
      secretName: 'endpoint_url',
      source: 'android_secure_store',
      last4: undefined,
    });

    const catalog = desktopProviderCatalog([openAiStatus, endpointStatus], 'tauri-mobile');
    const openAi = catalog.aiProviders.find((provider) => provider.providerId === 'openai');
    const localEndpoint = catalog.ttsProviders.find((provider) => provider.providerId === 'local-endpoint');
    const elevenLabs = catalog.ttsProviders.find((provider) => provider.providerId === 'elevenlabs');

    expect(openAi?.secretStatus).toEqual(openAiStatus);
    expect(openAi?.secretConfigured).toBe(true);
    expect(openAi && catalogProviderReady(openAi)).toBe(true);
    expect(localEndpoint?.secretStatus).toEqual(endpointStatus);
    expect(localEndpoint && catalogProviderReady(localEndpoint)).toBe(true);
    expect(elevenLabs && catalogProviderReady(elevenLabs)).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain('sk-');
  });

  it('keeps Android default local settings away from file-path Vertex credentials', () => {
    const desktopDefaults = desktopLocalProviderSettingsBundle('tauri-desktop', '2026-07-06T00:00:00.000Z');
    const mobileDefaults = desktopLocalProviderSettingsBundle('tauri-mobile', '2026-07-06T00:00:00.000Z');

    expect(desktopDefaults.llmLabeling.enabledProviderIds).toContain('gemini-vertex');
    expect(mobileDefaults.llmLabeling.enabledProviderIds).not.toContain('gemini-vertex');
    expect(mobileDefaults.llmLabeling.providerOptionsByProvider['gemini-vertex']).toEqual({ location: 'global' });
  });

  it('round-trips non-secret local provider settings through injected storage', () => {
    const storage = memoryStorage();
    const bundle = desktopLocalProviderSettingsBundle('tauri-mobile', '2026-07-06T00:00:00.000Z');
    const nextBundle = {
      ...bundle,
      llmLabeling: {
        ...bundle.llmLabeling,
        modelByProvider: { ...bundle.llmLabeling.modelByProvider, openai: 'custom-model' },
      },
    };

    saveDesktopLocalProviderSettings(nextBundle, storage);
    const loaded = loadDesktopLocalProviderSettings('tauri-mobile', storage);

    expect(loaded.llmLabeling.modelByProvider.openai).toBe('custom-model');
    expect(JSON.stringify(loaded)).not.toMatch(/api[_-]?key|credential_path|endpoint_url/i);
  });

  it('centralizes default secret names, status labels, and replacement', () => {
    expect(defaultProviderSecretName('llm_labeling', 'openai')).toBe('api_key');
    expect(defaultProviderSecretName('llm_labeling', 'gemini-vertex')).toBe('credential_path');
    expect(defaultProviderSecretName('tts_synthesis', 'local-endpoint')).toBe('endpoint_url');
    expect(providerSecretDraftKey('tts_synthesis', 'local-endpoint', 'endpoint_url')).toBe(
      'tts_synthesis:local-endpoint:endpoint_url',
    );

    const initial = secretStatus({ last4: '1111' });
    const replacement = secretStatus({ configured: false, last4: undefined });
    expect(replaceSecretStatus([initial], replacement)).toEqual([replacement]);
    expect(providerSecretCanDelete(initial)).toBe(true);
    expect(providerSecretCanDelete(secretStatus({ source: 'env' }))).toBe(false);
    expect(providerSecretStatusLabel(undefined)).toBe('미설정');
    expect(providerSecretStatusLabel(secretStatus({ source: 'android_secure_store', last4: undefined }))).toBe(
      'Android 저장',
    );
  });
});
