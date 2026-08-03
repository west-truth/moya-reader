import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { SpeakerSpanInventoryV1 } from '@noveldesk/text-core/speaker-attribution';
import type { Character, LabeledSegment } from '../../domain/types';
import { labeledSegmentId, segmentTextIntegrityHash } from '../../domain/identity/ai-identities';
import type { ChapterLabelingResult, ChapterLabelingUncertainty } from '../ai';
import type { DialogueSequenceDecisionV1, SceneSpeakerPacketV3, ValidatedSpeakerWireV2 } from './contracts';
import {
  expandSpeakerAttributionToCanonicalLabels,
  type CanonicalSpeakerExpansionV3,
  type PendingSpeakerEntityV1,
} from './canonical-expander';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';

export interface CanonicalSpeakerAttributionUnitV3 {
  readonly packet: SceneSpeakerPacketV3;
  readonly validatedWire: ValidatedSpeakerWireV2;
  readonly sequenceDecisions: readonly DialogueSequenceDecisionV1[];
}

function uncertaintyKey(value: Pick<ChapterLabelingUncertainty, 'paragraphId' | 'startOffset' | 'endOffset'>): string {
  return `${value.paragraphId}:${value.startOffset}:${value.endOffset}`;
}

function segmentKey(value: Pick<LabeledSegment, 'paragraphId' | 'startOffset' | 'endOffset'>): string {
  return `${value.paragraphId}:${value.startOffset}:${value.endOffset}`;
}

function mergeExpansions(input: {
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly targetSpanIndexes?: readonly number[];
  readonly expansions: readonly {
    readonly unit: CanonicalSpeakerAttributionUnitV3;
    readonly expansion: CanonicalSpeakerExpansionV3;
  }[];
}): CanonicalSpeakerExpansionV3 {
  const fallback = input.expansions[0]!.expansion;
  const expansionBySpanIndex = new Map<number, CanonicalSpeakerExpansionV3>();
  for (const item of input.expansions) {
    for (const target of item.unit.packet.targets) expansionBySpanIndex.set(target[0], item.expansion);
  }
  const targetSpanIndexes = input.targetSpanIndexes ? new Set(input.targetSpanIndexes) : undefined;
  const selectedSegments = input.spanInventory.spans
    .filter((span) => !targetSpanIndexes || targetSpanIndexes.has(span.spanIndex))
    .map((span) => {
      const expansion = expansionBySpanIndex.get(span.spanIndex) ?? fallback;
      const segment = expansion.result.segments.find((candidate) => candidate.segmentIndex === span.spanIndex);
      if (!segment) throw new Error(`Compact speaker expansion omitted span ${span.id}`);
      return { segment, expansion };
    });
  const uncertaintyByExpansion = new Map(
    input.expansions.map(({ expansion }) => [
      expansion,
      new Map((expansion.result.uncertainties ?? []).map((item) => [uncertaintyKey(item), item])),
    ]),
  );
  const uncertainties = selectedSegments.flatMap(({ segment, expansion }) => {
    const found = uncertaintyByExpansion.get(expansion)?.get(segmentKey(segment));
    return found ? [found] : [];
  });
  const segmentAnnotations = Object.fromEntries(
    selectedSegments.flatMap(({ segment, expansion }) => {
      const annotation = expansion.result.segmentAnnotations?.[segment.id];
      return annotation ? [[segment.id, annotation] as const] : [];
    }),
  );
  const pendingSpeakerEntities = input.expansions.flatMap(({ unit, expansion }) => {
    const targetPositions = new Set(unit.packet.targets.map((_, position) => position));
    return expansion.pendingSpeakerEntities.filter((item) => targetPositions.has(item.targetPosition));
  });
  const routedSpanIds = selectedSegments.flatMap(({ segment, expansion }) =>
    expansion.routedSpanIds.includes(
      input.spanInventory.spans.find((span) => span.spanIndex === segment.segmentIndex)?.id ?? '',
    )
      ? [input.spanInventory.spans.find((span) => span.spanIndex === segment.segmentIndex)!.id]
      : [],
  );
  return {
    result: {
      characters: fallback.result.characters,
      segments: selectedSegments.map((item) => item.segment),
      uncertainties,
      segmentAnnotations,
    },
    pendingSpeakerEntities,
    routedSpanIds: [...new Set(routedSpanIds)].sort(),
  };
}

