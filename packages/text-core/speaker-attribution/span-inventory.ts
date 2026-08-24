import { persistentId128, structuredIntegrityHash, textIntegrityHash } from '../hash';
import {
  SPEAKER_SPAN_INVENTORY_VERSION,
  type LockedSpeakerSpanV1,
  type SpeakerSceneInventoryV1,
  type SpeakerSourceParagraphInput,
  type SpeakerSpanInventoryV1,
  type SpeakerSpanType,
  type SpeakerSpanV1,
} from './contracts';

export const DEFAULT_SPAN_DETECTOR_VERSION = 'speaker-span-detector-v2';
export const BROAD_TTS_CANDIDATE_DETECTOR_VERSION = 'speaker-span-detector-v3-broad-tts-candidate';
export type SpeakerSpanDetectionProfile = 'strict_voice' | 'broad_tts_candidate';

const quotePairs = new Map([
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['〈', '〉'],
]);
const quoteClosers = new Set(quotePairs.values());

interface QuoteScan {
  readonly intervals: readonly { start: number; end: number }[];
  readonly ambiguous: boolean;
  readonly nested: boolean;
}

function scanQuotes(text: string): QuoteScan {
  const stack: Array<{ start: number; close: string }> = [];
  const intervals: Array<{ start: number; end: number }> = [];
  let ambiguous = false;
  let nested = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"' && text[index - 1] === '\\') continue;
    const top = stack.at(-1);
    if (top?.close === character) {
      stack.pop();
      if (stack.length === 0) intervals.push({ start: top.start, end: index + 1 });
      continue;
    }
    const close = quotePairs.get(character);
    if (close) {
      if (stack.length > 0) nested = true;
      stack.push({ start: stack.length === 0 ? index : stack[0]!.start, close });
      continue;
    }
    if (quoteClosers.has(character)) ambiguous = true;
  }
  if (stack.length > 0) ambiguous = true;
  return { intervals, ambiguous, nested };
}

function markerClassification(
  text: string,
  profile: SpeakerSpanDetectionProfile,
): { type: SpeakerSpanType; voiceBearing: boolean; speaker?: 'narrator' | 'system'; code: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) return { type: 'metadata', voiceBearing: false, speaker: 'narrator', code: 'blank' };
  if (/^(?:[-=*~·•]{3,}|[＊*]{3,}|[━─]{3,})$/u.test(trimmed)) {
    return { type: 'metadata', voiceBearing: false, speaker: 'narrator', code: 'separator' };
  }
  if (/^(?:#{1,6}\s+|(?:scene|chapter|part|장면|막|부)\s*[0-9IVX가-힣]*\b)/iu.test(trimmed)) {
    return { type: 'metadata', voiceBearing: false, speaker: 'narrator', code: 'section_heading' };
  }
  if (profile === 'broad_tts_candidate' && /^\[[^\]\r\n]+\]$/u.test(trimmed)) {
    return { type: 'unknown', voiceBearing: true, code: 'square_bracket_tts_candidate' };
  }
  if (profile === 'broad_tts_candidate' && /^(?:(?:ㄴ|└|┗|┖|┕|↳|>{1,3})\s*)\S/u.test(trimmed)) {
    return { type: 'message', voiceBearing: true, code: 'threaded_message_tts_candidate' };
  }
  if (/^\[(?:시스템|알림|공지|퀘스트|상태|system|notice|status)\b[^\]]*\]$/iu.test(trimmed)) {
    return { type: 'system', voiceBearing: true, speaker: 'system', code: 'system_marker' };
  }
  if (/^(?:띠링|띠롱|쾅|쿵|철컥|탁|퍽|bang|boom|click)[!?.…~\s]*$/iu.test(trimmed)) {
    return { type: 'sfx', voiceBearing: false, speaker: 'system', code: 'sfx_marker' };
  }
  if (/^(?:[-—―]\s*\S|[\p{L}\p{N}_ -]{1,20}\s*[:：>]\s*\S)/u.test(trimmed)) {
    return { type: 'message', voiceBearing: true, code: 'explicit_dialogue_line' };
  }
  if (/^\([^\n]+\)$/u.test(trimmed)) {
    return { type: 'inner_monologue', voiceBearing: true, code: 'parenthesized_thought' };
  }
  return undefined;
}

export function speakerSpanId(input: {
  readonly contentRevisionId: string;
  readonly paragraphId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textHash: string;
  readonly detectorVersion: string;
}): string {
  return persistentId128('speaker_span', [
    input.contentRevisionId,
    input.paragraphId,
    String(input.startOffset),
    String(input.endOffset),
    input.textHash,
    input.detectorVersion,
  ]);
}

