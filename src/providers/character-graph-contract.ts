import type { Character } from '../domain/types';
import { characterRelationId } from '../domain/identity/ai-identities';
import type { CharacterGraph, CharacterRelation, MergeCharacterGraphInput } from './ai';

export const CHARACTER_GRAPH_SCHEMA_VERSION = 'character-graph-v1';
export const CHARACTER_GRAPH_MERGE_PROMPT_VERSION = 'character-graph-merge-v1';
export const CHARACTER_GRAPH_CONSOLIDATION_PROMPT_VERSION = 'character-graph-consolidation-v2';

export interface CharacterGraphLLMCharacter {
  character_id: string;
  canonical_name: string;
  aliases: string[];
  color?: string;
  description?: string;
  confidence: number;
  is_user_confirmed?: boolean;
}

export interface CharacterGraphLLMRelation {
  relation_id?: string;
  source_character_id: string;
  target_character_id: string;
  relation_label: string;
  terms_used_by_source: string[];
  terms_used_by_target: string[];
  confidence: number;
  evidence: string[];
}

export interface CharacterGraphLLMResponse {
  novel_id: string;
  graph_version: number;
  characters: CharacterGraphLLMCharacter[];
  relations: CharacterGraphLLMRelation[];
}

export const characterGraphResponseSchema = {
  type: 'OBJECT',
  properties: {
    novel_id: { type: 'STRING' },
    graph_version: { type: 'INTEGER' },
    characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          character_id: { type: 'STRING' },
          canonical_name: { type: 'STRING' },
          aliases: { type: 'ARRAY', items: { type: 'STRING' } },
          color: { type: 'STRING' },
          description: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          is_user_confirmed: { type: 'BOOLEAN' },
        },
        required: ['character_id', 'canonical_name', 'aliases', 'confidence'],
      },
    },
    relations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          relation_id: { type: 'STRING' },
          source_character_id: { type: 'STRING' },
          target_character_id: { type: 'STRING' },
          relation_label: { type: 'STRING' },
          terms_used_by_source: { type: 'ARRAY', items: { type: 'STRING' } },
          terms_used_by_target: { type: 'ARRAY', items: { type: 'STRING' } },
          confidence: { type: 'NUMBER' },
          evidence: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: [
          'source_character_id',
          'target_character_id',
          'relation_label',
          'terms_used_by_source',
          'terms_used_by_target',
          'confidence',
          'evidence',
        ],
      },
    },
  },
  required: ['novel_id', 'graph_version', 'characters', 'relations'],
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

function parseCharacter(value: unknown): CharacterGraphLLMCharacter {
  const body = assertRecord(value, 'character');
  return {
    character_id: stringValue(body.character_id, 'character.character_id'),
    canonical_name: stringValue(body.canonical_name, 'character.canonical_name'),
    aliases: stringArray(body.aliases, 'character.aliases'),
    color: optionalStringValue(body.color),
    description: optionalStringValue(body.description),
    confidence: numberValue(body.confidence, 'character.confidence'),
    is_user_confirmed: body.is_user_confirmed === true ? true : undefined,
  };
}

function parseRelation(value: unknown): CharacterGraphLLMRelation {
  const body = assertRecord(value, 'relation');
  return {
    relation_id: optionalStringValue(body.relation_id),
    source_character_id: stringValue(body.source_character_id, 'relation.source_character_id'),
    target_character_id: stringValue(body.target_character_id, 'relation.target_character_id'),
    relation_label: stringValue(body.relation_label, 'relation.relation_label'),
    terms_used_by_source: stringArray(body.terms_used_by_source, 'relation.terms_used_by_source'),
    terms_used_by_target: stringArray(body.terms_used_by_target, 'relation.terms_used_by_target'),
    confidence: numberValue(body.confidence, 'relation.confidence'),
    evidence: stringArray(body.evidence, 'relation.evidence'),
  };
}

