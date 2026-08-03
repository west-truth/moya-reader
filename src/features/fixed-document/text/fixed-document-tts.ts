import { projectSpokenText } from '@noveldesk/text-core/spoken-text';
import { integrityHash } from '@noveldesk/text-core/hash';
import type {
  DocumentTextBlock,
  DocumentTextRevision,
  LabeledSegment,
  Paragraph,
  SpokenTextRule,
  VoiceProfile,
} from '../../../domain/types';
import type { PlayableTtsSegment } from '../../../providers/tts-playback';
import { splitPlayableTtsSegment } from '../../../providers/tts-sentence-planner';
import { clamp } from '../../../utils/format';
import { buildFixedTextSelection } from './fixed-text-selection';

export interface FixedDocumentPlayable {
  readonly block: DocumentTextBlock;
  readonly playable: PlayableTtsSegment;
}

export const MINIMUM_OCR_TTS_QUALITY = 0.45;

export interface FixedDocumentTtsSource {
  readonly revision: DocumentTextRevision;
  readonly blocks: readonly DocumentTextBlock[];
}

export interface SkippedFixedDocumentOcrSource {
  readonly revisionId: string;
  readonly pageIndex: number;
  readonly qualityScore?: number;
}

export function selectFixedDocumentTtsSources(
  sources: readonly FixedDocumentTtsSource[],
  minimumOcrQuality = MINIMUM_OCR_TTS_QUALITY,
): {
  readonly sources: readonly FixedDocumentTtsSource[];
  readonly skippedOcr: readonly SkippedFixedDocumentOcrSource[];
} {
  const accepted: FixedDocumentTtsSource[] = [];
  const skippedOcr: SkippedFixedDocumentOcrSource[] = [];
  for (const source of sources) {
    if (source.revision.source === 'ocr' && (source.revision.qualityScore ?? 0) < minimumOcrQuality) {
      skippedOcr.push({
        revisionId: source.revision.id,
        pageIndex: source.revision.pageIndex,
        qualityScore: source.revision.qualityScore,
      });
    } else {
      accepted.push(source);
    }
  }
  return { sources: accepted, skippedOcr };
}

export function buildFixedDocumentTtsQueue(input: {
  blocks: readonly DocumentTextBlock[];
  language?: string;
  rules?: readonly SpokenTextRule[];
  rate: number;
  voiceProfile?: VoiceProfile;
}): FixedDocumentPlayable[] {
  return [...input.blocks]
    .sort((left, right) => left.pageIndex - right.pageIndex || left.order - right.order)
    .flatMap((block) => {
      const projection = projectSpokenText({
        text: block.text,
        language: input.language,
        rules: input.rules,
        footnotePolicy: 'skip_marker',
      });
      if (!projection.spokenText) return [];
      const paragraph = fixedDocumentTtsParagraph(block, block.bookId, `fixed-page-${block.pageIndex}`);
      const playable: PlayableTtsSegment = {
        paragraphId: block.id,
        text: projection.spokenText,
        language: projection.language,
        sourceText: block.text,
        spokenTextFingerprint: projection.fingerprint,
        spokenTextSpans: projection.spans,
        speakerId: 'narrator',
        speakerLabel: '내레이터',
        emotion: 'neutral',
        contentType: 'narration',
        voiceProfileId: input.voiceProfile?.id,
        voiceURI: input.voiceProfile?.providerId === 'system' ? input.voiceProfile.providerVoiceId : undefined,
        rate: clamp(input.rate * (input.voiceProfile?.speed ?? 1), 0.25, 4),
        sourceSegmentIds: [block.id],
        sourceRanges: [
          {
            segmentId: block.id,
            paragraphId: block.id,
            startOffset: 0,
            endOffset: block.text.length,
          },
        ],
      };
      return splitPlayableTtsSegment(paragraph, playable).map((sentence) => ({ block, playable: sentence }));
    });
}

export function fixedDocumentTtsSourceRange(playable: PlayableTtsSegment, block: DocumentTextBlock) {
  const range = playable.sourceRanges.find((candidate) => candidate.paragraphId === block.id);
  const startOffset = clamp(range?.startOffset ?? 0, 0, block.text.length);
  return {
    startOffset,
    endOffset: clamp(range?.endOffset ?? block.text.length, startOffset, block.text.length),
  };
}

export function fixedDocumentTtsRangeQuads(block: DocumentTextBlock, startOffset: number, endOffset: number) {
  return [
    ...(buildFixedTextSelection({
      blocks: [block],
      startBlockId: block.id,
      startOffset,
      endBlockId: block.id,
      endOffset,
    })?.quads ?? block.quads),
  ];
}

export function fixedDocumentTtsParagraph(block: DocumentTextBlock, novelId: string, chapterId: string): Paragraph {
  return {
    id: block.id,
    novelId,
    chapterId,
    index: block.order,
    text: block.text,
    startOffsetInChapter: 0,
    endOffsetInChapter: block.text.length,
    textHash: integrityHash(block.text),
  };
}

export function fixedDocumentTtsSegment(
  block: DocumentTextBlock,
  novelId: string,
  chapterId: string,
  range: { readonly startOffset: number; readonly endOffset: number } = {
    startOffset: 0,
    endOffset: block.text.length,
  },
): LabeledSegment {
  const startOffset = clamp(range.startOffset, 0, block.text.length);
  const endOffset = clamp(range.endOffset, startOffset, block.text.length);
  return {
    id: block.id,
    novelId,
    chapterId,
    paragraphId: block.id,
    segmentIndex: block.order,
    startOffset,
    endOffset,
    segmentTextHash: integrityHash(block.text.slice(startOffset, endOffset)),
    type: 'narration',
    speakerId: 'narrator',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 1,
    isUserCorrected: false,
  };
}
