import { canonicalJson } from '../domain/canonical-json';
import { ttsCacheKey, ttsProviderOptionsIntegrityHash } from '../domain/identity/tts-identities';

export interface TTSCacheKeyInput {
  novelId: string;
  chapterId: string;
  segmentIds: string[];
  speakerId: string;
  voiceProfileId: string;
  providerId: string;
  providerModel?: string;
  providerVersion?: string;
  inputTextHash: string;
  optionsHash: string;
  renderSpecHash?: string;
}

export const stableProviderJson = canonicalJson;

export async function buildTTSCacheKey(input: TTSCacheKeyInput): Promise<string> {
  return ttsCacheKey({
    novelId: input.novelId,
    chapterId: input.chapterId,
    segmentIds: input.segmentIds,
    speakerId: input.speakerId,
    voiceProfileId: input.voiceProfileId,
    providerId: input.providerId,
    providerModel: input.providerModel ?? '',
    providerVersion: input.providerVersion ?? '',
    inputTextHash: input.inputTextHash,
    optionsHash: input.optionsHash,
    renderSpecHash: input.renderSpecHash ?? '',
  });
}

export async function buildProviderOptionsHash(options: Record<string, unknown>): Promise<string> {
  return ttsProviderOptionsIntegrityHash(options);
}
