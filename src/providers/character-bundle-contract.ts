import { candidateCharacterId, candidateRelationId } from '../domain/identity/ai-identities';
import type {
  CharacterGraph,
  CharacterRelation,
  AnalyzeCharacterBundleInput,
  CharacterBundleAnalysisResult,
} from './ai';
import { characterBundleObservationsV2 } from './character-bundle-observations';

export const CHARACTER_BUNDLE_SCHEMA_VERSION = 'character-bundle-v1';
export const CHARACTER_BUNDLE_ANALYSIS_PROMPT_VERSION = 'character-bundle-analysis-v1';

export interface CharacterBundleEvidence {
  chapter_id: string;
  paragraph_id?: string;
  note: string;
}

export interface CharacterBundleLLMCharacter {
  temporary_id: string;
  canonical_name: string;
  aliases: string[];
  honorifics?: string[];
  possible_existing_character_ids?: string[];
  description?: string;
  inferred_gender?: string;
  speech_style?: string;
  confidence: number;
  evidence: CharacterBundleEvidence[];
}

export interface CharacterBundleLLMRelation {
  source_character_name_or_alias: string;
  target_character_name_or_alias: string;
  relation: string;
  terms_used: string[];
  confidence: number;
  evidence: CharacterBundleEvidence[];
}

export interface CharacterBundleLLMResponse {
  bundle_id: string;
  source_chapter_ids: string[];
  new_or_updated_characters: CharacterBundleLLMCharacter[];
  relations: CharacterBundleLLMRelation[];
  bundle_summary_for_next?: string;
}

export const characterBundleResponseSchema = {
  type: 'OBJECT',
  properties: {
    bundle_id: { type: 'STRING' },
    source_chapter_ids: { type: 'ARRAY', items: { type: 'STRING' } },
    new_or_updated_characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          temporary_id: { type: 'STRING' },
          canonical_name: { type: 'STRING' },
          aliases: { type: 'ARRAY', items: { type: 'STRING' } },
          honorifics: { type: 'ARRAY', items: { type: 'STRING' } },
          possible_existing_character_ids: { type: 'ARRAY', items: { type: 'STRING' } },
          description: { type: 'STRING' },
          inferred_gender: { type: 'STRING' },
          speech_style: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          evidence: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                chapter_id: { type: 'STRING' },
                paragraph_id: { type: 'STRING' },
                note: { type: 'STRING' },
              },
              required: ['chapter_id', 'note'],
            },
          },
        },
        required: ['temporary_id', 'canonical_name', 'aliases', 'confidence', 'evidence'],
      },
    },
    relations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          source_character_name_or_alias: { type: 'STRING' },
          target_character_name_or_alias: { type: 'STRING' },
          relation: { type: 'STRING' },
          terms_used: { type: 'ARRAY', items: { type: 'STRING' } },
          confidence: { type: 'NUMBER' },
          evidence: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                chapter_id: { type: 'STRING' },
                paragraph_id: { type: 'STRING' },
                note: { type: 'STRING' },
              },
              required: ['chapter_id', 'note'],
            },
          },
        },
        required: [
          'source_character_name_or_alias',
          'target_character_name_or_alias',
          'relation',
          'terms_used',
          'confidence',
          'evidence',
        ],
      },
    },
    bundle_summary_for_next: { type: 'STRING' },
  },
  required: ['bundle_id', 'source_chapter_ids', 'new_or_updated_characters', 'relations'],
} as const;

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function parseEvidence(value: unknown): CharacterBundleEvidence {
  const body = assertRecord(value, 'evidence');
  return {
    chapter_id: stringValue(body.chapter_id, 'evidence.chapter_id'),
    paragraph_id: optionalStringValue(body.paragraph_id),
    note: stringValue(body.note, 'evidence.note'),
  };
}

function parseCharacter(value: unknown): CharacterBundleLLMCharacter {
  const body = assertRecord(value, 'bundle character');
  if (!Array.isArray(body.evidence)) throw new Error('character.evidence must be an array');
  return {
    temporary_id: stringValue(body.temporary_id, 'character.temporary_id'),
    canonical_name: stringValue(body.canonical_name, 'character.canonical_name'),
    aliases: stringArray(body.aliases, 'character.aliases'),
    honorifics: body.honorifics === undefined ? undefined : stringArray(body.honorifics, 'character.honorifics'),
    possible_existing_character_ids:
      body.possible_existing_character_ids === undefined
        ? undefined
        : stringArray(body.possible_existing_character_ids, 'character.possible_existing_character_ids'),
    description: optionalStringValue(body.description),
    inferred_gender: optionalStringValue(body.inferred_gender),
    speech_style: optionalStringValue(body.speech_style),
    confidence: numberValue(body.confidence, 'character.confidence'),
    evidence: body.evidence.map(parseEvidence),
  };
}

