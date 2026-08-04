import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Paragraph } from '@noveldesk/contracts';
import { hashSync } from '@noveldesk/text-core/legacy-hash';
import { AnthropicAIProvider, createAnthropicMessagesClient } from './anthropic-ai-provider.js';
import { GeminiAIStudioProvider } from './gemini-ai-studio-provider.js';
import { createOpenAIChatCompletionsClient, OpenAIAIProvider } from './openai-ai-provider.js';
import { supportsOpenAIStrictSchema, toStandardJsonSchema } from './server-structured-json-provider.js';
import { createServerAIProvider } from './server-ai-provider-factory.js';
import { loadServerAISettings } from './server-ai-config.js';
import { providerExecutionMetadataFromError } from '../../../../src/providers/provider-execution';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 0,
  title: 'Chapter 1',
  normalizedText: '',
  textHash: 'chapter_hash',
  rawStartOffset: 0,
  rawEndOffset: 8,
  characterCount: 8,
  paragraphCount: 1,
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
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

const providerJson = JSON.stringify({
  chapter_id: 'chapter_1',
  analysis_version: 1,
  segments: [
    {
      segment_id: 'segment_1',
      paragraph_id: 'paragraph_1',
      start_offset: 0,
      end_offset: 8,
      type: 'quoted_dialogue',
      speaker_id: 'unknown',
      candidate_speakers: ['char_1'],
      listener_ids: [],
      emotion: 'neutral',
      confidence: 0.7,
      evidence: 'Dialogue without enough context.',
      tts: { voice_profile_id: 'narrator_default', speed: 1, tone: 'calm' },
    },
  ],
  episode_context_summary: {
    scene: 'A short test scene.',
    active_characters: ['char_1'],
    unresolved: ['speaker remains uncertain'],
    summary_for_next_chapter: 'Speaker is still uncertain.',
  },
});

const providerV2Json = JSON.stringify({
  schema_version: 'chapter-labeling-v2',
  chapter_id: 'chapter_1',
  window_id: 'window_1',
  input_revision_id: 'revision_1',
  paragraph_results: [
    {
      paragraph_id: 'paragraph_1',
      coverage_complete: true,
      segments: [
        {
          start_offset: 0,
          end_offset: 8,
          type: 'quoted_dialogue',
          speaker_id: 'unknown',
          candidate_speakers: ['char_1'],
          listener_ids: [],
          emotion: 'neutral',
          prosody_intent: { pace: 'normal', intensity: 'medium', delivery: 'neutral' },
          confidence: 0.7,
          evidence_codes: ['speaker_ambiguous'],
        },
      ],
    },
  ],
  uncertainties: [
    {
      paragraph_id: 'paragraph_1',
      span: [0, 8],
      reason_code: 'speaker_ambiguous',
      candidate_ids: ['char_1'],
    },
  ],
});

