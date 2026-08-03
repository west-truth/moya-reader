import type { SegmentType } from '../domain/types';
import type {
  ChapterLabelingResult,
  ChapterLabelingSegmentAnnotation,
  ChapterLabelingUncertainty,
  LabelChapterSegmentsInput,
} from './ai';
import {
  chapterLabelingResponseToResult,
  CONTROLLED_TTS_EMOTIONS,
  type ChapterLabelingLLMResponse,
  type ChapterLabelingLLMSegment,
} from './chapter-labeling-contract';

export const CHAPTER_LABELING_V2_SCHEMA_VERSION = 'chapter-labeling-v2' as const;

export const CONTROLLED_TTS_SEGMENT_TYPES: readonly SegmentType[] = [
  'narration',
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'system_message',
  'sfx',
  'author_note',
  'unknown',
];
export const CONTROLLED_TTS_PACES = ['slow', 'normal', 'fast'] as const;
export const CONTROLLED_TTS_INTENSITIES = ['low', 'medium', 'high'] as const;
export const CONTROLLED_TTS_DELIVERIES = ['neutral', 'soft', 'firm', 'whisper', 'shout', 'trembling'] as const;

export interface ChapterLabelingV2Segment {
  readonly start_offset: number;
  readonly end_offset: number;
  readonly type: SegmentType;
  readonly speaker_id: string;
  readonly candidate_speakers: string[];
  readonly listener_ids: string[];
  readonly emotion: (typeof CONTROLLED_TTS_EMOTIONS)[number];
  readonly prosody_intent?: {
    readonly pace?: (typeof CONTROLLED_TTS_PACES)[number];
    readonly intensity?: (typeof CONTROLLED_TTS_INTENSITIES)[number];
    readonly delivery?: (typeof CONTROLLED_TTS_DELIVERIES)[number];
  };
  readonly confidence: number;
  readonly evidence_codes: string[];
}

export interface ChapterLabelingParagraphResultV2 {
  readonly paragraph_id: string;
  readonly segments: ChapterLabelingV2Segment[];
  readonly coverage_complete: boolean;
}

export interface ChapterLabelingContextDeltaV2 {
  readonly summary?: string;
  readonly location?: string;
  readonly active_add: string[];
  readonly active_remove: string[];
  readonly interlocutor_upserts: Array<{
    readonly source_character_id: string;
    readonly target_character_id: string;
    readonly confidence: number;
  }>;
  readonly unresolved_add: string[];
  readonly unresolved_resolve: string[];
}

export interface ChapterLabelingResponseV2 {
  readonly schema_version: typeof CHAPTER_LABELING_V2_SCHEMA_VERSION;
  readonly chapter_id: string;
  readonly window_id: string;
  readonly input_revision_id: string;
  readonly paragraph_results: ChapterLabelingParagraphResultV2[];
  readonly context_delta?: ChapterLabelingContextDeltaV2;
  readonly uncertainties: Array<{
    readonly paragraph_id: string;
    readonly span: [number, number];
    readonly reason_code: string;
    readonly candidate_ids: string[];
  }>;
}

export const chapterLabelingV2SegmentSchema = {
  type: 'OBJECT',
  properties: {
    start_offset: { type: 'INTEGER' },
    end_offset: { type: 'INTEGER' },
    type: { type: 'STRING', enum: CONTROLLED_TTS_SEGMENT_TYPES },
    speaker_id: { type: 'STRING' },
    candidate_speakers: { type: 'ARRAY', items: { type: 'STRING' } },
    listener_ids: { type: 'ARRAY', items: { type: 'STRING' } },
    emotion: { type: 'STRING', enum: CONTROLLED_TTS_EMOTIONS },
    prosody_intent: {
      type: 'OBJECT',
      properties: {
        pace: { type: 'STRING', enum: CONTROLLED_TTS_PACES },
        intensity: { type: 'STRING', enum: CONTROLLED_TTS_INTENSITIES },
        delivery: { type: 'STRING', enum: CONTROLLED_TTS_DELIVERIES },
      },
    },
    confidence: { type: 'NUMBER' },
    evidence_codes: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1 },
  },
  required: [
    'start_offset',
    'end_offset',
    'type',
    'speaker_id',
    'candidate_speakers',
    'listener_ids',
    'emotion',
    'confidence',
    'evidence_codes',
  ],
} as const;

