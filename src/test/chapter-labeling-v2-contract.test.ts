import { describe, expect, it } from 'vitest';
import type { LabelChapterSegmentsInput } from '../providers/ai';
import {
  chapterLabelingV2ResponseSchema,
  chapterLabelingV2ResponseToResult,
  parseChapterLabelingV2Response,
  type ChapterLabelingResponseV2,
} from '../providers/chapter-labeling-v2-contract';
import {
  DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  LEGACY_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  resolveChapterLabelingRequestProfile,
} from '../providers/chapter-labeling-request-profile';
import { validateChapterLabelingResult } from '../providers/chapter-labeling-validator';

function input(): LabelChapterSegmentsInput {
  return {
    novelId: 'book_1',
    windowId: 'window_1',
    inputRevisionId: 'revision_1',
    chapter: {
      id: 'chapter_1',
      novelId: 'book_1',
      index: 1,
      title: '1화',
      normalizedText: '',
      textHash: 'chapter_hash',
      rawStartOffset: 0,
      rawEndOffset: 12,
      characterCount: 12,
      paragraphCount: 2,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    paragraphs: [
      {
        id: 'p1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        index: 0,
        text: '안녕.',
        startOffsetInChapter: 0,
        endOffsetInChapter: 3,
        textHash: 'p1_hash',
      },
      {
        id: 'p2',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        index: 1,
        text: '그가 웃었다.',
        startOffsetInChapter: 4,
        endOffsetInChapter: 10,
        textHash: 'p2_hash',
      },
    ],
    previousEpisodeContext: {
      chapterId: 'chapter_0',
      summary: '복도에서 만났다.',
      activeCharacterIds: ['char_a'],
      unresolved: ['문밖의 사람'],
    },
    knownCharacters: [
      {
        id: 'char_a',
        novelId: 'book_1',
        canonicalName: 'A',
        aliases: [],
        color: '#111111',
        description: '',
        confidence: 1,
        isUserConfirmed: true,
      },
      {
        id: 'char_b',
        novelId: 'book_1',
        canonicalName: 'B',
        aliases: [],
        color: '#222222',
        description: '',
        confidence: 1,
        isUserConfirmed: true,
      },
    ],
  };
}

function response(): ChapterLabelingResponseV2 {
  return {
    schema_version: 'chapter-labeling-v2',
    chapter_id: 'chapter_1',
    window_id: 'window_1',
    input_revision_id: 'revision_1',
    paragraph_results: [
      {
        paragraph_id: 'p1',
        coverage_complete: true,
        segments: [
          {
            start_offset: 0,
            end_offset: 3,
            type: 'quoted_dialogue',
            speaker_id: 'char_a',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'happy',
            prosody_intent: { pace: 'normal', intensity: 'medium', delivery: 'soft' },
            confidence: 0.9,
            evidence_codes: ['explicit_turn', 'recent_speaker'],
          },
        ],
      },
      {
        paragraph_id: 'p2',
        coverage_complete: true,
        segments: [
          {
            start_offset: 0,
            end_offset: 7,
            type: 'narration',
            speaker_id: 'narrator',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'neutral',
            confidence: 1,
            evidence_codes: ['narration_form'],
          },
        ],
      },
    ],
    context_delta: {
      summary: '인사를 마치고 웃었다.',
      location: '복도',
      active_add: ['char_b'],
      active_remove: [],
      interlocutor_upserts: [{ source_character_id: 'char_a', target_character_id: 'char_b', confidence: 0.8 }],
      unresolved_add: ['웃은 이유'],
      unresolved_resolve: ['문밖의 사람'],
    },
    uncertainties: [
      {
        paragraph_id: 'p1',
        span: [0, 3],
        reason_code: 'listener_implicit',
        candidate_ids: ['char_b'],
      },
    ],
  };
}

describe('ChapterLabelingResultV2', () => {
  it('converts paragraph-complete output to deterministic segments and preserves v2 annotations', () => {
    const result = chapterLabelingV2ResponseToResult(input(), response());

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      paragraphId: 'p1',
      speakerId: 'char_a',
      voiceProfileId: undefined,
      evidence: 'explicit_turn,recent_speaker',
    });
    expect(result.segments[0].id).toMatch(/^segment_/);
    expect(result.segmentAnnotations?.[result.segments[0].id]).toEqual({
      evidenceCodes: ['explicit_turn', 'recent_speaker'],
      prosodyIntent: { pace: 'normal', intensity: 'medium', delivery: 'soft' },
    });
    expect(result.uncertainties).toEqual([
      {
        paragraphId: 'p1',
        startOffset: 0,
        endOffset: 3,
        reasonCode: 'listener_implicit',
        candidateIds: ['char_b'],
      },
    ]);
    expect(result.episodeContextSummary).toEqual({
      chapterId: 'chapter_1',
      scene: '복도',
      activeCharacterIds: ['char_a', 'char_b'],
      unresolved: ['웃은 이유'],
      summaryForNextChapter: '인사를 마치고 웃었다.',
      interlocutorEdges: [{ sourceCharacterId: 'char_a', targetCharacterId: 'char_b', confidence: 0.8 }],
    });
  });

  it('rejects missing, duplicate, incomplete, and non-target paragraph results', () => {
    const missing = { ...response(), paragraph_results: response().paragraph_results.slice(0, 1) };
    expect(() => chapterLabelingV2ResponseToResult(input(), missing)).toThrow('missing target paragraphs');

    const duplicateSource = response();
    const duplicate = {
      ...duplicateSource,
      paragraph_results: [duplicateSource.paragraph_results[0], duplicateSource.paragraph_results[0]],
    };
    expect(() => chapterLabelingV2ResponseToResult(input(), duplicate)).toThrow('duplicates paragraph');

    const incomplete = response();
    incomplete.paragraph_results[0] = { ...incomplete.paragraph_results[0], coverage_complete: false };
    expect(() => chapterLabelingV2ResponseToResult(input(), incomplete)).toThrow('not coverage complete');

    const halo = response();
    halo.paragraph_results[0] = { ...halo.paragraph_results[0], paragraph_id: 'halo_before' };
    expect(() => chapterLabelingV2ResponseToResult(input(), halo)).toThrow('non-target paragraph');

    const staleRevision = { ...response(), input_revision_id: 'revision_stale' };
    expect(() => chapterLabelingV2ResponseToResult(input(), staleRevision)).toThrow('input_revision_id mismatch');
  });

  it('parses controlled emotion/prosody values and rejects invalid values', () => {
    expect(parseChapterLabelingV2Response(response()).schema_version).toBe('chapter-labeling-v2');
    const invalid = structuredClone(response()) as unknown as Record<string, unknown>;
    const paragraphs = invalid.paragraph_results as Array<Record<string, unknown>>;
    const segments = paragraphs[0].segments as Array<Record<string, unknown>>;
    segments[0].emotion = 'worried';
    expect(() => parseChapterLabelingV2Response(invalid)).toThrow('emotion is invalid');
  });

  it('uses v2 by default while retaining explicit v1 compatibility', () => {
    expect(DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID).toBe('chapter-labeling-v2-strict-tts');
    expect(resolveChapterLabelingRequestProfile(undefined).schemaVersion).toBe('chapter-labeling-v2');
    expect(
      resolveChapterLabelingRequestProfile({ requestProfileId: LEGACY_CHAPTER_LABELING_REQUEST_PROFILE_ID }).id,
    ).toBe('chapter-labeling-v1');
    expect(
      chapterLabelingV2ResponseSchema.properties.paragraph_results.items.properties.segments.items.properties
        .evidence_codes,
    ).toMatchObject({ minItems: 1 });
  });

  it('validates uncertainty and Episode Context character ids under the strict profile', () => {
    const labelingInput = input();
    const result = chapterLabelingV2ResponseToResult(labelingInput, response());
    expect(validateChapterLabelingResult({ ...labelingInput, result, validationPolicy: 'strict_tts' }).ok).toBe(true);

    const invalid = {
      ...result,
      uncertainties: [{ ...result.uncertainties![0], candidateIds: ['missing_character'] }],
      episodeContextSummary: {
        ...result.episodeContextSummary!,
        activeCharacterIds: ['char_a', 'missing_character'],
      },
    };
    const report = validateChapterLabelingResult({
      ...labelingInput,
      result: invalid,
      validationPolicy: 'strict_tts',
    });
    expect(report.summary.issueCodes).toEqual(
      expect.arrayContaining(['unknown_uncertainty_candidate_id', 'unknown_context_character_id']),
    );
  });
});
