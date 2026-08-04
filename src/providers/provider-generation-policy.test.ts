import { describe, expect, it } from 'vitest';
import {
  ServerStructuredJsonAIProvider,
  type ServerStructuredJsonGenerateInput,
} from '../../apps/server/src/providers/server-structured-json-provider';
import {
  DesktopStructuredJsonAIProvider,
  type DesktopStructuredJsonGenerateInput,
} from './desktop-structured-json-provider';
import { applyLLMGenerationPolicy, resolveLLMGenerationPolicy } from './provider-generation-policy';
import type { SceneSpeakerPacketV3 } from './speaker-attribution/contracts';
import { buildCompactSpeakerAttributionRequest } from './speaker-attribution/request-profile';

const compactPacket: SceneSpeakerPacketV3 = {
  version: 6,
  contract: 'scene-speaker-packet-v6',
  fingerprint: 'compact_packet_1',
  bookId: 'book_1',
  contentRevisionId: 'revision_1',
  chapterId: 'chapter_1',
  sceneId: 'scene_1',
  sourceRevision: 'source_1',
  sourceManifestFingerprint: 'manifest_1',
  spanInventoryHash: 'spans_1',
  mentionInventoryHash: 'mentions_1',
  candidateMemoryHash: 'candidates_1',
  temporalSnapshotId: 'temporal_1',
  temporalSnapshotHash: 'temporal_hash_1',
  dialogueBurstInventoryHash: 'bursts_1',
  sieveVersion: 'deterministic-speaker-sieve-v2',
  correctionCursor: 'none',
  mode: 'reader_safe',
  candidates: [[4, 'speaker_a', 'A', 1]],
  candidateSourceAnchors: [],
  mentions: [],
  mentionSourceIds: [],
  newMentionOrdinalsByTarget: [],
  recentTurns: [],
  relationDictionary: [],
  relationHints: [],
  dialogueBursts: [[0, [0], [4]]],
  contextEnvelope: {
    version: 'speaker-context-envelope-v4',
    blocks: [],
    targets: [[0, []]],
    fingerprint: 'context_1',
  },
  targets: [[0, 0, 1, 'Hello', [4], [1]]],
  ordinalDictionaryFingerprint: 'dictionary_1',
};