function span(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly sceneId: string;
  readonly spanIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly type: SpeakerSpanType;
  readonly voiceBearing: boolean;
  readonly boundaryReview: boolean;
  readonly boundaryCode: string;
  readonly deterministicSpeaker?: 'narrator' | 'system';
  readonly lockedCorrectionId?: string;
  readonly detectorVersion: string;
}): SpeakerSpanV1 {
  const textHash = textIntegrityHash(input.text.slice(input.startOffset, input.endOffset));
  return {
    id: speakerSpanId({ ...input, textHash }),
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    paragraphId: input.paragraphId,
    sceneId: input.sceneId,
    spanIndex: input.spanIndex,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    textHash,
    type: input.type,
    voiceBearing: input.voiceBearing,
    boundaryReview: input.boundaryReview,
    boundaryCode: input.boundaryCode,
    deterministicSpeaker: input.deterministicSpeaker,
    lockedCorrectionId: input.lockedCorrectionId,
  };
}

function lockedParagraphSpans(
  paragraph: SpeakerSourceParagraphInput,
  locks: readonly LockedSpeakerSpanV1[],
): readonly LockedSpeakerSpanV1[] | undefined {
  const rows = locks
    .filter((item) => item.paragraphId === paragraph.paragraphId)
    .sort((left, right) => left.startOffset - right.startOffset);
  if (rows.length === 0) return undefined;
  let nextOffset = 0;
  for (const row of rows) {
    if (
      row.startOffset !== nextOffset ||
      row.endOffset <= row.startOffset ||
      row.endOffset > paragraph.text.length ||
      textIntegrityHash(paragraph.text.slice(row.startOffset, row.endOffset)) !== row.textHash
    ) {
      return undefined;
    }
    nextOffset = row.endOffset;
  }
  return nextOffset === paragraph.text.length ? rows : undefined;
}

function voiceBearing(type: SpeakerSpanType): boolean {
  return ['dialogue', 'inner_monologue', 'message', 'system', 'unknown'].includes(type);
}

function deterministicSpeaker(type: SpeakerSpanType, speakerId?: string): 'narrator' | 'system' | undefined {
  if (speakerId === 'narrator' || speakerId === 'system') return speakerId;
  if (type === 'narration' || type === 'metadata') return 'narrator';
  if (type === 'system' || type === 'sfx') return 'system';
  return undefined;
}

export function createSpeakerSpanInventory(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly detectorVersion: string;
  readonly spans: readonly SpeakerSpanV1[];
}): SpeakerSpanInventoryV1 {
  const spans = [...input.spans]
    .sort((left, right) => left.spanIndex - right.spanIndex)
    .map((item, spanIndex) => ({ ...item, spanIndex }));
  const core = {
    version: SPEAKER_SPAN_INVENTORY_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    detectorVersion: input.detectorVersion,
    spans,
    boundaryReviewSpanIds: spans.filter((item) => item.boundaryReview).map((item) => item.id),
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('speaker_span_inventory', [input.contentRevisionId, input.chapterId, fingerprint]),
    fingerprint,
  };
}

