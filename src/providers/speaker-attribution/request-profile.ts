import {
  applyLLMGenerationPolicy,
  resolveLLMGenerationPolicy,
  type LLMGenerationPolicyV2,
} from '../provider-generation-policy';
import {
  SPEAKER_ATTRIBUTION_INPUT_PROTOCOL_VERSION,
  SPEAKER_ATTRIBUTION_PROMPT_VERSION,
  SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
  SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
  type SceneSpeakerPacketV3,
  type SpeakerWireV2,
  type ValidatedSpeakerWireV2,
} from './contracts';
import { estimateSpeakerOutputBudget, type SpeakerOutputBudget } from './output-budget';
import { parseSpeakerWireV2Json } from './parser';
import { buildCompactSpeakerAttributionPrompt } from './prompt';
import { compileSpeakerWireV2Schema } from './schema-compiler';
import { validateSpeakerWireV2 } from './validator';

const internalSpeakerProviderOptionKeys = new Set([
  'requestProfileId',
  'labelingProfileId',
  'promptProfileId',
  'promptVersion',
  'schemaVersion',
  'compactSpeakerAttributionV3',
  'candidateMemoryV1',
  'temporalCharacterMemoryV1',
  'speakerSieveSequenceV1',
  'modelMaxOutputTokens',
  'reasoningP99',
  'speakerRiskRoutingV1',
  'speakerEscalationEnabled',
  'speakerEscalationProviderId',
  'speakerEscalationModelId',
  'speakerEscalationMaximumRatio',
  'speakerEscalationMaximumTargets',
  'speakerEscalationMaximumRequests',
  'speakerEscalationMinimumConfidence',
]);

export const compactSpeakerAttributionRequestProfile = {
  id: SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
  profileId: SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
  promptVersion: SPEAKER_ATTRIBUTION_PROMPT_VERSION,
  inputProtocolVersion: SPEAKER_ATTRIBUTION_INPUT_PROTOCOL_VERSION,
  schemaVersion: SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
  displayName: 'Compact speaker attribution v3 / readable input v1',
  description: 'Source-anchored speaker-only labeling with bounded narrative context and structured output.',
  enabled: true,
} as const;

export interface CompactSpeakerAttributionRequestV3 {
  readonly profileId: typeof SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID;
  readonly promptVersion: typeof SPEAKER_ATTRIBUTION_PROMPT_VERSION;
  readonly inputProtocolVersion: typeof SPEAKER_ATTRIBUTION_INPUT_PROTOCOL_VERSION;
  readonly schemaVersion: typeof SPEAKER_ATTRIBUTION_SCHEMA_VERSION;
  readonly jsonSchemaName: 'speaker_wire_v2';
  readonly packet: SceneSpeakerPacketV3;
  readonly prompt: string;
  readonly responseSchema: Record<string, unknown>;
  readonly outputBudget: SpeakerOutputBudget;
  readonly generationPolicy: LLMGenerationPolicyV2;
  readonly providerOptions: Record<string, unknown>;
  parseResponse(text: string): SpeakerWireV2;
  validateResponse(wire: SpeakerWireV2): ValidatedSpeakerWireV2;
}

export function buildCompactSpeakerAttributionRequest(input: {
  readonly packet: SceneSpeakerPacketV3;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly modelMaxOutputTokens?: number;
  readonly reasoningP99?: number;
  readonly taskKind?: 'speaker_attribution' | 'speaker_escalation';
}): CompactSpeakerAttributionRequestV3 {
  const ambiguousEstimate = input.packet.targets.filter((target) => target[4].length > 1).length;
  const totalAlternativeCandidateEstimate = input.packet.targets.reduce(
    (total, target) => total + Math.min(3, Math.max(0, target[4].length - 1)),
    0,
  );
  const outputBudget = estimateSpeakerOutputBudget({
    targetSpanCount: input.packet.targets.length,
    ambiguousEstimate,
    totalAlternativeCandidateEstimate,
    newMentionEstimate: input.packet.newMentionOrdinalsByTarget.length,
    reasoningP99: input.reasoningP99,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
  });
  if (outputBudget.decision === 'rejected') {
    throw new Error('Provider output capacity is below the compact speaker response budget');
  }
  const generationPolicy = resolveLLMGenerationPolicy({
    providerId: input.providerId,
    modelId: input.modelId,
    taskKind: input.taskKind ?? 'speaker_attribution',
    providerOptions: input.providerOptions,
    requestedOutputCap: outputBudget.requestedOutputCap,
    visibleOutputEstimate: outputBudget.visibleOutputEstimate,
  });
  const providerApiOptions = Object.fromEntries(
    Object.entries(input.providerOptions ?? {}).filter(([key]) => !internalSpeakerProviderOptionKeys.has(key)),
  );
  return {
    profileId: SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
    promptVersion: SPEAKER_ATTRIBUTION_PROMPT_VERSION,
    inputProtocolVersion: SPEAKER_ATTRIBUTION_INPUT_PROTOCOL_VERSION,
    schemaVersion: SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
    jsonSchemaName: 'speaker_wire_v2',
    packet: input.packet,
    prompt:
      input.taskKind === 'speaker_escalation'
        ? [
            'This is an independent adjudication. No primary model answer is available. Judge only from this packet.',
            buildCompactSpeakerAttributionPrompt(input.packet),
          ].join('\n')
        : buildCompactSpeakerAttributionPrompt(input.packet),
    responseSchema: compileSpeakerWireV2Schema(
      input.packet,
      input.providerId.startsWith('gemini-') ? 'gemini' : 'json_schema',
    ),
    outputBudget,
    generationPolicy,
    providerOptions: applyLLMGenerationPolicy(providerApiOptions, generationPolicy),
    parseResponse: parseSpeakerWireV2Json,
    validateResponse: (wire) => validateSpeakerWireV2(input.packet, wire),
  };
}
