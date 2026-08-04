import { describe, expect, it, vi } from 'vitest';
import type { SceneSpeakerPacketV3 } from '../../../../src/providers/speaker-attribution/contracts';
import { buildCompactSpeakerAttributionRequest } from '../../../../src/providers/speaker-attribution/request-profile';
import { GeminiVertexAIProvider } from './gemini-vertex-ai-provider.js';

function speakerPacket(): SceneSpeakerPacketV3 {
  return {
    version: 6,
    contract: 'scene-speaker-packet-v6',
    fingerprint: 'packet_fingerprint',
    bookId: 'book_1',
    contentRevisionId: 'content_1',
    chapterId: 'chapter_1',
    sceneId: 'scene_1',
    sourceRevision: 'source_1',
    sourceManifestFingerprint: 'manifest_1',
    spanInventoryHash: 'spans_1',
    mentionInventoryHash: 'mentions_1',
    candidateMemoryHash: 'memory_1',
    temporalSnapshotId: 'snapshot_1',
    temporalSnapshotHash: 'snapshot_hash_1',
    dialogueBurstInventoryHash: 'bursts_1',
    sieveVersion: 'sieve_1',
    correctionCursor: 'none',
    mode: 'reader_safe',
    candidates: [[4, 'entity_1', 'candidate_1', 0]],
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
    targets: [[0, 0, 1, 'Hello', [4], [0]]],
    ordinalDictionaryFingerprint: 'ordinals_1',
  };
}

