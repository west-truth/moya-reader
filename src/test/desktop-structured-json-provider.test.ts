import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Character, LabeledSegment, Paragraph } from '../domain/types';
import {
  DesktopStructuredJsonAIProvider,
  desktopStructuredJsonProviderName,
  runDesktopStructuredJsonSample,
  type DesktopStructuredJsonGenerateInput,
} from '../providers/desktop-structured-json-provider';
import { STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID } from '../providers/chapter-labeling-request-profile';
import { providerExecutionMetadataFromError } from '../providers/provider-execution';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 1,
  title: '1화',
  normalizedText: '',
  textHash: 'chapter_hash',
  rawStartOffset: 0,
  rawEndOffset: 8,
  characterCount: 8,
  paragraphCount: 1,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
};

const paragraphs: Paragraph[] = [
  {
    id: 'paragraph_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 0,
    text: '"Hello."',
    startOffsetInChapter: 0,
    endOffsetInChapter: 8,
    textHash: 'paragraph_hash',
  },
];

const characters: Character[] = [
  {
    id: 'char_hero',
    novelId: 'book_1',
    canonicalName: 'Hero',
    aliases: ['H'],
    color: '#3b82f6',
    description: 'Existing protagonist.',
    confidence: 0.9,
    isUserConfirmed: false,
  },
];

const existingSegments: LabeledSegment[] = [
  {
    id: 'segment_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_1',
    segmentIndex: 0,
    startOffset: 0,
    endOffset: 8,
    segmentTextHash: 'old_hash',
    type: 'quoted_dialogue',
    speakerId: 'unknown',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.5,
    evidence: 'Needs repair.',
    isUserCorrected: false,
  },
];