function parseRelation(value: unknown): CharacterBundleLLMRelation {
  const body = assertRecord(value, 'bundle relation');
  if (!Array.isArray(body.evidence)) throw new Error('relation.evidence must be an array');
  return {
    source_character_name_or_alias: stringValue(
      body.source_character_name_or_alias,
      'relation.source_character_name_or_alias',
    ),
    target_character_name_or_alias: stringValue(
      body.target_character_name_or_alias,
      'relation.target_character_name_or_alias',
    ),
    relation: stringValue(body.relation, 'relation.relation'),
    terms_used: stringArray(body.terms_used, 'relation.terms_used'),
    confidence: numberValue(body.confidence, 'relation.confidence'),
    evidence: body.evidence.map(parseEvidence),
  };
}

export function parseCharacterBundleResponse(value: unknown): CharacterBundleLLMResponse {
  const body = assertRecord(value, 'character bundle response');
  if (!Array.isArray(body.new_or_updated_characters)) throw new Error('new_or_updated_characters must be an array');
  if (!Array.isArray(body.relations)) throw new Error('relations must be an array');
  return {
    bundle_id: stringValue(body.bundle_id, 'bundle_id'),
    source_chapter_ids: stringArray(body.source_chapter_ids, 'source_chapter_ids'),
    new_or_updated_characters: body.new_or_updated_characters.map(parseCharacter),
    relations: body.relations.map(parseRelation),
    bundle_summary_for_next: optionalStringValue(body.bundle_summary_for_next),
  };
}

export function parseCharacterBundleJson(text: string): CharacterBundleLLMResponse {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('provider response did not contain JSON object');
  return parseCharacterBundleResponse(JSON.parse(trimmed.slice(start, end + 1)));
}

function assertConfidence(value: number, label: string): void {
  if (value < 0 || value > 1) throw new Error(`${label} confidence out of range`);
}