export function buildSpeakerSpanInventory(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly sceneInventory: SpeakerSceneInventoryV1;
  readonly lockedSpans?: readonly LockedSpeakerSpanV1[];
  readonly detectorVersion?: string;
  readonly detectionProfile?: SpeakerSpanDetectionProfile;
}): SpeakerSpanInventoryV1 {
  const detectionProfile = input.detectionProfile ?? 'strict_voice';
  const detectorVersion =
    input.detectorVersion ??
    (detectionProfile === 'broad_tts_candidate' ? BROAD_TTS_CANDIDATE_DETECTOR_VERSION : DEFAULT_SPAN_DETECTOR_VERSION);
  const sceneByParagraph = new Map(
    input.sceneInventory.scenes.flatMap((scene) => scene.paragraphIds.map((paragraphId) => [paragraphId, scene.id])),
  );
  const spans: SpeakerSpanV1[] = [];
  const paragraphs = [...input.paragraphs].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  for (const paragraph of paragraphs) {
    const sceneId = sceneByParagraph.get(paragraph.paragraphId);
    if (!sceneId) throw new Error(`Paragraph ${paragraph.paragraphId} is outside the scene inventory`);
    const locks = lockedParagraphSpans(paragraph, input.lockedSpans ?? []);
    if (locks) {
      for (const lock of locks) {
        spans.push(
          span({
            ...input,
            paragraphId: paragraph.paragraphId,
            sceneId,
            spanIndex: spans.length,
            startOffset: lock.startOffset,
            endOffset: lock.endOffset,
            text: paragraph.text,
            type: lock.type,
            voiceBearing: voiceBearing(lock.type),
            boundaryReview: false,
            boundaryCode: 'locked_correction',
            deterministicSpeaker: deterministicSpeaker(lock.type, lock.speakerId),
            lockedCorrectionId: lock.correctionId,
            detectorVersion,
          }),
        );
      }
      continue;
    }

    const marker = markerClassification(paragraph.text, detectionProfile);
    if (marker) {
      spans.push(
        span({
          ...input,
          paragraphId: paragraph.paragraphId,
          sceneId,
          spanIndex: spans.length,
          startOffset: 0,
          endOffset: paragraph.text.length,
          text: paragraph.text,
          type: marker.type,
          voiceBearing: marker.voiceBearing,
          boundaryReview: false,
          boundaryCode: marker.code,
          deterministicSpeaker: marker.speaker,
          detectorVersion,
        }),
      );
      continue;
    }

    const quoteScan = scanQuotes(paragraph.text);
    if (quoteScan.ambiguous) {
      spans.push(
        span({
          ...input,
          paragraphId: paragraph.paragraphId,
          sceneId,
          spanIndex: spans.length,
          startOffset: 0,
          endOffset: paragraph.text.length,
          text: paragraph.text,
          type: 'unknown',
          voiceBearing: true,
          boundaryReview: true,
          boundaryCode: 'unbalanced_or_mismatched_quote',
          detectorVersion,
        }),
      );
      continue;
    }
    if (quoteScan.intervals.length > 0) {
      const hasNarration = quoteScan.intervals.some(
        (interval, index) =>
          paragraph.text.slice(index === 0 ? 0 : quoteScan.intervals[index - 1]!.end, interval.start).trim() ||
          (index === quoteScan.intervals.length - 1 && paragraph.text.slice(interval.end).trim()),
      );
      const review = quoteScan.nested;
      const dialogueBoundaryCode = quoteScan.nested
        ? 'nested_quote'
        : quoteScan.intervals.length > 1
          ? 'balanced_multi_quote'
          : hasNarration
            ? 'balanced_quote_with_context'
            : 'balanced_quote';
      let nextOffset = 0;
      for (const interval of quoteScan.intervals) {
        if (interval.start > nextOffset) {
          spans.push(
            span({
              ...input,
              paragraphId: paragraph.paragraphId,
              sceneId,
              spanIndex: spans.length,
              startOffset: nextOffset,
              endOffset: interval.start,
              text: paragraph.text,
              type: 'narration',
              voiceBearing: false,
              boundaryReview: review,
              boundaryCode: 'quote_context',
              deterministicSpeaker: 'narrator',
              detectorVersion,
            }),
          );
        }
        spans.push(
          span({
            ...input,
            paragraphId: paragraph.paragraphId,
            sceneId,
            spanIndex: spans.length,
            startOffset: interval.start,
            endOffset: interval.end,
            text: paragraph.text,
            type: 'dialogue',
            voiceBearing: true,
            boundaryReview: review,
            boundaryCode: dialogueBoundaryCode,
            detectorVersion,
          }),
        );
        nextOffset = interval.end;
      }
      if (nextOffset < paragraph.text.length) {
        spans.push(
          span({
            ...input,
            paragraphId: paragraph.paragraphId,
            sceneId,
            spanIndex: spans.length,
            startOffset: nextOffset,
            endOffset: paragraph.text.length,
            text: paragraph.text,
            type: 'narration',
            voiceBearing: false,
            boundaryReview: review,
            boundaryCode: 'quote_context',
            deterministicSpeaker: 'narrator',
            detectorVersion,
          }),
        );
      }
      continue;
    }

    spans.push(
      span({
        ...input,
        paragraphId: paragraph.paragraphId,
        sceneId,
        spanIndex: spans.length,
        startOffset: 0,
        endOffset: paragraph.text.length,
        text: paragraph.text,
        type: 'narration',
        voiceBearing: false,
        boundaryReview: false,
        boundaryCode: 'narration_fallback',
        deterministicSpeaker: 'narrator',
        detectorVersion,
      }),
    );
  }
  const inventory = createSpeakerSpanInventory({ ...input, detectorVersion, spans });
  assertSpeakerSpanInventory(inventory, paragraphs);
  return inventory;
}

export function assertSpeakerSpanInventory(
  inventory: SpeakerSpanInventoryV1,
  paragraphs: readonly SpeakerSourceParagraphInput[],
): void {
  const paragraphById = new Map(paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  const byParagraph = new Map<string, SpeakerSpanV1[]>();
  for (const item of inventory.spans) {
    byParagraph.set(item.paragraphId, [...(byParagraph.get(item.paragraphId) ?? []), item]);
  }
  for (const paragraph of paragraphs) {
    const spans = (byParagraph.get(paragraph.paragraphId) ?? []).sort(
      (left, right) => left.startOffset - right.startOffset,
    );
    if (spans.length === 0) throw new Error(`Paragraph ${paragraph.paragraphId} has no speaker spans`);
    let nextOffset = 0;
    for (const item of spans) {
      if (
        item.startOffset !== nextOffset ||
        item.endOffset <= item.startOffset ||
        item.endOffset > paragraph.text.length
      ) {
        throw new Error(`Paragraph ${paragraph.paragraphId} has overlapping or incomplete speaker spans`);
      }
      if (textIntegrityHash(paragraph.text.slice(item.startOffset, item.endOffset)) !== item.textHash) {
        throw new Error(`Speaker span ${item.id} does not match source text`);
      }
      if (item.chapterId !== paragraph.chapterId || !paragraphById.has(item.paragraphId)) {
        throw new Error(`Speaker span ${item.id} has a stale source anchor`);
      }
      nextOffset = item.endOffset;
    }
    if (nextOffset !== paragraph.text.length) {
      throw new Error(`Paragraph ${paragraph.paragraphId} is not fully covered by speaker spans`);
    }
  }
}
