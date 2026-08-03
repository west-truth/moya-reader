import type { Chapter, LabeledSegment, Paragraph, SegmentType } from '../domain/types';
import type { ChapterLabelingResult, LabelChapterSegmentsInput } from './ai';
import { labeledSegmentId, segmentTextIntegrityHash } from '../domain/identity/ai-identities';
import { buildChapterLabelingPromptPayload } from './chapter-labeling-payload';

export const CHAPTER_LABELING_SCHEMA_VERSION = 'chapter-labeling-result-v1';
export const CHAPTER_LABELING_PROMPT_VERSION = 'chapter-labeler-v1';
export const CONTROLLED_TTS_EMOTIONS = [
  'neutral',
  'calm',
  'tense',
  'angry',
  'irritated',
  'sad',
  'happy',
  'excited',
  'afraid',
  'surprised',
  'confused',
  'whisper',
  'shout',
  'system',
] as const;

export interface ChapterLabelingLLMSegment {
  segment_id?: string;
  paragraph_id: string;
  start_offset: number;
  end_offset: number;
  type: SegmentType;
  speaker_id: string;
  candidate_speakers: string[];
  listener_ids: string[];
  emotion: string;
  confidence: number;
  evidence: string;
  tts?: {
    voice_profile_id?: string;
    speed?: number;
    tone?: string;
  };
}

export interface ChapterLabelingLLMResponse {
  chapter_id: string;
  analysis_version: number;
  segments: ChapterLabelingLLMSegment[];
  episode_context_summary?: {
    scene: string;
    active_characters: string[];
    unresolved: string[];
    summary_for_next_chapter?: string;
  };
}

export const chapterLabelingResponseSchema = {
  type: 'OBJECT',
  properties: {
    chapter_id: { type: 'STRING' },
    analysis_version: { type: 'INTEGER' },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          segment_id: { type: 'STRING' },
          paragraph_id: { type: 'STRING' },
          start_offset: { type: 'INTEGER' },
          end_offset: { type: 'INTEGER' },
          type: {
            type: 'STRING',
            enum: [
              'narration',
              'quoted_dialogue',
              'plain_dialogue',
              'inner_monologue',
              'system_message',
              'sfx',
              'author_note',
              'unknown',
            ],
          },
          speaker_id: { type: 'STRING' },
          candidate_speakers: { type: 'ARRAY', items: { type: 'STRING' } },
          listener_ids: { type: 'ARRAY', items: { type: 'STRING' } },
          emotion: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          evidence: { type: 'STRING' },
          tts: {
            type: 'OBJECT',
            properties: {
              voice_profile_id: { type: 'STRING' },
              speed: { type: 'NUMBER' },
              tone: { type: 'STRING' },
            },
          },
        },
        required: [
          'paragraph_id',
          'start_offset',
          'end_offset',
          'type',
          'speaker_id',
          'candidate_speakers',
          'listener_ids',
          'emotion',
          'confidence',
          'evidence',
        ],
      },
    },
    episode_context_summary: {
      type: 'OBJECT',
      properties: {
        scene: { type: 'STRING' },
        active_characters: { type: 'ARRAY', items: { type: 'STRING' } },
        unresolved: { type: 'ARRAY', items: { type: 'STRING' } },
        summary_for_next_chapter: { type: 'STRING' },
      },
      required: ['scene', 'active_characters', 'unresolved'],
    },
  },
  required: ['chapter_id', 'analysis_version', 'segments'],
} as const;

export const strictTTSChapterLabelingResponseSchema = {
  ...chapterLabelingResponseSchema,
  properties: {
    ...chapterLabelingResponseSchema.properties,
    segments: {
      ...chapterLabelingResponseSchema.properties.segments,
      items: {
        ...chapterLabelingResponseSchema.properties.segments.items,
        properties: {
          ...chapterLabelingResponseSchema.properties.segments.items.properties,
          emotion: { type: 'STRING', enum: CONTROLLED_TTS_EMOTIONS },
        },
      },
    },
  },
} as const;