describe('GeminiVertexAIProvider', () => {
  it('runs compact speaker attribution through the Vertex structured provider boundary', async () => {
    const packet = speakerPacket();
    const generateJson = vi.fn(async () =>
      JSON.stringify({
        v: 2,
        f: packet.fingerprint,
        s: [4],
        q: [910],
        e: [0],
        u: [],
        c: [],
        r: [],
        x: [],
      }),
    );
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: { compactSpeakerAttributionV3: true },
      client: { generateJson },
    });
    const request = buildCompactSpeakerAttributionRequest({
      packet,
      providerId: provider.providerId,
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: { compactSpeakerAttributionV3: true },
    });

    const result = await provider.attributeSpeakers({
      packet,
      generationPolicy: request.generationPolicy,
      outputBudget: request.outputBudget,
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-lite',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
        providerOptions: expect.not.objectContaining({ compactSpeakerAttributionV3: true }),
        generationPolicy: expect.objectContaining({ taskKind: 'speaker_attribution', reasoning: 'minimal' }),
      }),
    );
    expect(result.packetFingerprint).toBe(packet.fingerprint);
    expect(result.validatedWire.wire.s).toEqual([4]);
  });

  it('can deduplicate review rows and downgrade ungrounded new entities to review', async () => {
    const packet: SceneSpeakerPacketV3 = {
      ...speakerPacket(),
      mentions: [
        [0, 'grounded', 0],
        [1, 'not-grounded-for-target', 0],
      ],
      newMentionOrdinalsByTarget: [[0, [0]]],
    };
    const request = buildCompactSpeakerAttributionRequest({
      packet,
      providerId: 'gemini-vertex',
      modelId: 'gemini-3-flash',
      taskKind: 'speaker_escalation',
    });
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      repairSafeSpeakerWireV2Structure: true,
      client: {
        generateJson: vi.fn(async () =>
          JSON.stringify({
            v: 2,
            f: packet.fingerprint,
            s: [3],
            q: [700],
            e: [0],
            u: [0, 0],
            c: [[3], [4]],
            r: [8, 4],
            x: [[0, 1]],
          }),
        ),
      },
    });

    const result = await provider.attributeSpeakers!({
      packet,
      generationPolicy: request.generationPolicy,
      outputBudget: request.outputBudget,
      mode: 'independent_escalation',
    });

    expect(result.validatedWire.wire.s).toEqual([2]);
    expect(result.validatedWire.wire.u).toEqual([0]);
    expect(result.validatedWire.wire.c).toEqual([[2, 4]]);
    expect(result.validatedWire.wire.r[0]).toBe(14);
    expect(result.validatedWire.wire.x).toEqual([]);
    expect(result.validatedWire.reviewTargetPositions).toEqual([0]);
  });

  it('can downgrade a speaker outside the target candidates and discard its alternative', async () => {
    const packet: SceneSpeakerPacketV3 = {
      ...speakerPacket(),
      candidates: [
        [4, 'entity_1', 'candidate_1', 0],
        [5, 'entity_2', 'candidate_2', 0],
      ],
    };
    const request = buildCompactSpeakerAttributionRequest({
      packet,
      providerId: 'gemini-vertex',
      modelId: 'gemini-3-flash',
      taskKind: 'speaker_escalation',
    });
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      repairSafeSpeakerWireV2Structure: true,
      client: {
        generateJson: vi.fn(async () =>
          JSON.stringify({
            v: 2,
            f: packet.fingerprint,
            s: [5],
            q: [800],
            e: [0],
            u: [0],
            c: [[5]],
            r: [4],
            x: [],
          }),
        ),
      },
    });

    const result = await provider.attributeSpeakers!({
      packet,
      generationPolicy: request.generationPolicy,
      outputBudget: request.outputBudget,
      mode: 'independent_escalation',
    });

    expect(result.validatedWire.wire.s).toEqual([2]);
    expect(result.validatedWire.wire.c).toEqual([[2]]);
    expect(result.validatedWire.wire.r[0]).toBe(6);
    expect(result.validatedWire.reviewTargetPositions).toEqual([0]);
  });

  it('builds a schema-constrained chapter labeling request and maps validated JSON output', async () => {
    let captured: { providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return JSON.stringify({
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
    });
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      providerOptions: { requestProfileId: 'chapter-labeling-v1', temperature: 0.2 },
      client: { generateJson },
    });

    const result = await provider.labelChapterSegments({
      novelId: 'book_1',
      chapter: {
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
      },
      paragraphs: [
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
      ],
    });

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-3-flash',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
        providerOptions: {
          temperature: 0.2,
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
        generationPolicy: expect.objectContaining({ taskKind: 'standard_labeling', reasoning: 'minimal' }),
      }),
    );
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
    expect(result.segments).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^segment_[0-9a-f]{32}$/),
        paragraphId: 'paragraph_1',
        speakerId: 'unknown',
        candidateSpeakers: ['char_1'],
        voiceProfileId: 'narrator_default',
      }),
    ]);
    expect(result.episodeContextSummary).toMatchObject({
      chapterId: 'chapter_1',
      activeCharacterIds: ['char_1'],
      summaryForNextChapter: 'Speaker is still uncertain.',
    });
  });

  it('rejects provider output with invalid paragraph offsets before storage', async () => {
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      providerOptions: { requestProfileId: 'chapter-labeling-v1' },
      client: {
        generateJson: vi.fn(async () =>
          JSON.stringify({
            chapter_id: 'chapter_1',
            analysis_version: 1,
            segments: [
              {
                paragraph_id: 'paragraph_1',
                start_offset: 0,
                end_offset: 99,
                type: 'narration',
                speaker_id: 'narrator',
                candidate_speakers: [],
                listener_ids: [],
                emotion: 'neutral',
                confidence: 1,
                evidence: 'Invalid range.',
              },
            ],
          }),
        ),
      },
    });

    await expect(
      provider.labelChapterSegments({
        novelId: 'book_1',
        chapter: {
          id: 'chapter_1',
          novelId: 'book_1',
          index: 0,
          title: 'Chapter 1',
          normalizedText: '',
          textHash: 'chapter_hash',
          rawStartOffset: 0,
          rawEndOffset: 5,
          characterCount: 5,
          paragraphCount: 1,
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:00.000Z',
        },
        paragraphs: [
          {
            id: 'paragraph_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            index: 0,
            text: 'Short',
            startOffsetInChapter: 0,
            endOffsetInChapter: 5,
            textHash: 'paragraph_hash',
          },
        ],
      }),
    ).rejects.toThrow(/offsets out of range/);
  });

  it('rejects hallucinated trailing segments that start after the paragraph text', async () => {
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      providerOptions: { requestProfileId: 'chapter-labeling-v1' },
      client: {
        generateJson: vi.fn(async () =>
          JSON.stringify({
            chapter_id: 'chapter_1',
            analysis_version: 1,
            segments: [
              {
                paragraph_id: 'paragraph_1',
                start_offset: 6,
                end_offset: 12,
                type: 'narration',
                speaker_id: 'narrator',
                candidate_speakers: [],
                listener_ids: [],
                emotion: 'neutral',
                confidence: 1,
                evidence: 'Nonexistent trailing span.',
              },
            ],
          }),
        ),
      },
    });

    await expect(
      provider.labelChapterSegments({
        novelId: 'book_1',
        chapter: {
          id: 'chapter_1',
          novelId: 'book_1',
          index: 0,
          title: 'Chapter 1',
          normalizedText: '',
          textHash: 'chapter_hash',
          rawStartOffset: 0,
          rawEndOffset: 5,
          characterCount: 5,
          paragraphCount: 1,
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:00.000Z',
        },
        paragraphs: [
          {
            id: 'paragraph_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            index: 0,
            text: 'Short',
            startOffsetInChapter: 0,
            endOffsetInChapter: 5,
            textHash: 'paragraph_hash',
          },
        ],
      }),
    ).rejects.toThrow(/offsets out of range/);
  });

  it('builds a schema-constrained chapter label repair request without leaking profile options', async () => {
    let captured: { prompt?: string; providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return JSON.stringify({
        chapter_id: 'chapter_1',
        analysis_version: 2,
        segments: [
          {
            segment_id: 'segment_old',
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
          },
        ],
      });
    });
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      providerOptions: {
        repairRequestProfileId: 'chapter-label-repair-v1',
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.2,
      },
      client: { generateJson },
    });

    const result = await provider.repairChapterLabels({
      novelId: 'book_1',
      chapter: {
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
      },
      paragraphs: [
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
      ],
      existingResult: {
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
            segmentTextHash: 'old_hash',
            type: 'quoted_dialogue',
            speakerId: 'unknown',
            candidateSpeakers: ['char_1'],
            listenerIds: [],
            emotion: 'neutral',
            confidence: 0.5,
            evidence: 'Existing uncertain label.',
            isUserCorrected: false,
          },
        ],
      },
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

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-3-flash',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
        providerOptions: {
          temperature: 0.2,
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
        generationPolicy: expect.objectContaining({ taskKind: 'patch_repair', reasoning: 'minimal' }),
        prompt: expect.stringContaining('"prompt_version":"chapter-label-repair-v1"'),
      }),
    );
    expect(captured?.prompt).toContain('"repair_input"');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('repairRequestProfileId');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
    expect(result.segments).toEqual([
      expect.objectContaining({
        id: 'segment_old',
        paragraphId: 'paragraph_1',
        speakerId: 'unknown',
      }),
    ]);
  });

  it('builds a schema-constrained character graph merge request without leaking graph profile options', async () => {
    let captured: { prompt?: string; providerOptions?: unknown } | undefined;
    const generateJson = vi.fn(async (input) => {
      captured = input;
      return JSON.stringify({
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
    });
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      providerOptions: {
        graphRequestProfileId: 'character-graph-merge-v1',
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.2,
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

    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-3-flash',
        responseSchema: expect.objectContaining({ type: 'OBJECT' }),
        providerOptions: { temperature: 0.2 },
        prompt: expect.stringContaining('"prompt_version":"character-graph-merge-v1"'),
      }),
    );
    expect(captured?.prompt).toContain('"existing_graph"');
    expect(captured?.prompt).toContain('"discovered_graph"');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('graphRequestProfileId');
    expect(JSON.stringify(captured?.providerOptions)).not.toContain('requestProfileId');
    expect(result.relations).toEqual([
      expect.objectContaining({
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_2',
        relationLabel: 'ally',
      }),
    ]);
  });

  it('can restore omitted graph identities from the merge input before strict validation', async () => {
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      restoreMissingCharacterGraphIds: true,
      client: {
        generateJson: vi.fn(async () =>
          JSON.stringify({
            novel_id: 'book_1',
            graph_version: 2,
            characters: [],
            relations: [],
          }),
        ),
      },
    });
    const result = await provider.mergeCharacterGraph({
      novelId: 'book_1',
      existingGraph: { novelId: 'book_1', characters: [], relations: [] },
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'char_1',
            novelId: 'book_1',
            canonicalName: 'Alex',
            aliases: ['Al'],
            color: '#3b82f6',
            confidence: 0.8,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      },
    });

    expect(result.characters).toEqual([
      expect.objectContaining({ id: 'char_1', canonicalName: 'Alex', aliases: ['Al'] }),
    ]);
  });

  it('can discard only bundle relations whose endpoint is not a returned character', async () => {
    const provider = new GeminiVertexAIProvider({
      project: 'project-test',
      location: 'global',
      modelId: 'gemini-3-flash',
      dropUnresolvableCharacterBundleRelations: true,
      client: {
        generateJson: vi.fn(async () =>
          JSON.stringify({
            bundle_id: 'bundle_1',
            source_chapter_ids: [],
            new_or_updated_characters: [
              {
                temporary_id: 'temp_1',
                canonical_name: 'Alex',
                aliases: ['Al'],
                confidence: 0.8,
                evidence: [],
              },
            ],
            relations: [
              {
                source_character_name_or_alias: 'Alex',
                target_character_name_or_alias: 'Missing',
                relation: 'unknown',
                terms_used: [],
                confidence: 0.2,
                evidence: [],
              },
            ],
          }),
        ),
      },
    });
    const result = await provider.analyzeCharacterBundle({
      novelId: 'book_1',
      bundleId: 'bundle_1',
      chapters: [],
      existingGraph: { novelId: 'book_1', characters: [], relations: [] },
    });

    expect(result.discoveredGraph.characters).toHaveLength(1);
    expect(result.discoveredGraph.relations).toEqual([]);
  });
});
