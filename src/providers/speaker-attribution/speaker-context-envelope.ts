import { structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
  SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { SourceMentionV1 } from './mention-inventory';
export const SPEAKER_CONTEXT_ENVELOPE_VERSION = 'speaker-context-envelope-v4' as const;

export const SpeakerContextRoleCode = {
  sameParagraphBefore: 0,
  sameParagraphAfter: 1,
  previousParagraph: 2,
  nextParagraph: 3,
  secondPreviousParagraph: 4,
  secondNextParagraph: 5,
  distantCandidateSource: 6,
} as const;

export type SpeakerContextRoleCodeV1 = (typeof SpeakerContextRoleCode)[keyof typeof SpeakerContextRoleCode];

export interface SpeakerContextEnvelopeV1 {
  readonly version: typeof SPEAKER_CONTEXT_ENVELOPE_VERSION;
  readonly blocks: readonly (readonly [
    blockOrdinal: number,
    paragraphId: string,
    paragraphIndex: number,
    startOffset: number,
    endOffset: number,
    paragraphTextHash: string,
    blockTextHash: string,
    text: string,
  ])[];
  readonly targets: readonly (readonly [
    targetPosition: number,
    blocks: readonly (readonly [roleCode: SpeakerContextRoleCodeV1, blockOrdinal: number])[],
  ])[];
  readonly fingerprint: string;
}

const SAME_PARAGRAPH_SIDE_CHARS = 320;
const ADJACENT_PARAGRAPH_CHARS = 480;
const SECOND_ADJACENT_PARAGRAPH_CHARS = 320;
const DISTANT_CANDIDATE_SOURCE_CHARS = 480;

function verifyParagraph(paragraph: SpeakerSourceParagraphInput): void {
  if (textIntegrityHash(paragraph.text) !== paragraph.textHash) {
    throw new Error(`Speaker context paragraph hash is stale: ${paragraph.paragraphId}`);
  }
}

function boundedAdjacentRange(
  paragraph: SpeakerSourceParagraphInput,
  direction: 'previous' | 'next',
  maximumChars = ADJACENT_PARAGRAPH_CHARS,
): readonly [number, number] {
  return direction === 'previous'
    ? [Math.max(0, paragraph.text.length - maximumChars), paragraph.text.length]
    : [0, Math.min(paragraph.text.length, maximumChars)];
}

export function buildSpeakerContextEnvelope(input: {
  readonly sceneId: string;
  readonly targets: readonly SpeakerSpanV1[];
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly supportingMentionsByTargetSpanId?: Readonly<Record<string, readonly SourceMentionV1[]>>;
}): SpeakerContextEnvelopeV1 {
  const sceneParagraphIds = new Set(
    input.spanInventory.spans.filter((span) => span.sceneId === input.sceneId).map((span) => span.paragraphId),
  );
  const sceneParagraphs = input.paragraphs
    .filter((paragraph) => sceneParagraphIds.has(paragraph.paragraphId))
    .sort(
      (left, right) => left.paragraphIndex - right.paragraphIndex || left.paragraphId.localeCompare(right.paragraphId),
    );
  const paragraphById = new Map(sceneParagraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  const spanById = new Map(input.spanInventory.spans.map((span) => [span.id, span]));
  const scenePositionByParagraphId = new Map(
    sceneParagraphs.map((paragraph, position) => [paragraph.paragraphId, position]),
  );
  const blocks: Array<SpeakerContextEnvelopeV1['blocks'][number]> = [];
  const blockOrdinalByRange = new Map<string, number>();

  const addBlock = (
    paragraph: SpeakerSourceParagraphInput,
    startOffset: number,
    endOffset: number,
  ): number | undefined => {
    if (startOffset < 0 || endOffset > paragraph.text.length || startOffset >= endOffset) return undefined;
    const text = paragraph.text.slice(startOffset, endOffset);
    if (!text.trim()) return undefined;
    verifyParagraph(paragraph);
    const key = `${paragraph.paragraphId}:${startOffset}:${endOffset}`;
    const existing = blockOrdinalByRange.get(key);
    if (existing !== undefined) return existing;
    const ordinal = blocks.length;
    blocks.push([
      ordinal,
      paragraph.paragraphId,
      paragraph.paragraphIndex,
      startOffset,
      endOffset,
      paragraph.textHash,
      textIntegrityHash(text),
      text,
    ]);
    blockOrdinalByRange.set(key, ordinal);
    return ordinal;
  };

  const targets = input.targets.map((target, targetPosition) => {
    const paragraph = paragraphById.get(target.paragraphId);
    if (!paragraph) throw new Error(`Speaker context target has no scene paragraph: ${target.id}`);
    const references: Array<readonly [SpeakerContextRoleCodeV1, number]> = [];
    const addReference = (
      roleCode: SpeakerContextRoleCodeV1,
      source: SpeakerSourceParagraphInput,
      startOffset: number,
      endOffset: number,
    ) => {
      const ordinal = addBlock(source, startOffset, endOffset);
      if (ordinal !== undefined) references.push([roleCode, ordinal]);
    };

    addReference(
      SpeakerContextRoleCode.sameParagraphBefore,
      paragraph,
      Math.max(0, target.startOffset - SAME_PARAGRAPH_SIDE_CHARS),
      target.startOffset,
    );
    addReference(
      SpeakerContextRoleCode.sameParagraphAfter,
      paragraph,
      target.endOffset,
      Math.min(paragraph.text.length, target.endOffset + SAME_PARAGRAPH_SIDE_CHARS),
    );

    const scenePosition = scenePositionByParagraphId.get(target.paragraphId);
    if (scenePosition === undefined) throw new Error(`Speaker context scene order is missing: ${target.id}`);
    const previous = sceneParagraphs[scenePosition - 1];
    if (previous) {
      const [startOffset, endOffset] = boundedAdjacentRange(previous, 'previous');
      addReference(SpeakerContextRoleCode.previousParagraph, previous, startOffset, endOffset);
    }
    const next = sceneParagraphs[scenePosition + 1];
    if (next) {
      const [startOffset, endOffset] = boundedAdjacentRange(next, 'next');
      addReference(SpeakerContextRoleCode.nextParagraph, next, startOffset, endOffset);
    }
    const secondPrevious = sceneParagraphs[scenePosition - 2];
    if (secondPrevious) {
      const [startOffset, endOffset] = boundedAdjacentRange(
        secondPrevious,
        'previous',
        SECOND_ADJACENT_PARAGRAPH_CHARS,
      );
      addReference(SpeakerContextRoleCode.secondPreviousParagraph, secondPrevious, startOffset, endOffset);
    }
    const secondNext = sceneParagraphs[scenePosition + 2];
    if (secondNext) {
      const [startOffset, endOffset] = boundedAdjacentRange(secondNext, 'next', SECOND_ADJACENT_PARAGRAPH_CHARS);
      addReference(SpeakerContextRoleCode.secondNextParagraph, secondNext, startOffset, endOffset);
    }
    const supportingMentions = input.supportingMentionsByTargetSpanId?.[target.id] ?? [];
    if (supportingMentions.length > 2) {
      throw new Error(`Speaker context has too many distant candidate sources: ${target.id}`);
    }
    for (const mention of supportingMentions) {
      const sourceSpan = spanById.get(mention.spanId);
      if (
        mention.sceneId !== input.sceneId ||
        !sourceSpan ||
        sourceSpan.sceneId !== input.sceneId ||
        sourceSpan.spanIndex >= target.spanIndex
      ) {
        throw new Error(`Speaker context distant candidate source is invalid for target: ${target.id}`);
      }
      const source = paragraphById.get(sourceSpan.paragraphId);
      if (!source) throw new Error(`Speaker context distant candidate paragraph is missing: ${mention.id}`);
      const sourceText = source.text.slice(sourceSpan.startOffset, sourceSpan.endOffset);
      if (textIntegrityHash(sourceText) !== sourceSpan.textHash) {
        throw new Error(`Speaker context distant candidate source hash is stale: ${mention.id}`);
      }
      let startOffset = sourceSpan.startOffset;
      let endOffset = sourceSpan.endOffset;
      if (endOffset - startOffset > DISTANT_CANDIDATE_SOURCE_CHARS) {
        startOffset = Math.max(sourceSpan.startOffset, mention.startOffset - 160);
        endOffset = Math.min(sourceSpan.endOffset, startOffset + DISTANT_CANDIDATE_SOURCE_CHARS);
        if (endOffset < mention.endOffset) {
          endOffset = mention.endOffset;
          startOffset = Math.max(sourceSpan.startOffset, endOffset - DISTANT_CANDIDATE_SOURCE_CHARS);
        }
      }
      addReference(SpeakerContextRoleCode.distantCandidateSource, source, startOffset, endOffset);
    }
    return [targetPosition, references] as const;
  });

  const core = { version: SPEAKER_CONTEXT_ENVELOPE_VERSION, blocks, targets };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}

export function sliceSpeakerContextEnvelope(
  envelope: SpeakerContextEnvelopeV1,
  retainedTargetPositions: readonly number[],
): SpeakerContextEnvelopeV1 {
  const retained = new Set(retainedTargetPositions);
  const originalToLocalTarget = new Map(retainedTargetPositions.map((position, local) => [position, local]));
  const retainedTargets = envelope.targets.filter(([targetPosition]) => retained.has(targetPosition));
  const usedBlockOrdinals = new Set(
    retainedTargets.flatMap(([, references]) => references.map(([, ordinal]) => ordinal)),
  );
  const retainedBlocks = envelope.blocks.filter(([ordinal]) => usedBlockOrdinals.has(ordinal));
  const localBlockOrdinalByOriginal = new Map(retainedBlocks.map(([ordinal], local) => [ordinal, local]));
  const blocks = retainedBlocks.map(
    ([, paragraphId, paragraphIndex, startOffset, endOffset, paragraphTextHash, blockTextHash, text], local) =>
      [local, paragraphId, paragraphIndex, startOffset, endOffset, paragraphTextHash, blockTextHash, text] as const,
  );
  const targets = retainedTargets.map(
    ([targetPosition, references]) =>
      [
        originalToLocalTarget.get(targetPosition)!,
        references.map(
          ([roleCode, blockOrdinal]) => [roleCode, localBlockOrdinalByOriginal.get(blockOrdinal)!] as const,
        ),
      ] as const,
  );
  const core = { version: SPEAKER_CONTEXT_ENVELOPE_VERSION, blocks, targets };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}
