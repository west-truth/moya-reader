import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { ChapterLabelingResult } from '../../../providers/ai';
import {
  expandSpeakerAttributionBatchToCanonicalLabels,
  type CanonicalSpeakerAttributionUnitV3,
} from '../../../providers/speaker-attribution/canonical-batch-expander';
import type { SpeakerSegmentProvenanceDraftV1 } from '../../../providers/speaker-attribution/accepted-speaker-provenance';
import { parseSpeakerWireV2 } from '../../../providers/speaker-attribution/parser';
import { routeSpeakerRisks, type SpeakerRiskRouteV1 } from '../../../providers/speaker-attribution/routing';
import { decodeDialogueSequences } from '../../../providers/speaker-attribution/sequence-decoder';
import {
  projectSpeakerSegmentProvenanceDrafts,
  speakerSegmentProvenanceDraftsFingerprint,
} from '../../../providers/speaker-attribution/speaker-provenance-projection';
import { validateSpeakerWireV2 } from '../../../providers/speaker-attribution/validator';
import {
  assertSpeakerAttributionPinnedPayload,
  type SpeakerAttributionPinnedPayloadV3,
} from '../../../providers/speaker-attribution/workflow-contract';
import {
  createSpeakerSequenceDecisionRecord,
  type SpeakerSequenceDecisionRecordV1,
} from '../../../providers/speaker-attribution/workflow-state';
import {
  normalizeProviderExecutionMetadata,
  type ProviderExecutionMetadata,
} from '../../../providers/provider-execution';
import type { NativeStructuredJsonBatch } from './contracts';
import { nativeSpeakerBatchUnitId } from './native-speaker-batch-materializer';

export const NATIVE_STRUCTURED_JSON_BATCH_RESULT_VERSION = 'native-structured-json-batch-result-v1' as const;

export interface NativeStructuredJsonBatchResultUnit {
  readonly id: string;
  readonly packetFingerprint: string;
  readonly requestHash: string;
  readonly outputHash: string;
  readonly output: unknown;
  readonly providerExecution?: ProviderExecutionMetadata;
}

export interface NativeStructuredJsonBatchResult {
  readonly version: typeof NATIVE_STRUCTURED_JSON_BATCH_RESULT_VERSION;
  readonly units: readonly NativeStructuredJsonBatchResultUnit[];
}

export interface NativeSpeakerBatchDurableMetadataV1 {
  readonly version: 'native-speaker-batch-metadata-v1';
  readonly jobId: string;
  readonly packetFingerprints: readonly string[];
  readonly requestHashes: readonly string[];
  readonly outputHashes: readonly string[];
  readonly sequenceDecisionIds: readonly string[];
  readonly riskRoutes: readonly SpeakerRiskRouteV1[];
  readonly routedSpanCount: number;
  readonly pendingSpeakerEntityCount: number;
  readonly speakerProvenanceCount: number;
  readonly speakerProvenanceFingerprint: string;
  readonly providerExecutions: readonly ProviderExecutionMetadata[];
}

export interface NativeSpeakerBatchAggregation {
  readonly result: ChapterLabelingResult;
  readonly routedSpanIds: readonly string[];
  readonly sequenceRecords: readonly SpeakerSequenceDecisionRecordV1[];
  readonly artifactDependencyIds: readonly string[];
  readonly speakerProvenanceDrafts: readonly SpeakerSegmentProvenanceDraftV1[];
  readonly riskRoutes: readonly SpeakerRiskRouteV1[];
  readonly metadata: NativeSpeakerBatchDurableMetadataV1;
}