describe('DesktopStructuredJsonAIProvider', () => {
  it('runs a desktop sample JSON request and strips profile-only options', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        ok: true,
        message: 'ready',
      }),
    );

    const result = await runDesktopStructuredJsonSample({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      providerOptions: {
        requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        autoRepairOnValidationFailure: true,
        graphRequestProfileId: 'character-graph-merge-v1',
        temperature: 0.1,
      },
      generateJson,
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        jsonSchemaName: 'noveldesk_provider_smoke',
        providerOptions: { temperature: 0.1 },
      }),
    );
    expect(generateJson.mock.calls[0][0].prompt).toContain('provider connectivity smoke test');
    expect(result).toEqual({
      ok: true,
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      message: 'ready',
    });
  });

  it('rejects invalid desktop sample JSON before reporting success', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        ok: false,
        message: 'nope',
      }),
    );

    await expect(
      runDesktopStructuredJsonSample({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        generateJson,
      }),
    ).rejects.toThrow('준비 상태');
  });

  it('names the desktop Vertex provider and forwards non-secret Vertex options', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        chapter_id: 'chapter_1',
        analysis_version: 1,
        segments: [],
      }),
    );
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'gemini-vertex',
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: {
        project: 'demo-project',
        location: 'global',
        requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
      },
      generateJson,
    });

    await provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs });

    expect(desktopStructuredJsonProviderName('gemini-vertex')).toBe('Gemini Vertex');
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'gemini-vertex',
        modelId: 'gemini-3.1-flash-lite',
        providerOptions: expect.objectContaining({
          project: 'demo-project',
          location: 'global',
          thinkingConfig: { thinkingLevel: 'minimal' },
        }),
        generationPolicy: expect.objectContaining({
          taskKind: 'standard_labeling',
          reasoning: 'minimal',
        }),
      }),
    );
  });

  it('uses the provider-neutral chapter labeling contract and parses generated JSON', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        chapter_id: 'chapter_1',
        analysis_version: 1,
        segments: [
          {
            paragraph_id: 'paragraph_1',
            start_offset: 0,
            end_offset: 8,
            type: 'quoted_dialogue',
            speaker_id: 'unknown',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'neutral',
            confidence: 0.7,
            evidence: 'Quoted line without enough context.',
          },
        ],
      }),
    );
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      providerOptions: {
        requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
      generateJson,
    });

    const result = await provider.labelChapterSegments({
      novelId: 'book_1',
      chapter,
      paragraphs,
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        jsonSchemaName: 'chapter_labeling_result',
        providerOptions: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    );
    expect(generateJson.mock.calls[0][0].prompt).toContain('"request_profile_id":"chapter-labeling-v1-strict-tts"');
    expect(result.segments).toEqual([
      expect.objectContaining({
        paragraphId: 'paragraph_1',
        startOffset: 0,
        endOffset: 8,
        speakerId: 'unknown',
        emotion: 'neutral',
      }),
    ]);
    expect(result.characters).toEqual([]);
  });

  it('rejects empty model ids before crossing the desktop bridge', async () => {
    const generateJson = vi.fn();
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'openai',
      modelId: ' ',
      generateJson,
    });

    await expect(provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs })).rejects.toThrow(
      'model id is required',
    );
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('exposes native execution metadata once without returning provider secrets', async () => {
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'openai',
      modelId: 'gpt-labeler',
      providerOptions: { requestProfileId: 'chapter-labeling-v1' },
      generateJson: vi.fn(async () => ({
        text: JSON.stringify({
          chapter_id: 'chapter_1',
          analysis_version: 1,
          segments: [
            {
              paragraph_id: 'paragraph_1',
              start_offset: 0,
              end_offset: 8,
              type: 'narration',
              speaker_id: 'narrator',
              candidate_speakers: [],
              listener_ids: [],
              emotion: 'neutral',
              confidence: 1,
              evidence: 'source',
            },
          ],
        }),
        executionMetadata: {
          providerId: 'openai',
          requestedModelId: 'gpt-labeler',
          finishReason: 'stop',
          latencyMs: 5,
          retryCount: 0,
        },
      })),
    });

    await provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs });

    expect(provider.takeExecutionMetadata()).toMatchObject({
      providerId: 'openai',
      finishReason: 'stop',
      latencyMs: 5,
    });
    expect(provider.takeExecutionMetadata()).toBeUndefined();
  });

  it('attaches sanitized execution metadata when native response parsing fails', async () => {
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'openai',
      modelId: 'gpt-labeler',
      generateJson: vi.fn(async () => ({
        text: '{"chapter_id":',
        executionMetadata: {
          providerId: 'openai',
          requestedModelId: 'gpt-labeler',
          finishReason: 'stop',
          latencyMs: 7,
          retryCount: 0,
        },
      })),
    });

    const error = await provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(providerExecutionMetadataFromError(error)).toMatchObject({
      providerId: 'openai',
      finishReason: 'stop',
      latencyMs: 7,
    });
    expect(provider.takeExecutionMetadata()).toBeUndefined();
  });

  it('uses the repair request profile through the desktop bridge', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        chapter_id: 'chapter_1',
        analysis_version: 1,
        characters: [],
        segments: [
          {
            paragraph_id: 'paragraph_1',
            start_offset: 0,
            end_offset: 8,
            type: 'quoted_dialogue',
            speaker_id: 'unknown',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'uncertain',
            confidence: 0.6,
            evidence: 'Repaired uncertainty.',
          },
        ],
      }),
    );
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      providerOptions: {
        requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        repairRequestProfileId: 'chapter-label-repair-v1',
        temperature: 0.1,
      },
      generateJson,
    });

    const result = await provider.repairChapterLabels({
      novelId: 'book_1',
      chapter,
      paragraphs,
      knownCharacters: characters,
      existingResult: { characters, segments: existingSegments },
      validationIssues: [
        {
          severity: 'error',
          code: 'segment_text_hash_mismatch',
          message: 'Hash mismatch.',
          segmentId: 'segment_1',
          paragraphId: 'paragraph_1',
        },
      ],
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchemaName: 'chapter_labeling_result',
        providerOptions: { temperature: 0.1 },
      }),
    );
    expect(generateJson.mock.calls[0][0].prompt).toContain('"request_profile_id":"chapter-label-repair-v1"');
    expect(result.segments[0]).toEqual(
      expect.objectContaining({
        paragraphId: 'paragraph_1',
        emotion: 'uncertain',
      }),
    );
  });

  it('uses the bundle analysis request profile through the desktop bridge', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        bundle_id: 'bundle_1',
        source_chapter_ids: ['chapter_1'],
        new_or_updated_characters: [
          {
            temporary_id: 'tmp_hero',
            canonical_name: 'Hero',
            aliases: ['H'],
            confidence: 0.82,
            evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_1', note: 'Named in dialogue.' }],
          },
        ],
        relations: [],
        bundle_summary_for_next: 'Hero speaks in chapter 1.',
      }),
    );
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'gemini-ai-studio',
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: {
        bundleRequestProfileId: 'character-bundle-analysis-v1',
        maxOutputTokens: 4096,
      },
      generateJson,
    });

    const result = await provider.analyzeCharacterBundle({
      novelId: 'book_1',
      bundleId: 'bundle_1',
      chapters: [{ chapter, paragraphs }],
      existingGraph: { novelId: 'book_1', characters, relations: [] },
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'gemini-ai-studio',
        jsonSchemaName: 'character_bundle_analysis_result',
        providerOptions: { maxOutputTokens: 4096 },
      }),
    );
    expect(generateJson.mock.calls[0][0].prompt).toContain('"request_profile_id":"character-bundle-analysis-v1"');
    expect(result.discoveredGraph.characters[0]).toEqual(
      expect.objectContaining({
        canonicalName: 'Hero',
        confidence: 0.82,
      }),
    );
    expect(result.bundleSummaryForNext).toBe('Hero speaks in chapter 1.');
  });

  it('uses the graph merge request profile through the desktop bridge', async () => {
    const generateJson = vi.fn(async (_input: DesktopStructuredJsonGenerateInput) =>
      JSON.stringify({
        novel_id: 'book_1',
        graph_version: 1,
        characters: [
          {
            character_id: 'char_hero',
            canonical_name: 'Hero',
            aliases: ['H', 'Hero'],
            color: '#3b82f6',
            description: 'Merged protagonist.',
            confidence: 0.91,
          },
        ],
        relations: [],
      }),
    );
    const provider = new DesktopStructuredJsonAIProvider({
      providerId: 'anthropic',
      modelId: 'claude-3-5-haiku-latest',
      providerOptions: {
        graphRequestProfileId: 'character-graph-merge-v1',
        topP: 0.8,
      },
      generateJson,
    });

    const graph = await provider.mergeCharacterGraph({
      novelId: 'book_1',
      existingGraph: { novelId: 'book_1', characters, relations: [] },
      discoveredGraph: { novelId: 'book_1', characters, relations: [] },
      sourceContext: { bundleId: 'bundle_1', chapterIds: ['chapter_1'], summary: 'Hero appears.' },
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        jsonSchemaName: 'character_graph_merge_result',
        providerOptions: { topP: 0.8 },
      }),
    );
    expect(generateJson.mock.calls[0][0].prompt).toContain('"request_profile_id":"character-graph-merge-v1"');
    expect(graph.characters[0]).toEqual(
      expect.objectContaining({
        id: 'char_hero',
        canonicalName: 'Hero',
      }),
    );
    expect(graph.characters[0]?.aliases).toContain('H');
  });
});