export const chapterLabelingV2ResponseSchema = {
  type: 'OBJECT',
  properties: {
    schema_version: { type: 'STRING', enum: [CHAPTER_LABELING_V2_SCHEMA_VERSION] },
    chapter_id: { type: 'STRING' },
    window_id: { type: 'STRING' },
    input_revision_id: { type: 'STRING' },
    paragraph_results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          paragraph_id: { type: 'STRING' },
          segments: { type: 'ARRAY', items: chapterLabelingV2SegmentSchema },
          coverage_complete: { type: 'BOOLEAN' },
        },
        required: ['paragraph_id', 'segments', 'coverage_complete'],
      },
    },
    context_delta: {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING' },
        location: { type: 'STRING' },
        active_add: { type: 'ARRAY', items: { type: 'STRING' } },
        active_remove: { type: 'ARRAY', items: { type: 'STRING' } },
        interlocutor_upserts: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              source_character_id: { type: 'STRING' },
              target_character_id: { type: 'STRING' },
              confidence: { type: 'NUMBER' },
            },
            required: ['source_character_id', 'target_character_id', 'confidence'],
          },
        },
        unresolved_add: { type: 'ARRAY', items: { type: 'STRING' } },
        unresolved_resolve: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['active_add', 'active_remove', 'interlocutor_upserts', 'unresolved_add', 'unresolved_resolve'],
    },
    uncertainties: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          paragraph_id: { type: 'STRING' },
          span: {
            type: 'ARRAY',
            items: { type: 'INTEGER' },
            minItems: 2,
            maxItems: 2,
          },
          reason_code: { type: 'STRING' },
          candidate_ids: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['paragraph_id', 'span', 'reason_code', 'candidate_ids'],
      },
    },
  },
  required: ['schema_version', 'chapter_id', 'window_id', 'input_revision_id', 'paragraph_results', 'uncertainties'],
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const parsed = stringValue(value, label);
  if (!values.includes(parsed as T)) throw new Error(`${label} is invalid: ${parsed}`);
  return parsed as T;
}