function deterministicOnlyExpansion(input: {
  readonly bookId: string;
  readonly chapterId: string;
  readonly characters: readonly Character[];
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly paragraphs: readonly {
    readonly paragraphId: string;
    readonly text: string;
  }[];
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly speakerIdByEntityId: Readonly<Record<string, string>>;
  readonly targetSpanIndexes?: readonly number[];
}): CanonicalSpeakerExpansionV3 {
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.text]));
  const decisionBySpanId = new Map(input.sieve.decisions.map((decision) => [decision.spanId, decision]));
  const uncertainties: ChapterLabelingUncertainty[] = [];
  const pendingSpeakerEntities: PendingSpeakerEntityV1[] = [];
  const routedSpanIds: string[] = [];
  const annotations: NonNullable<ChapterLabelingResult['segmentAnnotations']> = {};
  const targetSpanIndexes = input.targetSpanIndexes ? new Set(input.targetSpanIndexes) : undefined;
  const segments = input.spanInventory.spans
    .filter((span) => !targetSpanIndexes || targetSpanIndexes.has(span.spanIndex))
    .map<LabeledSegment>((span) => {
      const source = paragraphById.get(span.paragraphId);
      if (source === undefined) throw new Error(`Compact speaker source paragraph is missing: ${span.paragraphId}`);
      const text = source.slice(span.startOffset, span.endOffset);
      if (textIntegrityHash(text) !== span.textHash)
        throw new Error(`Compact speaker source span is stale: ${span.id}`);
      const decision = decisionBySpanId.get(span.id);
      const entityId = decision?.speakerEntityId;
      const speakerId =
        entityId === 'narrator' || entityId === 'system'
          ? entityId
          : entityId
            ? (input.speakerIdByEntityId[entityId] ?? 'unknown')
            : 'unknown';
      if (speakerId === 'unknown') {
        routedSpanIds.push(span.id);
        uncertainties.push({
          paragraphId: span.paragraphId,
          startOffset: span.startOffset,
          endOffset: span.endOffset,
          reasonCode: decision?.ruleCode ?? 'speaker_packet_result_missing',
          candidateIds:
            decision?.candidateEntityIds.flatMap((id) =>
              input.speakerIdByEntityId[id] ? [input.speakerIdByEntityId[id]!] : [],
            ) ?? [],
        });
      }
      const segmentTextHash = segmentTextIntegrityHash(text);
      const id = labeledSegmentId({
        novelId: input.bookId,
        chapterId: input.chapterId,
        paragraphId: span.paragraphId,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        segmentTextHash,
      });
      annotations[id] = { evidenceCodes: [decision?.ruleCode ?? 'unresolved'] };
      return {
        id,
        novelId: input.bookId,
        chapterId: input.chapterId,
        paragraphId: span.paragraphId,
        segmentIndex: span.spanIndex,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        segmentTextHash,
        type:
          span.type === 'dialogue'
            ? 'quoted_dialogue'
            : span.type === 'message'
              ? 'plain_dialogue'
              : span.type === 'system'
                ? 'system_message'
                : span.type === 'metadata'
                  ? 'author_note'
                  : span.type,
        speakerId,
        candidateSpeakers:
          decision?.candidateEntityIds.flatMap((candidate) =>
            input.speakerIdByEntityId[candidate] ? [input.speakerIdByEntityId[candidate]!] : [],
          ) ?? [],
        listenerIds: [],
        emotion: speakerId === 'system' ? 'system' : 'neutral',
        confidence: decision?.confidence ?? 0,
        evidence: decision?.ruleCode ?? 'unresolved',
        isUserCorrected: decision?.ruleCode.includes('user_') ?? false,
      };
    });
  return {
    result: { characters: [...input.characters], segments, uncertainties, segmentAnnotations: annotations },
    pendingSpeakerEntities,
    routedSpanIds,
  };
}

export function expandSpeakerAttributionBatchToCanonicalLabels(input: {
  readonly bookId: string;
  readonly chapterId: string;
  readonly characters: readonly Character[];
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly paragraphs: readonly {
    readonly paragraphId: string;
    readonly chapterId: string;
    readonly paragraphIndex: number;
    readonly text: string;
    readonly textHash: string;
    readonly startOffsetInChapter: number;
    readonly endOffsetInChapter: number;
  }[];
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly speakerIdByEntityId: Readonly<Record<string, string>>;
  readonly targetSpanIndexes?: readonly number[];
  readonly units: readonly CanonicalSpeakerAttributionUnitV3[];
}): CanonicalSpeakerExpansionV3 {
  if (input.units.length === 0) return deterministicOnlyExpansion(input);
  return mergeExpansions({
    spanInventory: input.spanInventory,
    targetSpanIndexes: input.targetSpanIndexes,
    expansions: input.units.map((unit) => ({
      unit,
      expansion: expandSpeakerAttributionToCanonicalLabels({
        ...input,
        packet: unit.packet,
        validatedWire: unit.validatedWire,
        sequenceDecisions: unit.sequenceDecisions,
      }),
    })),
  });
}
