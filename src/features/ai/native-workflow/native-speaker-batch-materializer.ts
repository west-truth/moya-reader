import type { LockedSpeakerSpanV1 } from '@noveldesk/text-core/speaker-attribution';
import { persistentId128 } from '@noveldesk/text-core/hash';
import type { BookAIWorkflowLabelingWindow } from '../../../providers/book-ai-workflow-plan';
import {
  materializeSpeakerAttributionInput,
  prepareSpeakerAttributionInputMaterialization,
  type MaterializedSpeakerAttributionInput,
  type SpeakerAttributionInputMaterializerSource,
} from '../../../providers/speaker-attribution/input-materializer';
import { buildCompactSpeakerAttributionRequest } from '../../../providers/speaker-attribution/request-profile';
import {
  assertSpeakerAttributionPinnedPayload,
  type SpeakerAttributionPinnedPayloadV3,
} from '../../../providers/speaker-attribution/workflow-contract';
import type { AddressUseEventV1 } from '../../../providers/speaker-attribution/address-event';
import type { TemporalRelationEdgeV1 } from '../../../providers/speaker-attribution/temporal-relation';
import type {
  NativeBookWorkflowMaterializeRequest,
  NativeStructuredJsonBatch,
  NativeStructuredJsonRequest,
} from './contracts';

export const NATIVE_SPEAKER_INDEPENDENT_ESCALATION_UNSUPPORTED_CODE =
  'native_speaker_independent_escalation_unsupported' as const;

export class NativeSpeakerIndependentEscalationUnsupportedError extends Error {
  readonly code = NATIVE_SPEAKER_INDEPENDENT_ESCALATION_UNSUPPORTED_CODE;

  constructor() {
    super(
      'Native compact speaker independent escalation is unsupported; disable speakerEscalationEnabled before materialization.',
    );
    this.name = 'NativeSpeakerIndependentEscalationUnsupportedError';
  }
}

export interface NativeSpeakerWindowBatchMaterializerInput {
  readonly workflowId: string;
  readonly expectedFence: number;
  readonly window: Pick<BookAIWorkflowLabelingWindow, 'id'>;
  readonly source: SpeakerAttributionInputMaterializerSource;
  readonly lockedSpans: readonly LockedSpeakerSpanV1[];
  readonly temporalState: {
    readonly addressEvents: readonly AddressUseEventV1[];
    readonly temporalRelationEdges: readonly TemporalRelationEdgeV1[];
    readonly sourceManifestFingerprint?: string;
  };
}

export interface NativeSpeakerWindowBatchMaterialization extends MaterializedSpeakerAttributionInput {
  readonly materializeRequest: NativeBookWorkflowMaterializeRequest & {
    readonly request?: never;
    readonly batch: NativeStructuredJsonBatch;
  };
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function nativeStructuredRequest(
  source: Pick<SpeakerAttributionInputMaterializerSource, 'providerId' | 'modelId' | 'providerOptions'>,
  packet: MaterializedSpeakerAttributionInput['payload']['units'][number]['packet'],
): NativeStructuredJsonRequest {
  const compact = buildCompactSpeakerAttributionRequest({
    packet,
    providerId: source.providerId,
    modelId: source.modelId,
    providerOptions: source.providerOptions,
    modelMaxOutputTokens: positiveInteger(source.providerOptions.modelMaxOutputTokens),
    reasoningP99: positiveInteger(source.providerOptions.reasoningP99),
  });
  return {
    providerId: source.providerId,
    modelId: source.modelId,
    prompt: compact.prompt,
    responseSchema: compact.responseSchema,
    jsonSchemaName: compact.jsonSchemaName,
    schemaVersion: compact.schemaVersion,
    providerOptions: compact.providerOptions,
  };
}

export function nativeSpeakerBatchUnitId(jobId: string, packetFingerprint: string): string {
  return persistentId128('native_speaker_batch_unit', [jobId, packetFingerprint]);
}

export function buildNativeSpeakerBatchMaterializeRequest(input: {
  readonly workflowId: string;
  readonly jobId: string;
  readonly expectedFence: number;
  readonly source: Pick<SpeakerAttributionInputMaterializerSource, 'providerId' | 'modelId' | 'providerOptions'>;
  readonly payload: SpeakerAttributionPinnedPayloadV3;
}): NativeSpeakerWindowBatchMaterialization['materializeRequest'] {
  if (input.source.providerOptions.speakerEscalationEnabled === true) {
    throw new NativeSpeakerIndependentEscalationUnsupportedError();
  }
  assertSpeakerAttributionPinnedPayload(input.payload);
  return {
    workflowId: input.workflowId,
    jobId: input.jobId,
    expectedFence: input.expectedFence,
    batch: {
      version: 'native-structured-json-batch-v1',
      units: input.payload.units.map((unit) => ({
        id: nativeSpeakerBatchUnitId(input.jobId, unit.packet.fingerprint),
        packetFingerprint: unit.packet.fingerprint,
        request: nativeStructuredRequest(input.source, unit.packet),
      })),
    },
  };
}

export function materializeNativeSpeakerWindowBatch(
  input: NativeSpeakerWindowBatchMaterializerInput,
): NativeSpeakerWindowBatchMaterialization {
  if (input.source.providerOptions.speakerEscalationEnabled === true) {
    throw new NativeSpeakerIndependentEscalationUnsupportedError();
  }
  const prepared = prepareSpeakerAttributionInputMaterialization(input.source, input.lockedSpans);
  const materializedInput = materializeSpeakerAttributionInput(prepared, input.temporalState);
  const materializeRequest = buildNativeSpeakerBatchMaterializeRequest({
    workflowId: input.workflowId,
    jobId: input.window.id,
    expectedFence: input.expectedFence,
    source: input.source,
    payload: materializedInput.payload,
  });
  return { ...materializedInput, materializeRequest };
}
