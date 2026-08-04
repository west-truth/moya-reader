import { describe, expect, it } from 'vitest';
import {
  buildProviderAdmissionSnapshot,
  calibrationProfileApplies,
  compareProviderUsageEstimate,
  parseProviderCapabilitySnapshot,
  projectConfidenceRisk,
  providerCapabilityFreshnessAt,
  resolveLLMCapabilitySnapshot,
  resolveProviderTaskProfile,
  resolveTTSCapabilitySnapshot,
} from './provider-capability';

describe('provider capability and admission', () => {
  it('uses conservative defaults and deterministic user overrides', () => {
    const fallback = resolveLLMCapabilitySnapshot({
      providerId: 'openai',
      modelId: 'model-a',
      verifiedAt: '2026-07-11T00:00:00Z',
    });
    const overridden = resolveLLMCapabilitySnapshot({
      providerId: 'openai',
      modelId: 'model-a',
      providerOptions: { contextWindowTokens: 16_000, maxOutputTokens: 2_000 },
      verifiedAt: '2026-07-11T00:00:00Z',
    });
    expect(fallback).toMatchObject({
      source: 'conservative_default',
      freshness: 'unverified',
      countStrategy: 'conservative_default',
    });
    expect(overridden).toMatchObject({ source: 'user_override', maxContextTokens: 16_000, maxOutputTokens: 2_000 });
    expect(overridden.id).not.toBe(fallback.id);
  });

  it('pins task policy, admission, and actual usage comparison', () => {
    const capability = resolveLLMCapabilitySnapshot({
      providerId: 'mock',
      modelId: 'mock-v1',
      providerOptions: { contextWindowTokens: 4_000, maxOutputTokens: 1_000, estimatedCharactersPerToken: 2 },
      verifiedAt: '2026-07-11T00:00:00Z',
    });
    const taskProfile = resolveProviderTaskProfile({
      jobType: 'chapter_segment_labeling',
      requestProfile: { id: 'label-v2', promptVersion: 'prompt-v2', schemaVersion: 'schema-v2' },
      providerId: 'mock',
      modelId: 'mock-v1',
    });
    const admission = buildProviderAdmissionSnapshot({
      capability,
      taskProfile,
      components: [{ key: 'target', characters: 4_000, required: true }],
      shrinkTrace: ['outer_halo_paragraph'],
    });
    expect(admission).toMatchObject({
      decision: 'accepted',
      estimatedInputTokens: 2_000,
      shrinkTrace: ['outer_halo_paragraph'],
    });
    const requestSizedAdmission = buildProviderAdmissionSnapshot({
      capability,
      taskProfile,
      components: [{ key: 'target', characters: 4_000, required: true }],
      reservedOutputTokens: 512,
    });
    expect(requestSizedAdmission).toMatchObject({ reservedOutputTokens: 512, availableInputTokens: 3_088 });
    expect(
      compareProviderUsageEstimate(capability, admission, {
        providerId: 'mock',
        requestedModelId: 'mock-v1',
        latencyMs: 10,
        retryCount: 0,
        inputTokens: 2_200,
        outputTokens: 500,
      }),
    ).toMatchObject({ inputTokenDelta: 200, inputTokenRatio: 1.1, actualOutputTokens: 500, modelVersionDrift: false });
  });

  it('normalizes TTS constraints and does not show raw confidence as calibrated probability', () => {
    const tts = resolveTTSCapabilitySnapshot({
      providerId: 'local-endpoint',
      providerOptions: { maxInputCharacters: 20_000, formats: ['wav'], timingMarks: 'segment' },
      verifiedAt: '2026-07-11T00:00:00Z',
      ttlMs: 1_000,
    });
    expect(parseProviderCapabilitySnapshot(tts)).toMatchObject({
      maxTextCharacters: 20_000,
      formats: ['wav'],
      timingMarks: 'segment',
    });
    expect(providerCapabilityFreshnessAt(tts, '2026-07-11T00:00:02Z')).toBe('stale');
    expect(projectConfidenceRisk({ rawConfidence: 0.92 })).toEqual({
      risk: 'low',
      displayMode: 'risk_bucket',
      deterministicSignals: [],
      calibratedCorrectness: undefined,
    });
    expect(projectConfidenceRisk({ rawConfidence: 0.92, deterministicSignals: ['graph_contradiction'] }).risk).toBe(
      'medium',
    );
    const calibration = {
      id: 'cal-1',
      providerId: 'openai',
      requestedModelId: 'model-a',
      resolvedModelVersion: 'model-a-2026',
      taskProfileId: 'task-1',
      corpusFingerprint: 'corpus-1',
      buckets: [],
      minimumSamples: 20,
      createdAt: '2026-07-11T00:00:00Z',
    };
    expect(
      calibrationProfileApplies({
        calibration,
        providerId: 'openai',
        requestedModelId: 'model-a',
        resolvedModelVersion: 'model-a-2026',
        taskProfileId: 'task-1',
        corpusFingerprint: 'corpus-1',
      }),
    ).toBe(true);
    expect(
      calibrationProfileApplies({
        calibration,
        providerId: 'openai',
        requestedModelId: 'model-a',
        resolvedModelVersion: 'model-a-2027',
        taskProfileId: 'task-1',
        corpusFingerprint: 'corpus-1',
      }),
    ).toBe(false);
  });
});