export function parseCharacterGraphResponse(value: unknown): CharacterGraphLLMResponse {
  const body = assertRecord(value, 'character graph response');
  if (!Array.isArray(body.characters)) throw new Error('characters must be an array');
  if (!Array.isArray(body.relations)) throw new Error('relations must be an array');
  return {
    novel_id: stringValue(body.novel_id, 'novel_id'),
    graph_version: numberValue(body.graph_version, 'graph_version'),
    characters: body.characters.map(parseCharacter),
    relations: body.relations.map(parseRelation),
  };
}

export function parseCharacterGraphJson(text: string): CharacterGraphLLMResponse {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('provider response did not contain JSON object');
  return parseCharacterGraphResponse(JSON.parse(trimmed.slice(start, end + 1)));
}

function assertConfidence(value: number, label: string): void {
  if (value < 0 || value > 1) throw new Error(`${label} confidence out of range`);
}

function colorForCharacter(character: CharacterGraphLLMCharacter, index: number): string {
  const palette = ['#3b82f6', '#ef476f', '#2fbf71', '#f59e0b', '#9b5de5', '#06b6d4'];
  return character.color?.trim() || palette[index % palette.length];
}

function buildCharacterGraphPrompt(
  input: MergeCharacterGraphInput,
  profileId: string,
  identityRules: readonly string[],
): string {
  return [
    'You are the Character Graph consolidation module for a Korean web novel smart TTS reader.',
    'Consolidate character facts and relations without making irreversible identity decisions.',
    'The graph is used for speaker attribution, honorific resolution, and per-character TTS voice assignment.',
    'Critical rules:',
    ...identityRules,
    '- User-confirmed existing character data is authoritative. Do not rename or split it unless the correction data explicitly says so.',
    '- Merge duplicate candidates by canonical name, aliases, titles, honorifics, speech style, and evidence.',
    '- Do not invent unsupported characters, aliases, or relations.',
    '- Keep aliases and relationship labels useful for future speaker attribution.',
    '- relation source/target IDs must reference returned character IDs only.',
    '- Use confidence 0..1 and visible evidence. If uncertain, keep confidence low instead of guessing.',
    '- Return only JSON matching the schema. Do not include markdown or commentary.',
    '',
    JSON.stringify({
      request_profile_id: profileId,
      prompt_version: profileId,
      schema_version: CHARACTER_GRAPH_SCHEMA_VERSION,
      novel_id: input.novelId,
      source_context: input.sourceContext,
      existing_graph: graphPayload(input.existingGraph),
      discovered_graph: graphPayload(input.discoveredGraph),
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
    }),
  ].join('\n');
}

export function buildCharacterGraphMergePrompt(input: MergeCharacterGraphInput): string {
  return buildCharacterGraphPrompt(input, CHARACTER_GRAPH_MERGE_PROMPT_VERSION, [
    '- Preserve stable existing character IDs whenever a discovered candidate is the same person.',
  ]);
}

export function buildCharacterGraphConsolidationPromptV2(input: MergeCharacterGraphInput): string {
  return buildCharacterGraphPrompt(input, CHARACTER_GRAPH_CONSOLIDATION_PROMPT_VERSION, [
    '- Return every existing and discovered character ID exactly once. Do not collapse, replace, or invent IDs.',
    '- Similar names, aliases, titles, honorifics, or speech styles are not permission to merge identities.',
    '- Keep uncertain duplicate identities separate. They are reviewed through a separate merge-candidate workflow.',
  ]);
}

