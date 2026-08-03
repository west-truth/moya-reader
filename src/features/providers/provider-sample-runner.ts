import type { BrowserAudioSession } from '../../providers/browser-audio-session';
import { synthesizeDesktopTTS } from '../../providers/desktop-tts-provider';
import type { ProviderCatalogItem } from '../../providers/provider-jobs';
import {
  buildProviderDraftOptionsForProvider,
  catalogProviderReady,
  providerOptionValueFromRecord,
  type ProviderSettingsDraft,
} from '../../providers/provider-settings-ui';
import type { TTSVoice } from '../../providers/tts';
import { normalizeProviderSampleFormat } from './provider-sample-format';

export class ProviderSampleInputError extends Error {
  readonly code = 'provider_sample_input';
}

export async function runDesktopLLMSampleRequest(provider: ProviderCatalogItem, draft: ProviderSettingsDraft) {
  if (provider.kind !== 'llm' || !catalogProviderReady(provider))
    throw new ProviderSampleInputError('Provider 키와 종류를 확인하세요.');
  const options = buildProviderDraftOptionsForProvider(draft, provider.providerId);
  const modelId = (
    draft.modelByProvider[provider.providerId] ||
    provider.models.find((item) => item.enabled)?.modelId ||
    ''
  ).trim();
  if (!options.ok || !modelId) throw new ProviderSampleInputError('Provider 모델과 옵션을 확인하세요.');
  const { runDesktopStructuredJsonSample } = await import('../../providers/desktop-structured-json-provider');
  await runDesktopStructuredJsonSample({
    providerId: provider.providerId,
    modelId,
    providerOptions: options.options ?? {},
  });
}

export async function playDesktopTTSSampleRequest(input: {
  provider: ProviderCatalogItem;
  draft: ProviderSettingsDraft;
  voices: readonly TTSVoice[];
  audio: BrowserAudioSession;
  text: string;
  voiceId?: string;
}): Promise<boolean> {
  const { provider, draft } = input;
  if (provider.providerId === 'system' || provider.kind === 'system_tts' || !catalogProviderReady(provider))
    throw new ProviderSampleInputError('클라우드 또는 local endpoint TTS provider를 확인하세요.');
  const built = buildProviderDraftOptionsForProvider(draft, provider.providerId);
  if (!built.ok) throw new ProviderSampleInputError('Provider 옵션을 확인하세요.');
  const options = built.options ?? {};
  const optionVoice = providerOptionValueFromRecord(options, 'voice');
  const voiceId =
    input.voiceId?.trim() ||
    (typeof optionVoice === 'string' && optionVoice.trim() ? optionVoice.trim() : input.voices[0]?.id);
  if (provider.providerId === 'elevenlabs' && !voiceId)
    throw new ProviderSampleInputError('ElevenLabs voice를 먼저 선택하세요.');
  const modelId = (
    draft.modelByProvider[provider.providerId] ||
    provider.models.find((item) => item.enabled)?.modelId ||
    ''
  ).trim();
  const result = await synthesizeDesktopTTS({
    providerId: provider.providerId,
    modelId: modelId || undefined,
    text: input.text,
    voiceId,
    speed: 1,
    emotion: 'neutral',
    tone: 'clear',
    format: normalizeProviderSampleFormat(providerOptionValueFromRecord(options, 'format')),
    providerOptions: options,
  });
  return input.audio.playBlob(new Blob([result.audio], { type: result.contentType }));
}
