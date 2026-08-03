import type {
  DialogueBurstInventoryV1,
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { Chapter, Character, Paragraph } from '../../domain/types';
import type { LLMGenerationPolicyV2 } from '../provider-generation-policy';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';
import type { SceneSpeakerPacketV3 } from './contracts';
import type { SpeakerOutputBudget } from './output-budget';

export const SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION = 'speaker-attribution-workflow-v3' as const;

export interface SpeakerAttributionUnitSnapshotV3 {
  readonly sceneId: string;
  readonly packet: SceneSpeakerPacketV3;
  readonly generationPolicy: LLMGenerationPolicyV2;
  readonly outputBudget: SpeakerOutputBudget;
}

export interface SpeakerAttributionCanonicalSourceV3 {
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly sourceParagraphs: readonly SpeakerSourceParagraphInput[];
  readonly characters: readonly Character[];
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly dialogueBurstInventory?: DialogueBurstInventoryV1;
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly speakerIdByEntityId: Readonly<Record<string, string>>;
}

export interface SpeakerAttributionPinnedPayloadV3 {
  readonly contract: typeof SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION;
  readonly sourceManifestFingerprint: string;
  readonly spanInventoryHash: string;
  readonly mentionInventoryHash: string;
  readonly candidateMemoryHash: string;
  readonly addressEventRevision: string;
  readonly temporalSnapshotHash: string;
  readonly dialogueBurstInventoryHash: string;
  readonly sieveVersion: string;
  readonly sequenceDecoderVersion: 'dialogue-sequence-decision-v1';
  readonly units: readonly SpeakerAttributionUnitSnapshotV3[];
  readonly canonicalSource: SpeakerAttributionCanonicalSourceV3;
}

export function assertSpeakerAttributionPinnedPayload(payload: SpeakerAttributionPinnedPayloadV3): void {
  if (payload.contract !== SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION) {
    throw new Error('Compact speaker workflow contract version is unsupported');
  }
  if (payload.canonicalSource.spanInventory.fingerprint !== payload.spanInventoryHash) {
    throw new Error('Compact speaker span inventory hash is stale');
  }
  if (
    payload.canonicalSource.dialogueBurstInventory &&
    payload.canonicalSource.dialogueBurstInventory.fingerprint !== payload.dialogueBurstInventoryHash
  ) {
    throw new Error('Compact speaker dialogue burst inventory hash is stale');
  }
  if (payload.canonicalSource.sieve.version !== payload.sieveVersion) {
    throw new Error('Compact speaker sieve version is stale');
  }
  const seenPackets = new Set<string>();
  for (const unit of payload.units) {
    if (seenPackets.has(unit.packet.fingerprint)) {
      throw new Error(`Duplicate compact speaker packet unit: ${unit.packet.fingerprint}`);
    }
    seenPackets.add(unit.packet.fingerprint);
    if (unit.packet.sceneId !== unit.sceneId || unit.packet.spanInventoryHash !== payload.spanInventoryHash) {
      throw new Error(`Compact speaker scene unit source fence is stale: ${unit.sceneId}`);
    }
    if (!unit.packet.fingerprint || unit.outputBudget.decision !== 'accepted') {
      throw new Error(`Compact speaker scene unit budget is invalid: ${unit.sceneId}`);
    }
    if (
      unit.generationPolicy.taskKind !== 'speaker_attribution' ||
      unit.generationPolicy.requestedOutputCap !== unit.outputBudget.requestedOutputCap
    ) {
      throw new Error(`Compact speaker scene unit generation policy is invalid: ${unit.sceneId}`);
    }
  }
}