function normalizeAlias(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function dropUnresolvableCharacterBundleRelations(
  response: CharacterBundleLLMResponse,
): { readonly response: CharacterBundleLLMResponse; readonly droppedRelationCount: number } {
  const knownSurfaces = new Set(
    response.new_or_updated_characters.flatMap((character) =>
      [character.temporary_id, character.canonical_name, ...character.aliases, ...(character.honorifics ?? [])]
        .map(normalizeAlias)
        .filter(Boolean),
    ),
  );
  const relations = response.relations.filter(
    (relation) =>
      knownSurfaces.has(normalizeAlias(relation.source_character_name_or_alias)) &&
      knownSurfaces.has(normalizeAlias(relation.target_character_name_or_alias)),
  );
  const droppedRelationCount = response.relations.length - relations.length;
  return droppedRelationCount === 0
    ? { response, droppedRelationCount }
    : { response: { ...response, relations }, droppedRelationCount };
}

function evidenceToString(evidence: CharacterBundleEvidence): string {
  return [evidence.chapter_id, evidence.paragraph_id, evidence.note].filter(Boolean).join(': ');
}

export function buildCharacterBundleAnalysisPrompt(input: AnalyzeCharacterBundleInput): string {
  return [
    'You are an analysis module for a Korean web novel smart TTS reader.',
    'Extract character candidates, aliases, honorifics, relationships, and speech-style clues from the provided bundle of chapters.',
    'The output is used for speaker attribution and per-character TTS voice assignment.',
    'Critical rules:',
    '- Do not rewrite the novel text.',
    '- Do not invent facts not supported by the text.',
    '- If a character may be the same as an existing character, use possible_existing_character_ids instead of merging automatically.',
    '- Generic references such as pronouns, age/gender labels, or job titles are mentions or address terms, not global aliases.',
    '- Preserve who uses an address term toward whom; do not reverse directional relationship evidence.',
    '- Always include confidence from 0 to 1.',
    '- Always include evidence references using chapter_id and paragraph_id when possible.',
    '- Keep output compact and return only JSON matching the schema.',
    '',
    JSON.stringify({
      request_profile_id: 'character-bundle-analysis-v1',
      prompt_version: CHARACTER_BUNDLE_ANALYSIS_PROMPT_VERSION,
      schema_version: CHARACTER_BUNDLE_SCHEMA_VERSION,
      novel_id: input.novelId,
      bundle_id: input.bundleId,
      previous_bundle_summary: input.previousBundleSummary,
      existing_graph: input.existingGraph ? graphPayload(input.existingGraph) : undefined,
      user_corrections: (input.userCorrections ?? []).map((correction) => ({
        correction_id: correction.id,
        chapter_id: correction.chapterId,
        paragraph_id: correction.paragraphId,
        segment_id: correction.segmentId,
        correction_type: correction.correctionType,
        before_json: safeJson(correction.beforeJson),
        after_json: safeJson(correction.afterJson),
        apply_scope: correction.applyScope,
      })),
      bundle_chapters: input.chapters.map(({ chapter, paragraphs }) => ({
        chapter_id: chapter.id,
        chapter_index: chapter.index,
        title: chapter.title,
        text_hash: chapter.textHash,
        paragraphs: paragraphs.map((paragraph) => ({
          paragraph_id: paragraph.id,
          paragraph_index: paragraph.index,
          text_hash: paragraph.textHash,
          text: paragraph.text,
        })),
      })),
    }),
  ].join('\n');
}

export function characterBundleResponseToResult(
  input: AnalyzeCharacterBundleInput,
  response: CharacterBundleLLMResponse,
): CharacterBundleAnalysisResult {
  if (response.bundle_id !== input.bundleId) {
    throw new Error(`bundle_id mismatch: expected ${input.bundleId}, got ${response.bundle_id}`);
  }
  const expectedChapterIds = input.chapters.map((chapter) => chapter.chapter.id);
  const unexpected = response.source_chapter_ids.filter((chapterId) => !expectedChapterIds.includes(chapterId));
  if (unexpected.length) throw new Error(`source_chapter_ids contain unknown chapters: ${unexpected.join(', ')}`);
  const characters = response.new_or_updated_characters.map((character, index) => {
    assertConfidence(character.confidence, `character ${character.temporary_id}`);
    const aliases = [
      ...new Set(
        [...character.aliases, ...(character.honorifics ?? [])]
          .map((alias) => alias.trim())
          .filter((alias) => alias && alias !== character.canonical_name),
      ),
    ];
    const descriptionParts = [
      character.description,
      character.inferred_gender ? `gender: ${character.inferred_gender}` : undefined,
      character.speech_style ? `speech: ${character.speech_style}` : undefined,
      character.possible_existing_character_ids?.length
        ? `possible_existing: ${character.possible_existing_character_ids.join(', ')}`
        : undefined,
    ].filter(Boolean);
    return {
      id: candidateCharacterId(input.novelId, input.bundleId, character.temporary_id),
      novelId: input.novelId,
      canonicalName: character.canonical_name,
      aliases,
      color: colorForCharacter(index),
      description: descriptionParts.join(' | ') || undefined,
      confidence: character.confidence,
      isUserConfirmed: false,
    };
  });
  const aliasToId = new Map<string, string>();
  for (const character of characters) {
    for (const alias of [character.id, character.canonicalName, ...character.aliases]) {
      const normalized = normalizeAlias(alias);
      if (normalized) aliasToId.set(normalized, character.id);
    }
  }
  const relations: CharacterRelation[] = response.relations.map((relation) => {
    assertConfidence(relation.confidence, `relation ${relation.relation}`);
    const sourceCharacterId = aliasToId.get(normalizeAlias(relation.source_character_name_or_alias));
    const targetCharacterId = aliasToId.get(normalizeAlias(relation.target_character_name_or_alias));
    if (!sourceCharacterId)
      throw new Error(`relation source does not match a bundle character: ${relation.source_character_name_or_alias}`);
    if (!targetCharacterId)
      throw new Error(`relation target does not match a bundle character: ${relation.target_character_name_or_alias}`);
    if (sourceCharacterId === targetCharacterId)
      throw new Error(`relation source and target must be different: ${sourceCharacterId}`);
    return {
      id: candidateRelationId({
        novelId: input.novelId,
        bundleId: input.bundleId,
        sourceCharacterId,
        targetCharacterId,
        relationLabel: relation.relation,
      }),
      novelId: input.novelId,
      sourceCharacterId,
      targetCharacterId,
      relationLabel: relation.relation,
      termsUsedBySource: relation.terms_used,
      termsUsedByTarget: [],
      confidence: relation.confidence,
      evidence: relation.evidence.map(evidenceToString),
    };
  });
  const result: CharacterBundleAnalysisResult = {
    novelId: input.novelId,
    bundleId: input.bundleId,
    sourceChapterIds: response.source_chapter_ids.length ? response.source_chapter_ids : expectedChapterIds,
    discoveredGraph: {
      novelId: input.novelId,
      characters,
      relations,
    },
    bundleSummaryForNext: response.bundle_summary_for_next,
  };
  return { ...result, observationsV2: characterBundleObservationsV2({ source: input, response, result }) };
}

function colorForCharacter(index: number): string {
  const palette = ['#3b82f6', '#ef476f', '#2fbf71', '#f59e0b', '#9b5de5', '#06b6d4'];
  return palette[index % palette.length];
}

function graphPayload(graph: CharacterGraph): unknown {
  return {
    novel_id: graph.novelId,
    characters: graph.characters.map((character) => ({
      character_id: character.id,
      canonical_name: character.canonicalName,
      aliases: character.aliases,
      description: character.description,
      confidence: character.confidence,
      is_user_confirmed: character.isUserConfirmed,
    })),
    relations: graph.relations.map((relation) => ({
      relation_id: relation.id,
      source_character_id: relation.sourceCharacterId,
      target_character_id: relation.targetCharacterId,
      relation_label: relation.relationLabel,
      terms_used_by_source: relation.termsUsedBySource,
      terms_used_by_target: relation.termsUsedByTarget,
      confidence: relation.confidence,
      evidence: relation.evidence ?? [],
    })),
  };
}

function safeJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
