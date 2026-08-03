import {
  buildDialogueBurstInventory,
  buildSpeakerSceneInventory,
  buildSpeakerSpanInventory,
  type LockedSpeakerSpanV1,
  type SpeakerSourceParagraphInput,
  type SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { Character, UserCorrection } from '../../domain/types';
import type { ChapterLabelingRecentTurn } from '../ai';
import { resolveCharacterRedirect, type CharacterGraphKnowledgeV2 } from '../character-graph-v2';
import { buildAddressUseEvents, type AddressUseEventV1 } from './address-event';
import { buildCandidateMemoryView, type CandidateMemoryViewV2 } from './candidate-memory';
import { selectSpeakerCandidates, type CandidateSelectionDecisionV1 } from './candidate-selector';
import {
  createSpeakerAttributionChapterInventory,
  type SpeakerAttributionChapterInventoryV1,
} from './chapter-inventory';
import {
  canonicalSpeakerEntityId,
  coalesceSourceSpeakerEntitiesForMemory,
  deriveSourceSpeakerEntities,
  type SpeakerEntityV1,
} from './identity-policy';
import { buildLocalSpeakerCandidateView } from './local-candidate-view';
import { buildSourceMentionInventory } from './mention-inventory';
import { buildCandidateSelectionReport, type CandidateSelectionReportV1 } from './selection-report';

export interface SpeakerAttributionChapterBuildV1 {
  readonly inventory: SpeakerAttributionChapterInventoryV1;
  readonly candidateMemories: Readonly<Record<string, CandidateMemoryViewV2>>;
  readonly candidateSelections: Readonly<Record<string, CandidateSelectionDecisionV1>>;
  readonly selectionReports: readonly CandidateSelectionReportV1[];
}

export function buildSpeakerAttributionChapter(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly characters: readonly Character[];
  readonly graphKnowledge: CharacterGraphKnowledgeV2;
  readonly lockedSpans?: readonly LockedSpeakerSpanV1[];
  readonly recentTurns?: readonly ChapterLabelingRecentTurn[];
  readonly userCorrections?: readonly UserCorrection[];
  readonly expectedCharacterIdBySpan?: Readonly<Record<string, string>>;
  readonly maxCandidates?: number;
  readonly candidateHardCap?: number;
  readonly maxTargetSpansPerBurst?: number;
  readonly priorSourceEntities?: readonly SpeakerEntityV1[];
}): SpeakerAttributionChapterBuildV1 {
  const sceneInventory = buildSpeakerSceneInventory(input);
  const spanInventory = buildSpeakerSpanInventory({
    ...input,
    sceneInventory,
    lockedSpans: input.lockedSpans,
  });
  const mentionInventory = buildSourceMentionInventory({
    ...input,
    spanInventory,
    characters: input.characters,
    graphKnowledge: input.graphKnowledge,
  });
  const sceneOrdinalById = Object.fromEntries(sceneInventory.scenes.map((scene) => [scene.id, scene.sceneIndex]));
  const narrativeOrderByScene = Object.fromEntries(
    sceneInventory.scenes.map((scene) => [scene.id, input.chapterIndex * 1_000_000 + scene.sceneIndex]),
  );
  const speakerEntityIdByCharacterId = Object.fromEntries(
    input.characters.map((character) => {
      const characterId = resolveCharacterRedirect(character.id, input.graphKnowledge.redirects);
      return [character.id, canonicalSpeakerEntityId(input.bookId, characterId)];
    }),
  );
  const entities = deriveSourceSpeakerEntities({
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    mentions: mentionInventory.mentions,
    sceneOrdinalById,
  });
  const memoryEntities = coalesceSourceSpeakerEntitiesForMemory([...(input.priorSourceEntities ?? []), ...entities]);
  const lockedSpeakerByCorrectionId = new Map(
    (input.lockedSpans ?? []).map((lock) => [lock.correctionId, lock.speakerId] as const),
  );
  const lockedCharacterIdsByScene = Object.fromEntries(
    sceneInventory.scenes.map((scene) => [
      scene.id,
      [
        ...new Set(
          spanInventory.spans
            .filter((span) => span.sceneId === scene.id && span.lockedCorrectionId)
            .map((span) => lockedSpeakerByCorrectionId.get(span.lockedCorrectionId!))
            .filter((characterId): characterId is string => Boolean(characterId))
            .map((characterId) => resolveCharacterRedirect(characterId, input.graphKnowledge.redirects)),
        ),
      ],
    ]),
  );

  const buildMemories = (events: readonly AddressUseEventV1[]) =>
    Object.fromEntries(
      sceneInventory.scenes.map((scene) => {
        const localCandidateView = buildLocalSpeakerCandidateView({
          ...input,
          sceneId: scene.id,
          mentionInventory,
          sourceEntities: memoryEntities,
          sceneOrdinalById,
          requiredCharacterIds: lockedCharacterIdsByScene[scene.id] ?? [],
        });
        return [
          scene.id,
          buildCandidateMemoryView({
            ...input,
            sceneId: scene.id,
            mentionInventory,
            sourceEntities: memoryEntities,
            addressEvents: events,
            localCandidateView,
          }),
        ];
      }),
    ) as Record<string, CandidateMemoryViewV2>;

  const buildSelections = (memories: Readonly<Record<string, CandidateMemoryViewV2>>) => {
    const selections: Record<string, CandidateSelectionDecisionV1> = {};
    for (const span of spanInventory.spans) {
      if (!span.voiceBearing || span.deterministicSpeaker) continue;
      const memory = memories[span.sceneId];
      if (!memory) throw new Error(`Speaker span ${span.id} has no Candidate Memory view`);
      selections[span.id] = selectSpeakerCandidates({
        targetSpan: span,
        memory,
        mentionInventory,
        lockedCharacterId: span.lockedCorrectionId
          ? resolveCharacterRedirect(
              lockedSpeakerByCorrectionId.get(span.lockedCorrectionId) ?? '',
              input.graphKnowledge.redirects,
            ) || undefined
          : undefined,
        expectedCharacterId: input.expectedCharacterIdBySpan?.[span.id]
          ? resolveCharacterRedirect(input.expectedCharacterIdBySpan[span.id]!, input.graphKnowledge.redirects)
          : undefined,
        maxCandidates: input.maxCandidates,
        hardCap: input.candidateHardCap,
      });
    }
    return selections;
  };

  const observedSpeakerEntityIdBySpan = Object.fromEntries(
    spanInventory.spans.flatMap((span) => {
      if (!span.lockedCorrectionId) return [];
      const characterId = lockedSpeakerByCorrectionId.get(span.lockedCorrectionId);
      if (!characterId) return [];
      return [
        [
          span.id,
          canonicalSpeakerEntityId(input.bookId, resolveCharacterRedirect(characterId, input.graphKnowledge.redirects)),
        ],
      ];
    }),
  );
  const addressEvents = buildAddressUseEvents({
    mentionInventory,
    observedSpeakerEntityIdBySpan,
    narrativeOrderByScene,
    speakerEntityIdByCharacterId,
  });
  const candidateMemories = buildMemories(addressEvents);
  const candidateSelections = buildSelections(candidateMemories);
  const participantCandidateIdsBySpan = Object.fromEntries(
    Object.entries(candidateSelections).map(([spanId, decision]) => [spanId, decision.selectedEntityIds]),
  );
  const dialogueBurstInventory = buildDialogueBurstInventory({
    spanInventory,
    participantCandidateIdsBySpan,
    maxTargetSpans: input.maxTargetSpansPerBurst,
    candidateHardCap: input.candidateHardCap,
  });
  const inventory = createSpeakerAttributionChapterInventory({
    ...input,
    sceneInventory,
    spanInventory,
    dialogueBurstInventory,
    mentionInventory,
    entities,
    addressEvents,
  });
  const selectionReports = sceneInventory.scenes.map((scene) => {
    const memory = candidateMemories[scene.id]!;
    const sceneSpanIds = new Set(
      spanInventory.spans.filter((span: SpeakerSpanV1) => span.sceneId === scene.id).map((span) => span.id),
    );
    return buildCandidateSelectionReport({
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      chapterId: input.chapterId,
      sceneId: scene.id,
      candidateMemoryHash: memory.fingerprint,
      decisions: Object.entries(candidateSelections)
        .filter(([spanId]) => sceneSpanIds.has(spanId))
        .map(([, decision]) => decision),
    });
  });
  return { inventory, candidateMemories, candidateSelections, selectionReports };
}
