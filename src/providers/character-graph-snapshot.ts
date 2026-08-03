import type { Character } from '../domain/types';
import { characterRelationId } from '../domain/identity/ai-identities';
import type { CharacterGraph, CharacterRelation } from './ai';

export function emptyCharacterGraph(novelId: string): CharacterGraph {
  return { novelId, characters: [], relations: [] };
}

export interface CharacterGraphSnapshotOptions {
  readonly trustUserConfirmed?: boolean;
}

export function normalizeCharacterGraphSnapshot(
  value: unknown,
  novelId: string,
  options: CharacterGraphSnapshotOptions = {},
): CharacterGraph {
  if (value === undefined || value === null) return emptyCharacterGraph(novelId);
  const body = recordValue(value, 'character graph snapshot');
  const rawNovelId = optionalString(body.novelId) ?? optionalString(body.novel_id);
  if (rawNovelId && rawNovelId !== novelId) {
    throw new Error(`character graph snapshot novel id mismatch: expected ${novelId}, got ${rawNovelId}`);
  }
  const charactersValue = body.characters;
  const relationsValue = body.relations;
  if (!Array.isArray(charactersValue)) throw new Error('character graph snapshot characters must be an array');
  if (!Array.isArray(relationsValue)) throw new Error('character graph snapshot relations must be an array');
  const characters = charactersValue.map((item, index) => normalizeCharacter(item, novelId, index, options));
  const characterIds = new Set<string>();
  for (const character of characters) {
    if (characterIds.has(character.id)) throw new Error(`duplicate character id in graph snapshot: ${character.id}`);
    characterIds.add(character.id);
  }
  const relations = relationsValue.map((item) => normalizeRelation(item, novelId));
  for (const relation of relations) {
    if (!characterIds.has(relation.sourceCharacterId)) {
      throw new Error(`graph snapshot relation references unknown source character: ${relation.sourceCharacterId}`);
    }
    if (!characterIds.has(relation.targetCharacterId)) {
      throw new Error(`graph snapshot relation references unknown target character: ${relation.targetCharacterId}`);
    }
    if (relation.sourceCharacterId === relation.targetCharacterId) {
      throw new Error(`graph snapshot relation source and target must be different: ${relation.sourceCharacterId}`);
    }
  }
  return { novelId, characters, relations };
}

function normalizeCharacter(
  value: unknown,
  novelId: string,
  index: number,
  options: CharacterGraphSnapshotOptions,
): Character {
  const body = recordValue(value, 'character graph snapshot character');
  const id = stringValue(body.id ?? body.character_id, 'character id');
  const canonicalName = stringValue(body.canonicalName ?? body.canonical_name, 'character canonical name');
  const confidence = numberValue(body.confidence, 'character confidence');
  assertConfidence(confidence, `character ${id}`);
  return {
    id,
    novelId,
    canonicalName,
    aliases: stringArray(body.aliases),
    color: optionalString(body.color) ?? fallbackColor(index),
    description: optionalString(body.description),
    confidence,
    isUserConfirmed:
      options.trustUserConfirmed === true && (body.isUserConfirmed === true || body.is_user_confirmed === true),
  };
}

function normalizeRelation(value: unknown, novelId: string): CharacterRelation {
  const body = recordValue(value, 'character graph snapshot relation');
  const sourceCharacterId = stringValue(
    body.sourceCharacterId ?? body.source_character_id,
    'relation source character id',
  );
  const targetCharacterId = stringValue(
    body.targetCharacterId ?? body.target_character_id,
    'relation target character id',
  );
  const relationLabel = stringValue(body.relationLabel ?? body.relation_label, 'relation label');
  const confidence = numberValue(body.confidence, 'relation confidence');
  assertConfidence(confidence, `relation ${relationLabel}`);
  return {
    id:
      optionalString(body.id) ??
      optionalString(body.relation_id) ??
      characterRelationId({
        novelId,
        sourceCharacterId,
        targetCharacterId,
        relationLabel,
      }),
    novelId,
    sourceCharacterId,
    targetCharacterId,
    relationLabel,
    termsUsedBySource: stringArray(body.termsUsedBySource ?? body.terms_used_by_source),
    termsUsedByTarget: stringArray(body.termsUsedByTarget ?? body.terms_used_by_target),
    confidence,
    evidence: stringArray(body.evidence),
  };
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function numberValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function assertConfidence(value: number, label: string): void {
  if (value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
}

function fallbackColor(index: number): string {
  const palette = ['#3b82f6', '#ef476f', '#2fbf71', '#f59e0b', '#9b5de5', '#06b6d4'];
  return palette[index % palette.length];
}
