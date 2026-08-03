import type { Chapter, VoiceProfile } from '../../../domain/types';
import { buildHostedTTSCacheRequest } from '../../../providers/hosted-tts-playback';
import { hostedTTSCacheRequestKey } from '../../../providers/hosted-tts-prefetch';
import type { HostedTTSWarmupRequest } from '../../../providers/hosted-tts-warmup';
import type { TTSCapabilitySnapshot } from '../../../providers/provider-capability';
import {
  fixedDocumentTtsParagraph,
  fixedDocumentTtsSegment,
  fixedDocumentTtsSourceRange,
  type FixedDocumentPlayable,
} from './fixed-document-tts';

export interface BuildFixedDocumentTtsWarmupRequestsInput {
  readonly queue: readonly FixedDocumentPlayable[];
  readonly chapters: readonly Chapter[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly contentRevision: string;
  readonly providerOptionsByProvider?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly modelByProvider?: Readonly<Record<string, string>>;
  readonly pronunciationRevisionId?: string;
  readonly pronunciationFingerprint?: string;
  readonly capability?: TTSCapabilitySnapshot;
  readonly voiceEntryFingerprintByVoiceId?: Readonly<Record<string, string>>;
  readonly maxRequests?: number;
}

export function buildFixedDocumentTtsWarmupRequests(
  input: BuildFixedDocumentTtsWarmupRequestsInput,
): HostedTTSWarmupRequest[] {
  const chapters = [...input.chapters].sort((left, right) => left.index - right.index);
  const maxRequests = Math.max(0, input.maxRequests ?? Number.POSITIVE_INFINITY);
  const seen = new Set<string>();
  const requests: HostedTTSWarmupRequest[] = [];
  for (const item of input.queue) {
    if (requests.length >= maxRequests) break;
    const chapter = chapters[item.block.pageIndex];
    if (!chapter) continue;
    const range = fixedDocumentTtsSourceRange(item.playable, item.block);
    const paragraph = fixedDocumentTtsParagraph(item.block, item.block.bookId, chapter.id);
    const sourceSegment = fixedDocumentTtsSegment(item.block, item.block.bookId, chapter.id, range);
    const cacheRequest = buildHostedTTSCacheRequest({
      paragraph,
      playable: item.playable,
      segments: [sourceSegment],
      voiceProfiles: [...input.voiceProfiles],
      contentRevision: input.contentRevision,
      chapterTextHash: chapter.textHash,
      providerOptionsByProvider: input.providerOptionsByProvider,
      modelByProvider: input.modelByProvider,
      pronunciationRevisionId: input.pronunciationRevisionId,
      pronunciationFingerprint: input.pronunciationFingerprint,
      capability: input.capability,
      voiceEntryFingerprintByVoiceId: input.voiceEntryFingerprintByVoiceId,
    });
    if (!cacheRequest) continue;
    const requestKey = hostedTTSCacheRequestKey(chapter.id, cacheRequest.request);
    if (seen.has(requestKey)) continue;
    seen.add(requestKey);
    requests.push({
      requestKey,
      chapterId: chapter.id,
      paragraphId: item.block.id,
      paragraphIndex: item.block.order,
      speakerLabel: item.playable.speakerLabel,
      text: cacheRequest.text,
      request: cacheRequest.request,
    });
  }
  return requests;
}
