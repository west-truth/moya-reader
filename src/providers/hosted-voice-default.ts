import type { RemoteProviderSettings } from '../services/remote/remote-api-client';

export function defaultHostedVoiceId(
  providerId: string | undefined,
  settings: RemoteProviderSettings | undefined,
): string {
  if (!providerId) return 'default';
  const optionVoice = settings?.providerOptionsByProvider[providerId]?.voice;
  if (typeof optionVoice === 'string' && optionVoice.trim()) return optionVoice.trim();
  return providerId === 'openai-tts' ? 'alloy' : 'default';
}