export interface NativeSpeakerBatchAggregatorInput {
  readonly jobId: string;
  readonly correctionFingerprint: string;
  readonly payload: SpeakerAttributionPinnedPayloadV3;
  readonly batch: NativeStructuredJsonBatch;
  readonly checkpointOutput: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} contains missing or additional fields`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseBatchResultUnit(value: unknown, index: number): NativeStructuredJsonBatchResultUnit {
  const unit = record(value, `Native structured JSON batch result unit ${index}`);
  const keys = ['id', 'output', 'outputHash', 'packetFingerprint', 'requestHash'] as string[];
  if ('providerExecution' in unit) keys.push('providerExecution');
  exactKeys(unit, keys, `Native structured JSON batch result unit ${index}`);
  let providerExecution: ProviderExecutionMetadata | undefined;
  if ('providerExecution' in unit) {
    providerExecution = normalizeProviderExecutionMetadata(unit.providerExecution);
    if (!providerExecution) {
      throw new Error(`Native structured JSON batch result unit ${index} has invalid provider execution metadata`);
    }
  }
  return {
    id: requiredText(unit.id, `Native structured JSON batch result unit ${index} id`),
    packetFingerprint: requiredText(
      unit.packetFingerprint,
      `Native structured JSON batch result unit ${index} packet fingerprint`,
    ),
    requestHash: requiredText(unit.requestHash, `Native structured JSON batch result unit ${index} request hash`),
    outputHash: requiredText(unit.outputHash, `Native structured JSON batch result unit ${index} output hash`),
    output: unit.output,
    ...(providerExecution ? { providerExecution } : {}),
  };
}

export function parseNativeStructuredJsonBatchResult(value: unknown): NativeStructuredJsonBatchResult {
  const result = record(value, 'Native structured JSON batch result');
  exactKeys(result, ['units', 'version'], 'Native structured JSON batch result');
  if (result.version !== NATIVE_STRUCTURED_JSON_BATCH_RESULT_VERSION || !Array.isArray(result.units)) {
    throw new Error('Native structured JSON batch result version or units are invalid');
  }
  const units = result.units.map(parseBatchResultUnit);
  const unitIds = new Set<string>();
  const packetFingerprints = new Set<string>();
  for (const unit of units) {
    if (unitIds.has(unit.id)) throw new Error(`Native structured JSON batch result has duplicate unit id: ${unit.id}`);
    if (packetFingerprints.has(unit.packetFingerprint)) {
      throw new Error(
        `Native structured JSON batch result has duplicate packet fingerprint: ${unit.packetFingerprint}`,
      );
    }
    unitIds.add(unit.id);
    packetFingerprints.add(unit.packetFingerprint);
  }
  return { version: NATIVE_STRUCTURED_JSON_BATCH_RESULT_VERSION, units };
}

function assertMaterializedBatch(input: NativeSpeakerBatchAggregatorInput): void {
  if (input.batch.version !== 'native-structured-json-batch-v1') {
    throw new Error('Native speaker materialized batch version is unsupported');
  }
  if (input.batch.units.length !== input.payload.units.length) {
    throw new Error('Native speaker materialized batch is missing packet units');
  }
  input.batch.units.forEach((unit, index) => {
    const packet = input.payload.units[index]?.packet;
    if (!packet) throw new Error(`Native speaker materialized batch has an unexpected unit at ${index}`);
    if (unit.id !== nativeSpeakerBatchUnitId(input.jobId, packet.fingerprint)) {
      throw new Error(`Native speaker materialized batch unit id is stale at ${index}`);
    }
    if (unit.packetFingerprint !== packet.fingerprint) {
      const expectedIndex = input.payload.units.findIndex(
        (candidate) => candidate.packet.fingerprint === unit.packetFingerprint,
      );
      if (expectedIndex >= 0)
        throw new Error(`Native speaker materialized batch packet units are reordered at ${index}`);
      throw new Error(`Native speaker materialized batch packet fingerprint is stale at ${index}`);
    }
  });
}

function attributedUnits(
  input: NativeSpeakerBatchAggregatorInput,
  result: NativeStructuredJsonBatchResult,
): readonly CanonicalSpeakerAttributionUnitV3[] {
  if (result.units.length !== input.batch.units.length) {
    throw new Error('Native structured JSON batch result is missing packet units');
  }
  return result.units.map((resultUnit, index) => {
    const batchUnit = input.batch.units[index]!;
    const sourceUnit = input.payload.units[index]!;
    if (resultUnit.id !== batchUnit.id) {
      const expectedIndex = input.batch.units.findIndex((candidate) => candidate.id === resultUnit.id);
      if (expectedIndex >= 0) throw new Error(`Native structured JSON batch result units are reordered at ${index}`);
      throw new Error(`Native structured JSON batch result is missing unit ${batchUnit.id}`);
    }
    if (
      resultUnit.packetFingerprint !== batchUnit.packetFingerprint ||
      resultUnit.packetFingerprint !== sourceUnit.packet.fingerprint
    ) {
      throw new Error(`Native structured JSON batch result packet fingerprint is stale at ${index}`);
    }
    if (resultUnit.requestHash !== structuredIntegrityHash(batchUnit.request)) {
      throw new Error(`Native structured JSON batch result request hash is invalid at ${index}`);
    }
    if (resultUnit.outputHash !== structuredIntegrityHash(resultUnit.output)) {
      throw new Error(`Native structured JSON batch result output hash is invalid at ${index}`);
    }
    const wire = parseSpeakerWireV2(resultUnit.output);
    const validatedWire = validateSpeakerWireV2(sourceUnit.packet, wire);
    return {
      packet: sourceUnit.packet,
      validatedWire,
      sequenceDecisions: decodeDialogueSequences(sourceUnit.packet, validatedWire),
    };
  });
}

export function aggregateNativeSpeakerBatchCheckpoint(
  input: NativeSpeakerBatchAggregatorInput,
): NativeSpeakerBatchAggregation {
  assertSpeakerAttributionPinnedPayload(input.payload);
  assertMaterializedBatch(input);
  const checkpoint = parseNativeStructuredJsonBatchResult(input.checkpointOutput);
  const units = attributedUnits(input, checkpoint);
  const targetParagraphIds = new Set(input.payload.canonicalSource.paragraphs.map((paragraph) => paragraph.id));
  const targetSpanIndexes = input.payload.canonicalSource.spanInventory.spans
    .filter((span) => targetParagraphIds.has(span.paragraphId))
    .map((span) => span.spanIndex);
  const expansion = expandSpeakerAttributionBatchToCanonicalLabels({
    bookId: input.payload.canonicalSource.chapter.novelId,
    chapterId: input.payload.canonicalSource.chapter.id,
    characters: input.payload.canonicalSource.characters,
    spanInventory: input.payload.canonicalSource.spanInventory,
    paragraphs: input.payload.canonicalSource.sourceParagraphs,
    sieve: input.payload.canonicalSource.sieve,
    speakerIdByEntityId: input.payload.canonicalSource.speakerIdByEntityId,
    targetSpanIndexes,
    units,
  });
  const sequenceDecisions = units.flatMap((unit) => unit.sequenceDecisions);
  const sequenceRecords = units.flatMap((unit) =>
    unit.sequenceDecisions.map((decision) =>
      createSpeakerSequenceDecisionRecord({
        bookId: input.payload.canonicalSource.chapter.novelId,
        contentRevisionId: input.payload.canonicalSource.spanInventory.contentRevisionId,
        chapterId: input.payload.canonicalSource.chapter.id,
        sceneId: unit.packet.sceneId,
        packetFingerprint: unit.packet.fingerprint,
        decision,
      }),
    ),
  );
  const riskRoutes = routeSpeakerRisks({
    sieve: input.payload.canonicalSource.sieve,
    attributedUnits: units,
    sequenceDecisions,
    targetSpanIndexes,
  });
  const speakerProvenanceDrafts = projectSpeakerSegmentProvenanceDrafts({
    bookId: input.payload.canonicalSource.chapter.novelId,
    contentRevisionId: input.payload.canonicalSource.spanInventory.contentRevisionId,
    chapterId: input.payload.canonicalSource.chapter.id,
    chapterIndex: input.payload.canonicalSource.chapter.index,
    sourceManifestFingerprint: input.payload.sourceManifestFingerprint,
    spanInventory: input.payload.canonicalSource.spanInventory,
    dialogueBurstInventory: input.payload.canonicalSource.dialogueBurstInventory,
    sieve: input.payload.canonicalSource.sieve,
    result: expansion.result,
    units,
  });
  const speakerProvenanceFingerprint = speakerSegmentProvenanceDraftsFingerprint(speakerProvenanceDrafts);
  const artifactDependencyIds = [
    ...new Set([
      input.payload.sourceManifestFingerprint,
      input.payload.spanInventoryHash,
      input.payload.mentionInventoryHash,
      input.payload.candidateMemoryHash,
      input.payload.addressEventRevision,
      input.payload.temporalSnapshotHash,
      input.payload.dialogueBurstInventoryHash,
      input.payload.canonicalSource.sieve.fingerprint,
      input.correctionFingerprint,
      ...input.payload.units.map((unit) => unit.packet.fingerprint),
      ...sequenceDecisions.map((decision) => decision.id),
    ]),
  ].sort();
  const providerExecutions = checkpoint.units.flatMap((unit) =>
    unit.providerExecution ? [unit.providerExecution] : [],
  );
  const metadata: NativeSpeakerBatchDurableMetadataV1 = {
    version: 'native-speaker-batch-metadata-v1',
    jobId: input.jobId,
    packetFingerprints: input.payload.units.map((unit) => unit.packet.fingerprint),
    requestHashes: checkpoint.units.map((unit) => unit.requestHash),
    outputHashes: checkpoint.units.map((unit) => unit.outputHash),
    sequenceDecisionIds: sequenceDecisions.map((decision) => decision.id),
    riskRoutes,
    routedSpanCount: expansion.routedSpanIds.length,
    pendingSpeakerEntityCount: expansion.pendingSpeakerEntities.length,
    speakerProvenanceCount: speakerProvenanceDrafts.length,
    speakerProvenanceFingerprint,
    providerExecutions,
  };
  return {
    result: expansion.result,
    routedSpanIds: expansion.routedSpanIds,
    sequenceRecords,
    artifactDependencyIds,
    speakerProvenanceDrafts,
    riskRoutes,
    metadata,
  };
}

export const aggregateNativeSpeakerBatch = aggregateNativeSpeakerBatchCheckpoint;