export function parseChapterLabelingV2Segment(value: unknown): ChapterLabelingV2Segment {
  const body = record(value, 'paragraph segment');
  const prosody = body.prosody_intent === undefined ? undefined : record(body.prosody_intent, 'prosody_intent');
  const evidenceCodes = stringArray(body.evidence_codes, 'evidence_codes');
  if (evidenceCodes.length === 0 || evidenceCodes.some((code) => !code.trim())) {
    throw new Error('evidence_codes must contain non-empty codes');
  }
  const confidence = numberValue(body.confidence, 'confidence');
  if (confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1');
  return {
    start_offset: numberValue(body.start_offset, 'start_offset'),
    end_offset: numberValue(body.end_offset, 'end_offset'),
    type: enumValue(body.type, CONTROLLED_TTS_SEGMENT_TYPES, 'type'),
    speaker_id: stringValue(body.speaker_id, 'speaker_id'),
    candidate_speakers: stringArray(body.candidate_speakers, 'candidate_speakers'),
    listener_ids: stringArray(body.listener_ids, 'listener_ids'),
    emotion: enumValue(body.emotion, CONTROLLED_TTS_EMOTIONS, 'emotion'),
    prosody_intent: prosody
      ? {
          pace:
            prosody.pace === undefined
              ? undefined
              : enumValue(prosody.pace, CONTROLLED_TTS_PACES, 'prosody_intent.pace'),
          intensity:
            prosody.intensity === undefined
              ? undefined
              : enumValue(prosody.intensity, CONTROLLED_TTS_INTENSITIES, 'prosody_intent.intensity'),
          delivery:
            prosody.delivery === undefined
              ? undefined
              : enumValue(prosody.delivery, CONTROLLED_TTS_DELIVERIES, 'prosody_intent.delivery'),
        }
      : undefined,
    confidence,
    evidence_codes: evidenceCodes,
  };
}

export function parseChapterLabelingV2Response(value: unknown): ChapterLabelingResponseV2 {
  const body = record(value, 'chapter labeling v2 response');
  if (body.schema_version !== CHAPTER_LABELING_V2_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${CHAPTER_LABELING_V2_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(body.paragraph_results)) throw new Error('paragraph_results must be an array');
  if (!Array.isArray(body.uncertainties)) throw new Error('uncertainties must be an array');
  const context = body.context_delta === undefined ? undefined : record(body.context_delta, 'context_delta');
  return {
    schema_version: CHAPTER_LABELING_V2_SCHEMA_VERSION,
    chapter_id: stringValue(body.chapter_id, 'chapter_id'),
    window_id: stringValue(body.window_id, 'window_id'),
    input_revision_id: stringValue(body.input_revision_id, 'input_revision_id'),
    paragraph_results: body.paragraph_results.map((value) => {
      const paragraph = record(value, 'paragraph_result');
      if (!Array.isArray(paragraph.segments)) throw new Error('paragraph_result.segments must be an array');
      if (typeof paragraph.coverage_complete !== 'boolean') {
        throw new Error('paragraph_result.coverage_complete must be boolean');
      }
      return {
        paragraph_id: stringValue(paragraph.paragraph_id, 'paragraph_result.paragraph_id'),
        segments: paragraph.segments.map(parseChapterLabelingV2Segment),
        coverage_complete: paragraph.coverage_complete,
      };
    }),
    context_delta: context
      ? {
          summary: typeof context.summary === 'string' && context.summary.trim() ? context.summary : undefined,
          location: typeof context.location === 'string' && context.location.trim() ? context.location : undefined,
          active_add: stringArray(context.active_add, 'context_delta.active_add'),
          active_remove: stringArray(context.active_remove, 'context_delta.active_remove'),
          interlocutor_upserts: (() => {
            if (!Array.isArray(context.interlocutor_upserts)) {
              throw new Error('context_delta.interlocutor_upserts must be an array');
            }
            return context.interlocutor_upserts.map((value) => {
              const edge = record(value, 'context_delta.interlocutor_upsert');
              const confidence = numberValue(edge.confidence, 'context_delta.interlocutor_upsert.confidence');
              if (confidence < 0 || confidence > 1) {
                throw new Error('context_delta.interlocutor_upsert.confidence must be between 0 and 1');
              }
              return {
                source_character_id: stringValue(
                  edge.source_character_id,
                  'context_delta.interlocutor_upsert.source_character_id',
                ),
                target_character_id: stringValue(
                  edge.target_character_id,
                  'context_delta.interlocutor_upsert.target_character_id',
                ),
                confidence,
              };
            });
          })(),
          unresolved_add: stringArray(context.unresolved_add, 'context_delta.unresolved_add'),
          unresolved_resolve: stringArray(context.unresolved_resolve, 'context_delta.unresolved_resolve'),
        }
      : undefined,
    uncertainties: body.uncertainties.map((value) => {
      const uncertainty = record(value, 'uncertainty');
      if (
        !Array.isArray(uncertainty.span) ||
        uncertainty.span.length !== 2 ||
        uncertainty.span.some((offset) => typeof offset !== 'number' || !Number.isFinite(offset))
      ) {
        throw new Error('uncertainty.span must contain two numeric offsets');
      }
      return {
        paragraph_id: stringValue(uncertainty.paragraph_id, 'uncertainty.paragraph_id'),
        span: [uncertainty.span[0] as number, uncertainty.span[1] as number],
        reason_code: stringValue(uncertainty.reason_code, 'uncertainty.reason_code'),
        candidate_ids: stringArray(uncertainty.candidate_ids, 'uncertainty.candidate_ids'),
      };
    }),
  };
}

export function parseChapterLabelingV2Json(text: string): ChapterLabelingResponseV2 {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('provider response did not contain JSON object');
  return parseChapterLabelingV2Response(JSON.parse(trimmed.slice(start, end + 1)));
}

function applyContextDelta(input: LabelChapterSegmentsInput, response: ChapterLabelingResponseV2) {
  const delta = response.context_delta;
  if (!delta) return undefined;
  const active = new Set(input.previousEpisodeContext?.activeCharacterIds ?? []);
  for (const id of delta.active_remove) active.delete(id);
  for (const id of delta.active_add) active.add(id);
  const unresolved = new Set(input.previousEpisodeContext?.unresolved ?? []);
  for (const value of delta.unresolved_resolve) unresolved.delete(value);
  for (const value of delta.unresolved_add) unresolved.add(value);
  const scene = delta.location || delta.summary || input.previousEpisodeContext?.scene || 'scene unchanged';
  const interlocutors = new Map(
    (input.previousEpisodeContext?.interlocutorEdges ?? []).map((edge) => [
      `${edge.sourceCharacterId}:${edge.targetCharacterId}`,
      { ...edge },
    ]),
  );
  for (const edge of delta.interlocutor_upserts) {
    interlocutors.set(`${edge.source_character_id}:${edge.target_character_id}`, {
      sourceCharacterId: edge.source_character_id,
      targetCharacterId: edge.target_character_id,
      confidence: edge.confidence,
    });
  }
  return {
    chapterId: input.chapter.id,
    scene,
    activeCharacterIds: [...active],
    unresolved: [...unresolved],
    summaryForNextChapter: delta.summary,
    interlocutorEdges: [...interlocutors.values()],
  };
}

export function chapterLabelingV2ResponseToResult(
  input: LabelChapterSegmentsInput,
  response: ChapterLabelingResponseV2,
): ChapterLabelingResult {
  if (response.chapter_id !== input.chapter.id) {
    throw new Error(`chapter_id mismatch: expected ${input.chapter.id}, got ${response.chapter_id}`);
  }
  const expectedWindowId = input.windowId ?? input.chapter.id;
  if (response.window_id !== expectedWindowId) {
    throw new Error(`window_id mismatch: expected ${expectedWindowId}, got ${response.window_id}`);
  }
  const expectedInputRevisionId = input.inputRevisionId ?? expectedWindowId;
  if (response.input_revision_id !== expectedInputRevisionId) {
    throw new Error(
      `input_revision_id mismatch: expected ${expectedInputRevisionId}, got ${response.input_revision_id}`,
    );
  }
  const targetIds = input.paragraphs.map((paragraph) => paragraph.id);
  const targetSet = new Set(targetIds);
  const seen = new Set<string>();
  for (const paragraph of response.paragraph_results) {
    if (!targetSet.has(paragraph.paragraph_id)) {
      throw new Error(`paragraph_results contains non-target paragraph: ${paragraph.paragraph_id}`);
    }
    if (seen.has(paragraph.paragraph_id)) {
      throw new Error(`paragraph_results duplicates paragraph: ${paragraph.paragraph_id}`);
    }
    if (!paragraph.coverage_complete) {
      throw new Error(`paragraph_result is not coverage complete: ${paragraph.paragraph_id}`);
    }
    seen.add(paragraph.paragraph_id);
  }
  const missing = targetIds.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`paragraph_results is missing target paragraphs: ${missing.join(', ')}`);

  const flattened: ChapterLabelingLLMSegment[] = response.paragraph_results.flatMap((paragraph) =>
    paragraph.segments.map((segment) => ({
      paragraph_id: paragraph.paragraph_id,
      start_offset: segment.start_offset,
      end_offset: segment.end_offset,
      type: segment.type,
      speaker_id: segment.speaker_id,
      candidate_speakers: segment.candidate_speakers,
      listener_ids: segment.listener_ids,
      emotion: segment.emotion,
      confidence: segment.confidence,
      evidence: segment.evidence_codes.join(','),
    })),
  );
  const compatibilityResponse: ChapterLabelingLLMResponse = {
    chapter_id: response.chapter_id,
    analysis_version: 2,
    segments: flattened,
  };
  const result = chapterLabelingResponseToResult(input, compatibilityResponse);
  const v2Segments = response.paragraph_results.flatMap((paragraph) => paragraph.segments);
  const segmentAnnotations: Record<string, ChapterLabelingSegmentAnnotation> = {};
  result.segments.forEach((segment, index) => {
    const source = v2Segments[index];
    segmentAnnotations[segment.id] = {
      evidenceCodes: [...source.evidence_codes],
      prosodyIntent: source.prosody_intent ? { ...source.prosody_intent } : undefined,
    };
  });
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const uncertainties: ChapterLabelingUncertainty[] = response.uncertainties.map((uncertainty) => {
    const paragraph = paragraphById.get(uncertainty.paragraph_id);
    const [startOffset, endOffset] = uncertainty.span;
    if (
      !paragraph ||
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset <= startOffset ||
      endOffset > paragraph.text.length
    ) {
      throw new Error(`uncertainty span is invalid: ${uncertainty.paragraph_id}`);
    }
    return {
      paragraphId: uncertainty.paragraph_id,
      startOffset,
      endOffset,
      reasonCode: uncertainty.reason_code,
      candidateIds: [...uncertainty.candidate_ids],
    };
  });
  return {
    ...result,
    episodeContextSummary: applyContextDelta(input, response),
    uncertainties,
    segmentAnnotations,
  };
}
