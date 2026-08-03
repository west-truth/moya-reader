import { integrityHash, persistentId128 } from '../id-hash-contract';
import { matchesStructuredIntegrityHash, structuredIntegrityHash, textIntegrityHash } from './structured-integrity';

export function ttsInputTextIntegrityHash(text: string): string {
  return textIntegrityHash(text);
}

export function ttsProviderOptionsIntegrityHash(options: unknown): string {
  return structuredIntegrityHash(options);
}

export function ttsRenderSpecIntegrityHash(spec: unknown): string {
  return structuredIntegrityHash(spec);
}

export function matchesTTSRenderSpecIntegrityHash(value: string, spec: unknown): boolean {
  return matchesStructuredIntegrityHash(value, spec, ['render_']);
}

export function ttsAudioIntegrityHash(audio: Uint8Array | ArrayBuffer): string {
  return integrityHash(audio);
}

export function ttsCacheKey(identity: unknown): string {
  return persistentId128('tts', [structuredIntegrityHash(identity)]);
}

export function ttsAudioCacheRowId(novelId: string, chapterId: string, cacheKey: string): string {
  return persistentId128('tts_audio_cache', [novelId, chapterId, cacheKey]);
}

export function hostedTTSRequestKey(chapterId: string, request: unknown): string {
  return persistentId128('hosted_tts_request', [chapterId, structuredIntegrityHash(request)]);
}
