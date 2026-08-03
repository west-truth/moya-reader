import type { PlatformRuntimeKind } from '../../platform/runtime';
import { desktopProviderCatalog, loadDesktopLocalProviderSettings } from '../../providers/desktop-provider-catalog';
import { createProviderSettingsDraft } from '../../providers/provider-settings-ui';

export type ProviderSampleFormat = 'mp3' | 'wav' | 'pcm' | 'ogg' | 'opus' | 'aac' | 'flac';

export function normalizeProviderSampleFormat(value: unknown): ProviderSampleFormat {
  return typeof value === 'string' && ['mp3', 'wav', 'pcm', 'ogg', 'opus', 'aac', 'flac'].includes(value)
    ? (value as ProviderSampleFormat)
    : 'mp3';
}

export function createProviderControllerInitialState(desktopMode: boolean, platformKind: PlatformRuntimeKind) {
  if (!desktopMode) return { bundle: undefined, catalog: undefined, drafts: {} } as const;
  const bundle = loadDesktopLocalProviderSettings(platformKind);
  const catalog = desktopProviderCatalog([], platformKind);
  return {
    bundle,
    catalog,
    drafts: {
      llm_labeling: createProviderSettingsDraft(bundle.llmLabeling, catalog.aiProviders),
      tts_synthesis: createProviderSettingsDraft(bundle.ttsSynthesis, catalog.ttsProviders),
    },
  } as const;
}