export function characterGraphResponseToGraph(
  input: MergeCharacterGraphInput,
  response: CharacterGraphLLMResponse,
): CharacterGraph {
  if (response.novel_id !== input.novelId) {
    throw new Error(`novel_id mismatch: expected ${input.novelId}, got ${response.novel_id}`);
  }
  const existingById = new Map(input.existingGraph.characters.map((character) => [character.id, character]));
  const characters = response.characters.map<Character>((character, index) => {
    assertConfidence(character.confidence, `character ${character.character_id}`);
    const existing = existingById.get(character.character_id);
    if (existing?.isUserConfirmed) {
      return {
        ...existing,
        confidence: Math.max(existing.confidence, character.confidence),
        isUserConfirmed: true,
      };
    }
    return {
      id: character.character_id,
      novelId: input.novelId,
      canonicalName: character.canonical_name,
      aliases: character.aliases.filter((alias) => alias !== character.canonical_name),
      color: colorForCharacter(character, index),
      description: character.description,
      confidence: character.confidence,
      isUserConfirmed: existing?.isUserConfirmed ?? false,
    };
  });
  const ids = new Set<string>();
  for (const character of characters) {
    if (ids.has(character.id)) throw new Error(`duplicate character id: ${character.id}`);
    ids.add(character.id);
  }
  const relations = response.relations.map<CharacterRelation>((relation) => {
    assertConfidence(relation.confidence, `relation ${relation.relation_id ?? relation.relation_label}`);
    if (!ids.has(relation.source_character_id)) {
      throw new Error(`relation references unknown source character: ${relation.source_character_id}`);
    }
    if (!ids.has(relation.target_character_id)) {
      throw new Error(`relation references unknown target character: ${relation.target_character_id}`);
    }
    if (relation.source_character_id === relation.target_character_id) {
      throw new Error(`relation source and target must be different: ${relation.source_character_id}`);
    }
    return {
      id:
        relation.relation_id?.trim() ||
        characterRelationId({
          novelId: input.novelId,
          sourceCharacterId: relation.source_character_id,
          targetCharacterId: relation.target_character_id,
          relationLabel: relation.relation_label,
        }),
      novelId: input.novelId,
      sourceCharacterId: relation.source_character_id,
      targetCharacterId: relation.target_character_id,
      relationLabel: relation.relation_label,
      termsUsedBySource: relation.terms_used_by_source,
      termsUsedByTarget: relation.terms_used_by_target,
      confidence: relation.confidence,
      evidence: relation.evidence,
    };
  });
  return { novelId: input.novelId, characters, relations };
}

export function characterGraphResponseToGraphV2(
  input: MergeCharacterGraphInput,
  response: CharacterGraphLLMResponse,
): CharacterGraph {
  const graph = characterGraphResponseToGraph(input, response);
  const expectedIds = new Set(
    [...input.existingGraph.characters, ...input.discoveredGraph.characters].map((character) => character.id),
  );
  const actualIds = new Set(graph.characters.map((character) => character.id));
  const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
  const unexpectedIds = [...actualIds].filter((id) => !expectedIds.has(id));
  if (missingIds.length > 0) throw new Error(`character consolidation removed input ids: ${missingIds.join(', ')}`);
  if (unexpectedIds.length > 0) throw new Error(`character consolidation invented ids: ${unexpectedIds.join(', ')}`);
  return graph;
}

export function restoreMissingCharacterGraphResponseCharacters(
  input: MergeCharacterGraphInput,
  response: CharacterGraphLLMResponse,
): { readonly response: CharacterGraphLLMResponse; readonly restoredCharacterCount: number } {
  const returnedIds = new Set(response.characters.map((character) => character.character_id));
  const sourceById = new Map(
    [...input.discoveredGraph.characters, ...input.existingGraph.characters].map((character) => [character.id, character]),
  );
  const restored = [...sourceById.values()]
    .filter((character) => !returnedIds.has(character.id))
    .map<CharacterGraphLLMCharacter>((character) => ({
      character_id: character.id,
      canonical_name: character.canonicalName,
      aliases: [...character.aliases],
      color: character.color,
      description: character.description,
      confidence: character.confidence,
      is_user_confirmed: character.isUserConfirmed || undefined,
    }));
  if (restored.length === 0) return { response, restoredCharacterCount: 0 };
  return {
    response: { ...response, characters: [...response.characters, ...restored] },
    restoredCharacterCount: restored.length,
  };
}

function graphPayload(graph: CharacterGraph): unknown {
  return {
    novel_id: graph.novelId,
    characters: graph.characters.map((character) => ({
      character_id: character.id,
      canonical_name: character.canonicalName,
      aliases: character.aliases,
      color: character.color,
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