const segmentTypes: SegmentType[] = [
  'narration',
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'system_message',
  'sfx',
  'author_note',
  'unknown',
];

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseSegment(value: unknown): ChapterLabelingLLMSegment {
  const body = assertRecord(value, 'segment');
  const type = stringValue(body.type, 'segment.type') as SegmentType;
  if (!segmentTypes.includes(type)) throw new Error(`segment.type is invalid: ${type}`);
  const tts = body.tts === undefined ? undefined : assertRecord(body.tts, 'segment.tts');
  return {
    segment_id: typeof body.segment_id === 'string' && body.segment_id.trim() ? body.segment_id : undefined,
    paragraph_id: stringValue(body.paragraph_id, 'segment.paragraph_id'),
    start_offset: numberValue(body.start_offset, 'segment.start_offset'),
    end_offset: numberValue(body.end_offset, 'segment.end_offset'),
    type,
    speaker_id: stringValue(body.speaker_id, 'segment.speaker_id'),
    candidate_speakers: stringArray(body.candidate_speakers, 'segment.candidate_speakers'),
    listener_ids: stringArray(body.listener_ids, 'segment.listener_ids'),
    emotion: stringValue(body.emotion, 'segment.emotion'),
    confidence: numberValue(body.confidence, 'segment.confidence'),
    evidence: stringValue(body.evidence, 'segment.evidence'),
    tts: tts
      ? {
          voice_profile_id:
            typeof tts.voice_profile_id === 'string' && tts.voice_profile_id.trim() ? tts.voice_profile_id : undefined,
          speed: tts.speed === undefined ? undefined : numberValue(tts.speed, 'segment.tts.speed'),
          tone: typeof tts.tone === 'string' && tts.tone.trim() ? tts.tone : undefined,
        }
      : undefined,
  };
}

export function parseChapterLabelingResponse(value: unknown): ChapterLabelingLLMResponse {
  const body = assertRecord(value, 'chapter labeling response');
  const segmentsValue = body.segments;
  if (!Array.isArray(segmentsValue)) throw new Error('segments must be an array');
  const context =
    body.episode_context_summary === undefined
      ? undefined
      : assertRecord(body.episode_context_summary, 'episode_context_summary');
  return {
    chapter_id: stringValue(body.chapter_id, 'chapter_id'),
    analysis_version: numberValue(body.analysis_version, 'analysis_version'),
    segments: segmentsValue.map(parseSegment),
    episode_context_summary: context
      ? {
          scene: stringValue(context.scene, 'episode_context_summary.scene'),
          active_characters: stringArray(context.active_characters, 'episode_context_summary.active_characters'),
          unresolved: stringArray(context.unresolved, 'episode_context_summary.unresolved'),
          summary_for_next_chapter:
            typeof context.summary_for_next_chapter === 'string' && context.summary_for_next_chapter.trim()
              ? context.summary_for_next_chapter
              : undefined,
        }
      : undefined,
  };
}

export function parseChapterLabelingJson(text: string): ChapterLabelingLLMResponse {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('provider response did not contain JSON object');
  return parseChapterLabelingResponse(JSON.parse(trimmed.slice(start, end + 1)));
}

export function buildChapterLabelingPrompt(input: LabelChapterSegmentsInput): string {
  return [
    'You are the speaker attribution module for a Korean web novel smart TTS reader.',
    'Segment the current chapter and label each segment as narration, dialogue, inner monologue, system message, sfx, author note, or unknown.',
    'Critical rules:',
    '- Do not rewrite, paraphrase, normalize, or translate source text.',
    '- Use paragraph_id plus start_offset and end_offset to identify segments.',
    '- Offsets are based on the normalized paragraph text provided in the input.',
    '- Offset rule: 0 <= start_offset < end_offset <= paragraph.length. Use paragraph.length from the input exactly.',
    '- Use only known speaker IDs from labeling_context_packet.relevant_character_graph, known_characters, or character_graph.characters, plus narrator/system/unknown.',
    '- When character_graph is present, use relations, aliases, terms_used_by_source/target, and evidence to resolve speakers and listeners.',
    '- If the relevant graph or known_characters is absent or insufficient, do not invent character IDs.',
    '- Prefer labeling_context_packet scene, halo, recent turns, relation terms, and correction_memory when present. Otherwise use previous_episode_context and user_corrections.',
    '- User corrections override inference where they apply.',
    '- If the speaker is uncertain, use speaker_id = "unknown" and fill candidate_speakers.',
    '- Every segment must include confidence and short evidence.',
    '- Return only JSON matching the provided schema.',
    '',
    JSON.stringify(
      buildChapterLabelingPromptPayload(input, {
        promptVersion: CHAPTER_LABELING_PROMPT_VERSION,
        schemaVersion: CHAPTER_LABELING_SCHEMA_VERSION,
      }),
    ),
  ].join('\n');
}

