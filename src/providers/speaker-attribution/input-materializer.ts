import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { LockedSpeakerSpanV1, SpeakerSourceParagraphInput } from '@noveldesk/text-core/speaker-attribution';
import type { Chapter, Character, Paragraph, UserCorrection } from '../../domain/types';
import type { CharacterGraphKnowledgeV2 } from '../character-graph-v2';
import type { ChapterLabelingPreviousContext } from '../ai';
import type { AddressUseEventV1 } from './address-event';
import { runDeterministicSpeakerSieve } from './deterministic-sieve';
import { canonicalSpeakerEntityId } from './identity-policy';
import { buildSpeakerAttributionChapter, type SpeakerAttributionChapterBuildV1 } from './inventory-builder';
import { planSpeakerPacketBatches } from './packet-planner';
import { buildCharacterTemporalSnapshot, type CharacterTemporalSnapshotV1 } from './reader-state-snapshot';
import { buildCompactSpeakerAttributionRequest } from './request-profile';
import { buildSceneSpeakerPacket } from './scene-packet';
import type { TemporalRelationEdgeV1 } from './temporal-relation';
import {
  SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
  type SpeakerAttributionPinnedPayloadV3,
} from './workflow-contract';

export interface SpeakerAttributionInputMaterializerSource {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly normalizedTextHash: string;
  readonly graphRevision: string;
  readonly correctionCursor: string;
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly allChapterParagraphs: readonly Paragraph[];
  readonly characters: readonly Character[];
  readonly graphKnowledge: CharacterGraphKnowledgeV2;
  readonly previousEpisodeContext?: ChapterLabelingPreviousContext;
  readonly userCorrections: readonly UserCorrection[];
  readonly providerId: string;
  readonly modelId: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly coversFullChapter: boolean;
  readonly finalWindowForChapter: boolean;
}

export interface PreparedSpeakerAttributionInputMaterialization {
  readonly source: SpeakerAttributionInputMaterializerSource;
  readonly sourceParagraphs: readonly SpeakerSourceParagraphInput[];
  readonly lockedSpans: readonly LockedSpeakerSpanV1[];
  readonly chapterBuild: SpeakerAttributionChapterBuildV1;
}

export type MaterializedSpeakerAttributionPinnedPayloadV3 = SpeakerAttributionPinnedPayloadV3 & {
  readonly kind: 'speaker_attribution_v3';
  readonly coversFullChapter: boolean;
  readonly finalWindowForChapter: boolean;
};

