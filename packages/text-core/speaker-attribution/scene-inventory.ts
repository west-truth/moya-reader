import { persistentId128, structuredIntegrityHash } from '../hash';
import {
  SPEAKER_SCENE_INVENTORY_VERSION,
  type SpeakerSceneInventoryV1,
  type SpeakerSceneV1,
  type SpeakerSourceParagraphInput,
} from './contracts';

export const DEFAULT_SCENE_DETECTOR_VERSION = 'speaker-scene-detector-v1';

function separator(text: string): boolean {
  const trimmed = text.trim();
  return /^(?:[-=*~·•]{3,}|[＊*]{3,}|[━─]{3,})$/u.test(trimmed);
}

function sectionHeading(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 100) return false;
  if (/^(?:#{1,6}\s+|(?:scene|chapter|part|장면|막|부)\s*[0-9IVX가-힣]*\b)/iu.test(trimmed)) return true;
  const bracketed =
    (trimmed.startsWith('<') && trimmed.endsWith('>')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!bracketed) return false;
  const inner = trimmed.slice(1, -1);
  return inner.length > 0 && inner.length <= 80 && !['<', '>', '[', ']', '\n'].some((value) => inner.includes(value));
}

export function buildSpeakerSceneInventory(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly detectorVersion?: string;
  readonly sourceGapThreshold?: number;
}): SpeakerSceneInventoryV1 {
  const detectorVersion = input.detectorVersion ?? DEFAULT_SCENE_DETECTOR_VERSION;
  const paragraphs = [...input.paragraphs].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const starts: Array<{ index: number; code: SpeakerSceneV1['boundaryCode'] }> = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    if (index === 0) {
      starts.push({ index, code: 'chapter_start' });
      continue;
    }
    const previous = paragraphs[index - 1]!;
    if (separator(paragraph.text)) starts.push({ index, code: 'separator' });
    else if (sectionHeading(paragraph.text)) starts.push({ index, code: 'section_heading' });
    else if (paragraph.startOffsetInChapter - previous.endOffsetInChapter > (input.sourceGapThreshold ?? 3)) {
      starts.push({ index, code: 'source_gap' });
    }
  }

  const scenes = starts.map<SpeakerSceneV1>((start, sceneIndex) => {
    const next = starts[sceneIndex + 1]?.index ?? paragraphs.length;
    const sceneParagraphs = paragraphs.slice(start.index, next);
    const paragraphIds = sceneParagraphs.map((paragraph) => paragraph.paragraphId);
    const core = {
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      chapterId: input.chapterId,
      chapterIndex: input.chapterIndex,
      sceneIndex,
      firstParagraphId: paragraphIds[0]!,
      lastParagraphId: paragraphIds.at(-1)!,
      paragraphIds,
      boundaryCode: start.code,
      detectorVersion,
    };
    const fingerprint = structuredIntegrityHash(core);
    return {
      ...core,
      id: persistentId128('speaker_scene', [
        input.contentRevisionId,
        input.chapterId,
        core.firstParagraphId,
        core.lastParagraphId,
        detectorVersion,
      ]),
      fingerprint,
    };
  });
  const core = {
    version: SPEAKER_SCENE_INVENTORY_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    detectorVersion,
    scenes,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('speaker_scene_inventory', [input.contentRevisionId, input.chapterId, fingerprint]),
    fingerprint,
  };
}