describe('LLM generation policy', () => {
  it('uses Gemini 3 model sampling with bounded minimal thinking', () => {
    const policy = resolveLLMGenerationPolicy({
      providerId: 'gemini-ai-studio',
      modelId: 'gemini-3.1-flash-lite',
      taskKind: 'speaker_attribution',
      requestedOutputCap: 1_024,
      visibleOutputEstimate: 420,
    });

    expect(policy).toMatchObject({
      version: 'llm-generation-policy-v2',
      modelFamily: 'gemini-3.x',
      sampling: 'model_default',
      reasoning: 'minimal',
      requestedOutputCap: 1_024,
      visibleOutputEstimate: 420,
    });
    expect(applyLLMGenerationPolicy({}, policy)).toEqual({
      thinkingConfig: { thinkingLevel: 'minimal' },
      maxOutputTokens: 1_024,
    });
  });

  it('preserves only explicit sampling overrides', () => {
    const policy = resolveLLMGenerationPolicy({
      providerId: 'openai',
      modelId: 'gpt-5-mini',
      taskKind: 'standard_labeling',
      providerOptions: { temperature: 0.35, topP: 0.9 },
    });

    expect(policy.sampling).toEqual({ temperature: 0.35, topP: 0.9, topK: undefined });
    expect(applyLLMGenerationPolicy({ temperature: 0.35, topP: 0.9 }, policy)).toEqual({
      temperature: 0.35,
      topP: 0.9,
    });
  });

  it('uses the Gemini 2.5 no-thinking contract without reusing 3.x fields', () => {
    const policy = resolveLLMGenerationPolicy({
      providerId: 'gemini-vertex',
      modelId: 'gemini-2.5-flash-lite',
      taskKind: 'standard_labeling',
    });

    expect(policy.reasoning).toBe('none');
    expect(applyLLMGenerationPolicy({}, policy)).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it('uses the lowest supported thinking level for Gemini 3.1 Pro', () => {
    const policy = resolveLLMGenerationPolicy({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.1-pro-preview',
      taskKind: 'speaker_escalation',
      requestedOutputCap: 512,
    });

    expect(policy.reasoning).toBe('low');
    expect(applyLLMGenerationPolicy({}, policy)).toEqual({
      thinkingConfig: { thinkingLevel: 'low' },
      maxOutputTokens: 512,
    });
  });

  it('uses low thinking only for Gemini 3.6 Flash speaker escalation', () => {
    const escalation = resolveLLMGenerationPolicy({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.6-flash',
      taskKind: 'speaker_escalation',
    });
    const ordinary = resolveLLMGenerationPolicy({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.6-flash',
      taskKind: 'speaker_attribution',
    });

    expect(escalation.reasoning).toBe('low');
    expect(ordinary.reasoning).toBe('minimal');
  });

  it('projects the same policy and provider options into hosted and native requests', async () => {
    const hostedInputs: ServerStructuredJsonGenerateInput[] = [];
    const nativeInputs: DesktopStructuredJsonGenerateInput[] = [];
    const options = {
      providerId: 'gemini-ai-studio',
      displayName: 'Gemini',
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: { maxOutputTokens: 768 },
    };
    const hosted = new ServerStructuredJsonAIProvider({
      ...options,
      client: {
        generateJson: async (input) => {
          hostedInputs.push(input);
          return '{}';
        },
      },
    });
    const native = new DesktopStructuredJsonAIProvider({
      ...options,
      generateJson: async (input) => {
        nativeInputs.push(input);
        return '{}';
      },
    });
    const chapter = {
      id: 'chapter_1',
      novelId: 'book_1',
      index: 0,
      title: 'Chapter 1',
      normalizedText: 'Hello',
      textHash: 'chapter_hash',
      rawStartOffset: 0,
      rawEndOffset: 5,
      characterCount: 5,
      paragraphCount: 1,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const paragraphs = [
      {
        id: 'paragraph_1',
        novelId: 'book_1',
        chapterId: chapter.id,
        index: 0,
        text: 'Hello',
        startOffsetInChapter: 0,
        endOffsetInChapter: 5,
        textHash: 'paragraph_hash',
      },
    ];

    await Promise.allSettled([
      hosted.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs }),
      native.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs }),
    ]);

    expect(hostedInputs[0].generationPolicy?.fingerprint).toBe(nativeInputs[0].generationPolicy?.fingerprint);
    expect(hostedInputs[0].providerOptions).toEqual(nativeInputs[0].providerOptions);
    expect(hostedInputs[0].providerOptions).toMatchObject({
      maxOutputTokens: 768,
      thinkingConfig: { thinkingLevel: 'minimal' },
    });
  });

  it('projects the same compact speaker contract through hosted and desktop adapters', async () => {
    const hostedInputs: ServerStructuredJsonGenerateInput[] = [];
    const desktopInputs: DesktopStructuredJsonGenerateInput[] = [];
    const options = {
      providerId: 'gemini-ai-studio',
      displayName: 'Gemini',
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: {
        speakerRiskRoutingV1: true,
        speakerEscalationEnabled: true,
        topP: 0.8,
      },
    };
    const wire = JSON.stringify({
      v: 2,
      f: compactPacket.fingerprint,
      s: [4],
      q: [900],
      e: [1],
      u: [],
      c: [],
      r: [],
      x: [],
    });
    const hosted = new ServerStructuredJsonAIProvider({
      ...options,
      client: {
        generateJson: async (input) => {
          hostedInputs.push(input);
          return wire;
        },
      },
    });
    const desktop = new DesktopStructuredJsonAIProvider({
      ...options,
      generateJson: async (input) => {
        desktopInputs.push(input);
        return wire;
      },
    });
    const pinned = buildCompactSpeakerAttributionRequest({
      packet: compactPacket,
      providerId: options.providerId,
      modelId: options.modelId,
      providerOptions: options.providerOptions,
    });

    const [hostedResult, desktopResult] = await Promise.all([
      hosted.attributeSpeakers({
        packet: compactPacket,
        generationPolicy: pinned.generationPolicy,
        outputBudget: pinned.outputBudget,
      }),
      desktop.attributeSpeakers({
        packet: compactPacket,
        generationPolicy: pinned.generationPolicy,
        outputBudget: pinned.outputBudget,
      }),
    ]);

    expect(hostedResult).toEqual(desktopResult);
    expect(hostedInputs[0].prompt).toBe(desktopInputs[0].prompt);
    expect(hostedInputs[0].responseSchema).toEqual(desktopInputs[0].responseSchema);
    expect(hostedInputs[0].generationPolicy).toEqual(desktopInputs[0].generationPolicy);
    expect(hostedInputs[0].providerOptions).toEqual(desktopInputs[0].providerOptions);
    expect(hostedInputs[0]).toMatchObject({
      jsonSchemaName: 'speaker_wire_v2',
      schemaVersion: 'speaker-wire-v2',
      providerOptions: expect.objectContaining({ topP: 0.8 }),
    });
    expect(hostedInputs[0].providerOptions).not.toHaveProperty('speakerRiskRoutingV1');
    expect(hostedInputs[0].providerOptions).not.toHaveProperty('speakerEscalationEnabled');
  });

  it('rejects stale compact speaker policies before dispatch', async () => {
    const generateJson = async () => '{}';
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'gemini-ai-studio',
      displayName: 'Gemini',
      modelId: 'gemini-3.1-flash-lite',
      generateJson,
    });
    const pinned = buildCompactSpeakerAttributionRequest({
      packet: compactPacket,
      providerId: provider.providerId,
      modelId: 'gemini-3.1-flash-lite',
    });

    await expect(
      provider.attributeSpeakers({
        packet: compactPacket,
        generationPolicy: { ...pinned.generationPolicy, fingerprint: 'stale' },
        outputBudget: pinned.outputBudget,
      }),
    ).rejects.toThrow(/pinned compact speaker generation policy/i);
  });
});