const existingResult = {
  characters: [],
  segments: [
    {
      id: 'segment_old',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_1',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: 8,
      segmentTextHash: hashSync('"Hello."'),
      type: 'quoted_dialogue' as const,
      speakerId: 'unknown',
      candidateSpeakers: ['char_1'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.5,
      evidence: 'Existing label needs repair.',
      isUserCorrected: false,
    },
  ],
};

const graphProviderJson = JSON.stringify({
  novel_id: 'book_1',
  graph_version: 1,
  characters: [
    {
      character_id: 'char_1',
      canonical_name: 'Alex',
      aliases: ['Al'],
      color: '#3b82f6',
      description: 'Known protagonist.',
      confidence: 0.92,
    },
    {
      character_id: 'char_2',
      canonical_name: 'Blair',
      aliases: ['Captain'],
      color: '#ef476f',
      description: 'New relation candidate.',
      confidence: 0.81,
    },
  ],
  relations: [
    {
      source_character_id: 'char_1',
      target_character_id: 'char_2',
      relation_label: 'ally',
      terms_used_by_source: ['Captain'],
      terms_used_by_target: ['Alex'],
      confidence: 0.75,
      evidence: ['Alex calls Blair Captain.'],
    },
  ],
});

const bundleProviderJson = JSON.stringify({
  bundle_id: 'bundle_1',
  source_chapter_ids: ['chapter_1'],
  new_or_updated_characters: [
    {
      temporary_id: 'tmp_alex',
      canonical_name: 'Alex',
      aliases: ['Al'],
      honorifics: ['Captain'],
      possible_existing_character_ids: ['char_1'],
      description: 'Bundle candidate.',
      speech_style: 'Short direct lines.',
      confidence: 0.82,
      evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_1', note: 'Name appears.' }],
    },
    {
      temporary_id: 'tmp_blair',
      canonical_name: 'Blair',
      aliases: ['Captain'],
      confidence: 0.8,
      evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_1', note: 'Title appears.' }],
    },
  ],
  relations: [
    {
      source_character_name_or_alias: 'Alex',
      target_character_name_or_alias: 'Captain',
      relation: 'ally',
      terms_used: ['Captain'],
      confidence: 0.72,
      evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_1', note: 'Addressed as Captain.' }],
    },
  ],
  bundle_summary_for_next: 'Alex and Blair are likely allies.',
});

describe('external AI providers', () => {
  it('passes abort signals to OpenAI structured JSON fetch requests', async () => {
    const controller = new AbortController();
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: providerJson } }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const client = createOpenAIChatCompletionsClient({
      apiKey: 'openai-secret',
      baseUrl: 'https://openai.test/v1',
      fetchImpl,
    });

    await client.generateJson({
      modelId: 'gpt-test',
      prompt: 'Return JSON.',
      responseSchema: { type: 'OBJECT', properties: {} },
      jsonSchemaName: 'test_schema',
      signal: controller.signal,
    });

    expect(capturedInit?.signal).toBe(controller.signal);
  });

  it('maps fake OpenAI, Gemini AI Studio, and Anthropic clients through the shared chapter labeling contract', async () => {
    const generateJson = vi.fn(async () => providerJson);
    for (const provider of [
      new OpenAIAIProvider({
        modelId: 'gpt-labeler',
        providerOptions: { requestProfileId: 'chapter-labeling-v1' },
        client: { generateJson },
      }),
      new GeminiAIStudioProvider({
        modelId: 'gemini-labeler',
        providerOptions: { requestProfileId: 'chapter-labeling-v1' },
        client: { generateJson },
      }),
      new AnthropicAIProvider({
        modelId: 'claude-labeler',
        providerOptions: { requestProfileId: 'chapter-labeling-v1' },
        client: { generateJson },
      }),
    ]) {
      const result = await provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs });
      expect(result.segments).toEqual([
        expect.objectContaining({
          paragraphId: 'paragraph_1',
          speakerId: 'unknown',
          voiceProfileId: 'narrator_default',
        }),
      ]);
    }
    expect(generateJson).toHaveBeenCalledTimes(3);
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchemaName: 'chapter_labeling_result',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
      }),
    );
  });

  it('uses the v2 labeling contract by default through the shared provider adapter', async () => {
    const generateJson = vi.fn(async () => providerV2Json);
    const provider = new OpenAIAIProvider({ modelId: 'gpt-labeler', client: { generateJson } });

    const result = await provider.labelChapterSegments({
      novelId: 'book_1',
      chapter,
      paragraphs,
      windowId: 'window_1',
      inputRevisionId: 'revision_1',
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchemaName: 'chapter_labeling_v2_result',
        prompt: expect.stringContaining('"input_revision_id":"revision_1"'),
      }),
    );
    expect(result.segments[0]).toMatchObject({ speakerId: 'unknown', emotion: 'neutral' });
    expect(result.segmentAnnotations?.[result.segments[0].id]).toEqual({
      evidenceCodes: ['speaker_ambiguous'],
      prosodyIntent: { pace: 'normal', intensity: 'medium', delivery: 'neutral' },
    });
    expect(result.uncertainties).toEqual([
      expect.objectContaining({ paragraphId: 'paragraph_1', reasonCode: 'speaker_ambiguous' }),
    ]);
  });

  it('routes character graph merge through shared structured JSON adapters and strips graph profile options', async () => {
    let captured: { prompt?: string; jsonSchemaName?: string; providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return graphProviderJson;
    });
    const provider = new OpenAIAIProvider({
      modelId: 'gpt-labeler',
      providerOptions: {
        graphRequestProfileId: 'character-graph-merge-v1',
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.1,
      },
      client: { generateJson },
    });

    const result = await provider.mergeCharacterGraph({
      novelId: 'book_1',
      existingGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'char_1',
            novelId: 'book_1',
            canonicalName: 'Alex',
            aliases: ['Al'],
            color: '#3b82f6',
            description: 'Known protagonist.',
            confidence: 0.9,
            isUserConfirmed: true,
          },
        ],
        relations: [],
      },
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'char_2',
            novelId: 'book_1',
            canonicalName: 'Blair',
            aliases: ['Captain'],
            color: '#ef476f',
            description: 'New relation candidate.',
            confidence: 0.81,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      },
    });

    expect(result.relations).toEqual([
      expect.objectContaining({
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_2',
        relationLabel: 'ally',
      }),
    ]);
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchemaName: 'character_graph_merge_result',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
        providerOptions: { temperature: 0.1 },
        prompt: expect.stringContaining('"prompt_version":"character-graph-merge-v1"'),
      }),
    );
    expect(captured?.prompt).toContain('"existing_graph"');
    expect(captured?.prompt).toContain('"discovered_graph"');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('graphRequestProfileId');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
    expect(captured?.jsonSchemaName).toBe('character_graph_merge_result');
  });

  it('routes character bundle analysis through shared structured JSON adapters and strips bundle profile options', async () => {
    let captured: { prompt?: string; jsonSchemaName?: string; providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return bundleProviderJson;
    });
    const provider = new OpenAIAIProvider({
      modelId: 'gpt-labeler',
      providerOptions: {
        bundleRequestProfileId: 'character-bundle-analysis-v1',
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.15,
      },
      client: { generateJson },
    });

    const result = await provider.analyzeCharacterBundle?.({
      novelId: 'book_1',
      bundleId: 'bundle_1',
      chapters: [{ chapter, paragraphs }],
      existingGraph: { novelId: 'book_1', characters: [], relations: [] },
    });

    expect(result?.discoveredGraph.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalName: 'Alex' }),
        expect.objectContaining({ canonicalName: 'Blair' }),
      ]),
    );
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchemaName: 'character_bundle_analysis_result',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
        providerOptions: { temperature: 0.15 },
        prompt: expect.stringContaining('"prompt_version":"character-bundle-analysis-v1"'),
      }),
    );
    expect(captured?.prompt).toContain('"bundle_chapters"');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('bundleRequestProfileId');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
    expect(captured?.jsonSchemaName).toBe('character_bundle_analysis_result');
  });

  it('keeps chapter labeling request profile options out of provider API options', async () => {
    let captured: { providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return providerJson;
    });
    const provider = new OpenAIAIProvider({
      modelId: 'gpt-labeler',
      providerOptions: {
        requestProfileId: 'chapter-labeling-v1',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
      client: { generateJson },
    });

    await provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
        prompt: expect.stringContaining('"prompt_version":"chapter-labeler-v1"'),
      }),
    );
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
  });

  it('routes chapter label repair through the shared repair profile and strips profile-only options', async () => {
    let captured: { prompt?: string; providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return providerJson;
    });
    const provider = new OpenAIAIProvider({
      modelId: 'gpt-labeler',
      providerOptions: {
        repairRequestProfileId: 'chapter-label-repair-v1',
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.1,
      },
      client: { generateJson },
    });

    const result = await provider.repairChapterLabels({
      novelId: 'book_1',
      chapter,
      paragraphs,
      existingResult,
      validationIssues: [
        {
          severity: 'error',
          code: 'unknown_speaker_id',
          message: 'Speaker id needs repair.',
          segmentId: 'segment_old',
          paragraphId: 'paragraph_1',
        },
      ],
    });

    expect(result.segments).toEqual([
      expect.objectContaining({
        id: 'segment_old',
        speakerId: 'unknown',
        voiceProfileId: 'narrator_default',
      }),
    ]);
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonSchemaName: 'chapter_labeling_result',
        providerOptions: { temperature: 0.1 },
        prompt: expect.stringContaining('"prompt_version":"chapter-label-repair-v1"'),
      }),
    );
    expect(captured?.prompt).toContain('"repair_input"');
    expect(captured?.prompt).toContain('"existing_labeling_result"');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('repairRequestProfileId');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
  });

  it('builds OpenAI chat completions structured-output requests without exposing secrets in the body', async () => {
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: providerJson } }] }), { status: 200 });
    });
    const client = createOpenAIChatCompletionsClient({
      apiKey: 'openai-secret',
      baseUrl: 'https://openai.test/v1',
      fetchImpl,
    });

    await expect(
      client.generateJson({
        modelId: 'gpt-labeler',
        prompt: 'label this chapter',
        jsonSchemaName: 'chapter_labeling_result',
        responseSchema: { type: 'OBJECT', properties: { chapter_id: { type: 'STRING' } }, required: ['chapter_id'] },
        providerOptions: { temperature: 0.1, topP: 0.9, maxOutputTokens: 123 },
      }),
    ).resolves.toMatchObject({
      text: providerJson,
      executionMetadata: {
        providerId: 'openai',
        requestedModelId: 'gpt-labeler',
        structuredOutputMode: 'json_schema_strict',
      },
    });

    expect(captured?.url).toBe('https://openai.test/v1/chat/completions');
    expect(captured?.init.headers).toMatchObject({ Authorization: 'Bearer openai-secret' });
    expect(JSON.stringify(captured?.body)).not.toContain('openai-secret');
    expect(captured?.body).toMatchObject({
      model: 'gpt-labeler',
      temperature: 0.1,
      top_p: 0.9,
      max_completion_tokens: 123,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'chapter_labeling_result',
          strict: true,
          schema: expect.objectContaining({ type: 'object', additionalProperties: false }),
        },
      },
    });
  });

  it('builds Anthropic structured-output requests without exposing secrets in the body', async () => {
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: providerJson }] }), { status: 200 });
    });
    const client = createAnthropicMessagesClient({
      apiKey: 'anthropic-secret',
      baseUrl: 'https://anthropic.test/v1',
      anthropicVersion: '2026-01-01',
      fetchImpl,
    });

    await expect(
      client.generateJson({
        modelId: 'claude-labeler',
        prompt: 'label this chapter',
        jsonSchemaName: 'chapter_labeling_result',
        responseSchema: { type: 'OBJECT', properties: { chapter_id: { type: 'STRING' } }, required: ['chapter_id'] },
        providerOptions: { temperature: 0.1, topP: 0.9, maxOutputTokens: 321 },
      }),
    ).resolves.toMatchObject({
      text: providerJson,
      executionMetadata: {
        providerId: 'anthropic',
        requestedModelId: 'claude-labeler',
        structuredOutputMode: 'json_schema',
      },
    });

    expect(captured?.url).toBe('https://anthropic.test/v1/messages');
    expect(captured?.init.headers).toMatchObject({
      'x-api-key': 'anthropic-secret',
      'anthropic-version': '2026-01-01',
    });
    expect(JSON.stringify(captured?.body)).not.toContain('anthropic-secret');
    expect(captured?.body).toMatchObject({
      model: 'claude-labeler',
      max_tokens: 321,
      temperature: 0.1,
      top_p: 0.9,
      output_config: { format: { type: 'json_schema' } },
    });
  });

  it('keeps optional schema fields optional and disables OpenAI strict mode for that request', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = createOpenAIChatCompletionsClient({
      apiKey: 'openai-secret',
      baseUrl: 'https://openai.test/v1',
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: providerJson } }] }), { status: 200 });
      }),
    });

    await client.generateJson({
      modelId: 'gpt-labeler',
      prompt: 'label this chapter',
      jsonSchemaName: 'chapter_labeling_result',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          chapter_id: { type: 'STRING' },
          optional_summary: { type: 'STRING' },
        },
        required: ['chapter_id'],
      },
    });

    expect(capturedBody).toMatchObject({
      response_format: {
        json_schema: {
          strict: false,
          schema: {
            required: ['chapter_id'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('rejects truncated OpenAI output before the JSON parser boundary', async () => {
    const client = createOpenAIChatCompletionsClient({
      apiKey: 'openai-secret',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'openai_request_1',
              model: 'gpt-labeler-2026-07-11',
              choices: [{ finish_reason: 'length', message: { content: '{"partial":true' } }],
              usage: { prompt_tokens: 12, completion_tokens: 8 },
            }),
            { status: 200 },
          ),
      ),
    });

    await expect(
      client.generateJson({
        modelId: 'gpt-labeler',
        prompt: 'label this chapter',
        jsonSchemaName: 'chapter_labeling_result',
        responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
        schemaVersion: 'chapter-labeling-result-v1',
      }),
    ).rejects.toMatchObject({
      name: 'ProviderOutputIncompleteError',
      code: 'provider_output_incomplete',
      executionMetadata: {
        providerId: 'openai',
        finishReason: 'length',
        incompleteReason: 'length',
        inputTokens: 12,
        outputTokens: 8,
      },
    });
  });

  it('preserves allowlisted execution metadata when hosted response parsing fails', async () => {
    const provider = new OpenAIAIProvider({
      modelId: 'gpt-labeler',
      client: {
        generateJson: vi.fn(async () => ({
          text: '{"chapter_id":',
          executionMetadata: {
            providerId: 'openai',
            requestedModelId: 'gpt-labeler',
            finishReason: 'stop',
            latencyMs: 11,
            retryCount: 0,
            rawOutput: 'must not persist',
            apiKey: 'sk-must-not-persist',
          } as never,
        })),
      },
    });

    const error = await provider.labelChapterSegments({ novelId: 'book_1', chapter, paragraphs }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(providerExecutionMetadataFromError(error)).toMatchObject({
      providerId: 'openai',
      requestedModelId: 'gpt-labeler',
      finishReason: 'stop',
      latencyMs: 11,
      retryCount: 0,
      stage: 'standard_labeling',
    });
    expect(JSON.stringify(providerExecutionMetadataFromError(error))).not.toContain('must not persist');
  });

  it('rejects max-token Anthropic output with sanitized execution metadata', async () => {
    const client = createAnthropicMessagesClient({
      apiKey: 'anthropic-secret',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'anthropic_request_1',
              model: 'claude-labeler-2026-07-11',
              stop_reason: 'max_tokens',
              content: [{ type: 'text', text: '{"partial":true' }],
              usage: { input_tokens: 13, output_tokens: 9 },
            }),
            { status: 200 },
          ),
      ),
    });

    await expect(
      client.generateJson({
        modelId: 'claude-labeler',
        prompt: 'label this chapter',
        jsonSchemaName: 'chapter_labeling_result',
        responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
        schemaVersion: 'chapter-labeling-result-v1',
      }),
    ).rejects.toMatchObject({
      name: 'ProviderOutputIncompleteError',
      code: 'provider_output_incomplete',
      executionMetadata: {
        providerId: 'anthropic',
        finishReason: 'max_tokens',
        incompleteReason: 'max_tokens',
        inputTokens: 13,
        outputTokens: 9,
      },
    });
  });

  it.each([
    {
      name: 'OpenAI',
      client: createOpenAIChatCompletionsClient({
        apiKey: 'openai-secret',
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                id: 'openai_request_empty',
                choices: [{ finish_reason: 'length', message: {} }],
                usage: { prompt_tokens: 3, completion_tokens: 0 },
              }),
              { status: 200 },
            ),
        ),
      }),
      finishReason: 'length',
    },
    {
      name: 'Anthropic',
      client: createAnthropicMessagesClient({
        apiKey: 'anthropic-secret',
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                id: 'anthropic_request_empty',
                stop_reason: 'max_tokens',
                content: [],
                usage: { input_tokens: 3, output_tokens: 0 },
              }),
              { status: 200 },
            ),
        ),
      }),
      finishReason: 'max_tokens',
    },
  ])('classifies empty truncated $name responses before parsing', async ({ client, finishReason }) => {
    await expect(
      client.generateJson({
        modelId: 'labeler',
        prompt: 'label this chapter',
        jsonSchemaName: 'chapter_labeling_result',
        responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
      }),
    ).rejects.toMatchObject({
      code: 'provider_output_incomplete',
      executionMetadata: { finishReason, incompleteReason: finishReason },
    });
  });

  it('converts Gemini-style schemas without changing optional fields into required fields', () => {
    expect(
      toStandardJsonSchema({
        type: 'OBJECT',
        properties: {
          items: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    });
  });

  it('uses OpenAI strict mode only when every nested property is required', () => {
    const optional = toStandardJsonSchema({
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING' },
        detail: {
          type: 'OBJECT',
          properties: { note: { type: 'STRING' } },
        },
      },
      required: ['id'],
    });
    const strict = toStandardJsonSchema({
      type: 'OBJECT',
      properties: { id: { type: 'STRING' } },
      required: ['id'],
    });

    expect(supportsOpenAIStrictSchema(optional)).toBe(false);
    expect(supportsOpenAIStrictSchema(strict)).toBe(true);
    expect(optional).toMatchObject({
      required: ['id'],
      properties: { detail: { additionalProperties: false } },
    });
  });

  it('creates configured server AI providers by id without falling back to mock', () => {
    const settings = loadServerAISettings(
      {
        AI_PROVIDER_ENABLED: 'mock,openai,gemini-ai-studio,anthropic',
        AI_OPENAI_LABELING_MODEL_ID: 'gpt-labeler',
        AI_GEMINI_AI_STUDIO_LABELING_MODEL_ID: 'gemini-labeler',
        AI_ANTHROPIC_LABELING_MODEL_ID: 'claude-labeler',
        OPENAI_API_KEY: 'openai-secret',
        GEMINI_API_KEY: 'gemini-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
      },
      process.cwd(),
    );

    expect(createServerAIProvider({ providerId: 'openai', settings }).providerId).toBe('openai');
    expect(createServerAIProvider({ providerId: 'gemini-ai-studio', settings }).providerId).toBe('gemini-ai-studio');
    expect(createServerAIProvider({ providerId: 'anthropic', settings }).providerId).toBe('anthropic');
    expect(() => createServerAIProvider({ providerId: 'unknown-provider', settings })).toThrow(
      /Unsupported AI provider/,
    );
  });
});
