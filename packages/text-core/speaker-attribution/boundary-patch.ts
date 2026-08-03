import { persistentId128, structuredIntegrityHash, textIntegrityHash } from '../hash';
import {
  SPAN_BOUNDARY_PATCH_VERSION,
  type SpanBoundaryPatchOperationV1,
  type SpanBoundaryPatchV1,
  type SpeakerSourceParagraphInput,
  type SpeakerSpanInventoryV1,
  type SpeakerSpanType,
  type SpeakerSpanV1,
} from './contracts';
import { assertSpeakerSpanInventory, createSpeakerSpanInventory, speakerSpanId } from './span-inventory';

function isVoiceBearing(type: SpeakerSpanType): boolean {
  return ['dialogue', 'inner_monologue', 'message', 'system', 'unknown'].includes(type);
}

function fixedSpeaker(type: SpeakerSpanType): 'narrator' | 'system' | undefined {
  if (type === 'narration' || type === 'metadata') return 'narrator';
  if (type === 'system' || type === 'sfx') return 'system';
  return undefined;
}

export function buildSpanBoundaryPatch(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly expectedInventoryHash: string;
  readonly operations: readonly SpanBoundaryPatchOperationV1[];
  readonly createdBy: SpanBoundaryPatchV1['createdBy'];
  readonly createdAt: string;
}): SpanBoundaryPatchV1 {
  const core = {
    version: SPAN_BOUNDARY_PATCH_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    expectedInventoryHash: input.expectedInventoryHash,
    operations: input.operations,
    createdBy: input.createdBy,
    createdAt: new Date(input.createdAt).toISOString(),
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('span_boundary_patch', [input.contentRevisionId, input.chapterId, fingerprint]),
    fingerprint,
  };
}

function rebuiltSpan(
  source: SpeakerSpanV1,
  paragraphText: string,
  startOffset: number,
  endOffset: number,
  type: SpeakerSpanType,
  detectorVersion: string,
): SpeakerSpanV1 {
  const textHash = textIntegrityHash(paragraphText.slice(startOffset, endOffset));
  return {
    ...source,
    id: speakerSpanId({
      contentRevisionId: source.contentRevisionId,
      paragraphId: source.paragraphId,
      startOffset,
      endOffset,
      textHash,
      detectorVersion,
    }),
    startOffset,
    endOffset,
    textHash,
    type,
    voiceBearing: isVoiceBearing(type),
    boundaryReview: false,
    boundaryCode: 'boundary_patch',
    deterministicSpeaker: fixedSpeaker(type),
    lockedCorrectionId: undefined,
  };
}

export function applySpanBoundaryPatch(input: {
  readonly inventory: SpeakerSpanInventoryV1;
  readonly patch: SpanBoundaryPatchV1;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
}): SpeakerSpanInventoryV1 {
  if (input.patch.expectedInventoryHash !== input.inventory.fingerprint) {
    throw new Error('Span boundary patch targets a stale inventory');
  }
  if (
    input.patch.bookId !== input.inventory.bookId ||
    input.patch.contentRevisionId !== input.inventory.contentRevisionId ||
    input.patch.chapterId !== input.inventory.chapterId
  ) {
    throw new Error('Span boundary patch source identity does not match the inventory');
  }
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  const spans = [...input.inventory.spans];
  for (const operation of input.patch.operations) {
    if (operation.kind === 'split') {
      const index = spans.findIndex((span) => span.id === operation.spanId);
      if (index < 0) throw new Error(`Split span ${operation.spanId} was not found`);
      const source = spans[index]!;
      const paragraph = paragraphById.get(source.paragraphId);
      if (!paragraph) throw new Error(`Split span ${source.id} has no source paragraph`);
      const offsets = [...new Set(operation.splitOffsets)].sort((left, right) => left - right);
      if (offsets.some((offset) => offset <= source.startOffset || offset >= source.endOffset)) {
        throw new Error(`Split span ${source.id} has an invalid split offset`);
      }
      const boundaries = [source.startOffset, ...offsets, source.endOffset];
      if (operation.resultTypes && operation.resultTypes.length !== boundaries.length - 1) {
        throw new Error(`Split span ${source.id} result type count is invalid`);
      }
      const replacements = boundaries
        .slice(0, -1)
        .map((startOffset, partIndex) =>
          rebuiltSpan(
            source,
            paragraph.text,
            startOffset,
            boundaries[partIndex + 1]!,
            operation.resultTypes?.[partIndex] ?? source.type,
            input.inventory.detectorVersion,
          ),
        );
      spans.splice(index, 1, ...replacements);
      continue;
    }

    if (operation.spanIds.length < 2) throw new Error('A merge patch requires at least two spans');
    const indexes = operation.spanIds.map((id) => spans.findIndex((span) => span.id === id));
    if (indexes.some((index) => index < 0)) throw new Error('A merge patch references a missing span');
    const sortedIndexes = [...indexes].sort((left, right) => left - right);
    if (sortedIndexes.some((index, itemIndex) => itemIndex > 0 && index !== sortedIndexes[itemIndex - 1]! + 1)) {
      throw new Error('A merge patch requires consecutive spans');
    }
    const selected = sortedIndexes.map((index) => spans[index]!);
    const first = selected[0]!;
    const last = selected.at(-1)!;
    if (selected.some((span) => span.paragraphId !== first.paragraphId || span.sceneId !== first.sceneId)) {
      throw new Error('A merge patch cannot cross paragraph or scene boundaries');
    }
    const paragraph = paragraphById.get(first.paragraphId);
    if (!paragraph) throw new Error(`Merge span ${first.id} has no source paragraph`);
    const replacement = rebuiltSpan(
      first,
      paragraph.text,
      first.startOffset,
      last.endOffset,
      operation.resultType ?? 'unknown',
      input.inventory.detectorVersion,
    );
    spans.splice(sortedIndexes[0]!, selected.length, replacement);
  }

  const inventory = createSpeakerSpanInventory({ ...input.inventory, spans });
  assertSpeakerSpanInventory(inventory, input.paragraphs);
  return inventory;
}