export function chapterLabelingResponseToResult(
  input: {
    novelId: string;
    chapter: Chapter;
    paragraphs: Paragraph[];
    existingResult?: ChapterLabelingResult;
  },
  response: ChapterLabelingLLMResponse,
): ChapterLabelingResult {
  if (response.chapter_id !== input.chapter.id) {
    throw new Error(`chapter_id mismatch: expected ${input.chapter.id}, got ${response.chapter_id}`);
  }
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const existingById = new Map((input.existingResult?.segments ?? []).map((segment) => [segment.id, segment]));
  const existingByAnchor = new Map(
    (input.existingResult?.segments ?? []).map((segment) => [
      `${segment.paragraphId}:${segment.startOffset}:${segment.endOffset}`,
      segment,
    ]),
  );
  const segments: LabeledSegment[] = [];
  const responseSegmentIds = new Set<string>();
  const responseAnchors = new Set<string>();
  for (const segment of response.segments) {
    const paragraph = paragraphById.get(segment.paragraph_id);
    if (!paragraph) throw new Error(`segment references unknown paragraph: ${segment.paragraph_id}`);
    if (!Number.isInteger(segment.start_offset) || !Number.isInteger(segment.end_offset)) {
      throw new Error(`segment offsets must be integers: ${segment.paragraph_id}`);
    }
    if (
      segment.start_offset < 0 ||
      segment.start_offset >= paragraph.text.length ||
      segment.end_offset <= segment.start_offset ||
      segment.end_offset > paragraph.text.length
    ) {
      throw new Error(
        `segment offsets out of range: ${segment.paragraph_id} start=${segment.start_offset} end=${segment.end_offset} length=${paragraph.text.length}`,
      );
    }
    if (segment.confidence < 0 || segment.confidence > 1)
      throw new Error(`segment confidence out of range: ${segment.paragraph_id}`);
    const responseSegmentId = segment.segment_id?.trim();
    if (responseSegmentId) {
      if (responseSegmentIds.has(responseSegmentId)) {
        throw new Error(`duplicate segment_id in provider response: ${responseSegmentId}`);
      }
      responseSegmentIds.add(responseSegmentId);
    }
    const responseAnchor = `${segment.paragraph_id}:${segment.start_offset}:${segment.end_offset}`;
    if (responseAnchors.has(responseAnchor)) {
      throw new Error(`duplicate segment anchor in provider response: ${responseAnchor}`);
    }
    responseAnchors.add(responseAnchor);
    const segmentText = paragraph.text.slice(segment.start_offset, segment.end_offset);
    const segmentTextHash = segmentTextIntegrityHash(segmentText);
    const existingSegment =
      (segment.segment_id ? existingById.get(segment.segment_id.trim()) : undefined) ??
      existingByAnchor.get(`${paragraph.id}:${segment.start_offset}:${segment.end_offset}`);
    segments.push({
      id:
        existingSegment?.id ??
        labeledSegmentId({
          novelId: input.novelId,
          chapterId: input.chapter.id,
          paragraphId: paragraph.id,
          startOffset: segment.start_offset,
          endOffset: segment.end_offset,
          segmentTextHash,
        }),
      novelId: input.novelId,
      chapterId: input.chapter.id,
      paragraphId: paragraph.id,
      segmentIndex: segments.length,
      startOffset: segment.start_offset,
      endOffset: segment.end_offset,
      segmentTextHash,
      type: segment.type,
      speakerId: segment.speaker_id,
      candidateSpeakers: segment.candidate_speakers,
      listenerIds: segment.listener_ids,
      emotion: segment.emotion,
      confidence: segment.confidence,
      evidence: segment.evidence,
      voiceProfileId: segment.tts?.voice_profile_id,
      isUserCorrected: false,
    });
  }
  return {
    characters: [],
    segments,
    episodeContextSummary: response.episode_context_summary
      ? {
          chapterId: input.chapter.id,
          scene: response.episode_context_summary.scene,
          activeCharacterIds: response.episode_context_summary.active_characters,
          unresolved: response.episode_context_summary.unresolved,
          summaryForNextChapter: response.episode_context_summary.summary_for_next_chapter,
        }
      : undefined,
  };
}