export interface MaterializedSpeakerAttributionInput {
  readonly inventory: SpeakerAttributionChapterBuildV1['inventory'];
  readonly snapshots: readonly CharacterTemporalSnapshotV1[];
  readonly payload: MaterializedSpeakerAttributionPinnedPayloadV3;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function sourceParagraph(paragraph: Paragraph): SpeakerSourceParagraphInput {
  return {
    paragraphId: paragraph.id,
    chapterId: paragraph.chapterId,
    paragraphIndex: paragraph.index,
    text: paragraph.text,
    textHash: paragraph.textHash,
    startOffsetInChapter: paragraph.startOffsetInChapter,
    endOffsetInChapter: paragraph.endOffsetInChapter,
  };
}

export function prepareSpeakerAttributionInputMaterialization(
  source: SpeakerAttributionInputMaterializerSource,
  lockedSpans: readonly LockedSpeakerSpanV1[],
): PreparedSpeakerAttributionInputMaterialization {
  const sourceParagraphs = source.allChapterParagraphs.map(sourceParagraph);
  const chapterBuild = buildSpeakerAttributionChapter({
    bookId: source.bookId,
    contentRevisionId: source.contentRevisionId,
    chapterId: source.chapter.id,
    chapterIndex: source.chapter.index,
    paragraphs: sourceParagraphs,
    characters: source.characters,
    graphKnowledge: source.graphKnowledge,
    lockedSpans,
    recentTurns: source.previousEpisodeContext?.recentTurns,
    userCorrections: source.userCorrections,
    maxCandidates: positiveInteger(source.providerOptions.maxSpeakerCandidates),
    candidateHardCap: positiveInteger(source.providerOptions.speakerCandidateHardCap),
    maxTargetSpansPerBurst: positiveInteger(source.providerOptions.maxSpeakerTargets),
  });
  return { source, sourceParagraphs, lockedSpans, chapterBuild };
}

export function materializeSpeakerAttributionInput(
  prepared: PreparedSpeakerAttributionInputMaterialization,
  temporalState: {
    readonly addressEvents: readonly AddressUseEventV1[];
    readonly temporalRelationEdges: readonly TemporalRelationEdgeV1[];
    readonly sourceManifestFingerprint?: string;
  },
): MaterializedSpeakerAttributionInput {
  const { source, sourceParagraphs, lockedSpans, chapterBuild } = prepared;
  const targetParagraphIds = new Set(source.paragraphs.map((paragraph) => paragraph.id));
  const sourceManifestFingerprint =
    temporalState.sourceManifestFingerprint ??
    structuredIntegrityHash({
      contentRevisionId: source.contentRevisionId,
      normalizedTextHash: source.normalizedTextHash,
    });
  const snapshots = chapterBuild.inventory.sceneInventory.scenes.map((scene) => {
    const candidateMemory = chapterBuild.candidateMemories[scene.id];
    if (!candidateMemory) throw new Error(`Candidate Memory is missing for scene ${scene.id}`);
    const candidateEntityIds = [
      ...new Set(
        chapterBuild.inventory.spanInventory.spans
          .filter((span) => span.sceneId === scene.id)
          .flatMap((span) => chapterBuild.candidateSelections[span.id]?.selectedEntityIds ?? []),
      ),
    ];
    return buildCharacterTemporalSnapshot({
      bookId: source.bookId,
      contentRevisionId: source.contentRevisionId,
      chapterId: source.chapter.id,
      sceneId: scene.id,
      narrativeOrder: source.chapter.index * 1_000_000 + scene.sceneIndex,
      readerMode: 'reader_safe',
      candidateMemory,
      candidateEntityIds,
      mentionInventory: chapterBuild.inventory.mentionInventory,
      addressEvents: temporalState.addressEvents,
      temporalRelationEdges: temporalState.temporalRelationEdges,
      sourceRevision: chapterBuild.inventory.fingerprint,
      graphRevision: source.graphRevision,
      correctionCursor: source.correctionCursor,
    });
  });
  const lockedSpeakerEntityIdByCorrectionId = Object.fromEntries(
    lockedSpans.map((lock) => [
      lock.correctionId,
      lock.speakerId === 'narrator' || lock.speakerId === 'system'
        ? lock.speakerId
        : canonicalSpeakerEntityId(source.bookId, lock.speakerId),
    ]),
  );
  const sieve = runDeterministicSpeakerSieve({
    spanInventory: chapterBuild.inventory.spanInventory,
    paragraphs: sourceParagraphs,
    mentionInventory: chapterBuild.inventory.mentionInventory,
    candidateSelections: chapterBuild.candidateSelections,
    candidateMemories: chapterBuild.candidateMemories,
    lockedSpeakerEntityIdByCorrectionId,
  });
  const snapshotBySceneId = new Map(snapshots.map((snapshot) => [snapshot.sceneId, snapshot]));
  const spanById = new Map(chapterBuild.inventory.spanInventory.spans.map((span) => [span.id, span]));
  const providerTargetSpanIds = new Set(
    sieve.decisions
      .filter(
        (decision) =>
          decision.outcome === 'provider_target' &&
          decision.ruleCode !== 'candidate_missing' &&
          targetParagraphIds.has(spanById.get(decision.spanId)?.paragraphId ?? ''),
      )
      .map((decision) => decision.spanId),
  );
  const maxTargets = Math.max(1, Math.min(40, positiveInteger(source.providerOptions.maxSpeakerTargets) ?? 40));
  const candidateHardCap = Math.max(
    1,
    Math.min(24, positiveInteger(source.providerOptions.speakerCandidateHardCap) ?? 24),
  );
  const selectedCandidateIdsBySpan = Object.fromEntries(
    Object.entries(chapterBuild.candidateSelections).map(([spanId, selection]) => [
      spanId,
      selection.selectedEntityIds,
    ]),
  );
  const units = chapterBuild.inventory.sceneInventory.scenes.flatMap((scene) => {
    const sceneProviderTargetSpanIds = new Set(
      [...providerTargetSpanIds].filter((spanId) => spanById.get(spanId)?.sceneId === scene.id),
    );
    const packetPlan = planSpeakerPacketBatches({
      bursts: chapterBuild.inventory.dialogueBurstInventory.bursts.filter((burst) => burst.sceneId === scene.id),
      providerTargetSpanIds: sceneProviderTargetSpanIds,
      selectedCandidateIdsBySpan,
      maxTargets,
      candidateHardCap,
    });
    if (packetPlan.length === 0) return [];
    const snapshot = snapshotBySceneId.get(scene.id);
    const candidateMemory = chapterBuild.candidateMemories[scene.id];
    if (!snapshot || !candidateMemory) throw new Error(`Compact speaker scene state is missing: ${scene.id}`);
    return packetPlan.map(({ burstIds: dialogueBurstIds, targetSpanIds }) => {
      const packet = buildSceneSpeakerPacket({
        bookId: source.bookId,
        contentRevisionId: source.contentRevisionId,
        chapterId: source.chapter.id,
        sceneId: scene.id,
        sourceRevision: chapterBuild.inventory.fingerprint,
        sourceManifestFingerprint,
        spanInventory: chapterBuild.inventory.spanInventory,
        mentionInventory: chapterBuild.inventory.mentionInventory,
        dialogueBurstInventory: chapterBuild.inventory.dialogueBurstInventory,
        candidateMemory,
        candidateSelections: chapterBuild.candidateSelections,
        temporalSnapshot: snapshot,
        sieve,
        paragraphs: sourceParagraphs,
        correctionCursor: source.correctionCursor,
        dialogueBurstIds,
        providerTargetSpanIds: targetSpanIds,
        maxTargets,
        candidateHardCap,
      });
      const request = buildCompactSpeakerAttributionRequest({
        packet,
        providerId: source.providerId,
        modelId: source.modelId,
        providerOptions: source.providerOptions,
        modelMaxOutputTokens: positiveInteger(source.providerOptions.modelMaxOutputTokens),
        reasoningP99: positiveInteger(source.providerOptions.reasoningP99),
      });
      return {
        sceneId: scene.id,
        packet,
        generationPolicy: request.generationPolicy,
        outputBudget: request.outputBudget,
      };
    });
  });
  const speakerIdByEntityId = Object.fromEntries(
    source.characters.map((character) => [canonicalSpeakerEntityId(source.bookId, character.id), character.id]),
  );
  const payload = {
    kind: 'speaker_attribution_v3' as const,
    contract: SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
    sourceManifestFingerprint,
    spanInventoryHash: chapterBuild.inventory.spanInventory.fingerprint,
    mentionInventoryHash: chapterBuild.inventory.mentionInventory.fingerprint,
    candidateMemoryHash: structuredIntegrityHash(
      Object.values(chapterBuild.candidateMemories).map((memory) => memory.fingerprint),
    ),
    addressEventRevision: structuredIntegrityHash(temporalState.addressEvents.map((event) => event.fingerprint)),
    temporalSnapshotHash: structuredIntegrityHash(snapshots.map((snapshot) => snapshot.fingerprint)),
    dialogueBurstInventoryHash: chapterBuild.inventory.dialogueBurstInventory.fingerprint,
    sieveVersion: sieve.version,
    sequenceDecoderVersion: 'dialogue-sequence-decision-v1' as const,
    units,
    canonicalSource: {
      chapter: source.chapter,
      paragraphs: source.paragraphs,
      sourceParagraphs: source.paragraphs.map(sourceParagraph),
      characters: source.characters,
      spanInventory: chapterBuild.inventory.spanInventory,
      dialogueBurstInventory: chapterBuild.inventory.dialogueBurstInventory,
      sieve,
      speakerIdByEntityId,
    },
    coversFullChapter: source.coversFullChapter,
    finalWindowForChapter: source.finalWindowForChapter,
  };
  return { inventory: chapterBuild.inventory, snapshots, payload };
}
