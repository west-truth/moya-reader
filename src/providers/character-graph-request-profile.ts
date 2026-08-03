import type { CharacterGraph, MergeCharacterGraphInput } from './ai';
import type { ProviderRequestProfileConfig } from './provider-jobs';
import {
  buildCharacterGraphMergePrompt,
  buildCharacterGraphConsolidationPromptV2,
  characterGraphResponseSchema,
  characterGraphResponseToGraph,
  characterGraphResponseToGraphV2,
  CHARACTER_GRAPH_CONSOLIDATION_PROMPT_VERSION,
  CHARACTER_GRAPH_MERGE_PROMPT_VERSION,
  CHARACTER_GRAPH_SCHEMA_VERSION,
  parseCharacterGraphJson,
  type CharacterGraphLLMResponse,
} from './character-graph-contract';

export const DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID = 'character-graph-consolidation-v2';

const internalProviderOptionKeys = new Set([
  'requestProfileId',
  'characterGraphProfileId',
  'graphRequestProfileId',
  'promptProfileId',
  'promptVersion',
  'schemaVersion',
]);

export interface CharacterGraphMergeRequestProfile {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly jsonSchemaName: string;
  readonly responseSchema: unknown;
  buildPrompt(input: MergeCharacterGraphInput): string;
  parseResponse(text: string): CharacterGraphLLMResponse;
  toResult(input: MergeCharacterGraphInput, response: CharacterGraphLLMResponse): CharacterGraph;
}

export interface CharacterGraphMergeRequest {
  readonly profile: CharacterGraphMergeRequestProfile;
  readonly prompt: string;
  readonly responseSchema: unknown;
  readonly jsonSchemaName: string;
  readonly providerOptions: Record<string, unknown>;
}

export const legacyCharacterGraphMergeRequestProfile: CharacterGraphMergeRequestProfile = {
  id: CHARACTER_GRAPH_MERGE_PROMPT_VERSION,
  displayName: 'Character Graph Merge v1',
  description: 'Merges discovered character candidates, aliases, honorifics, and relations into a stable graph.',
  promptVersion: CHARACTER_GRAPH_MERGE_PROMPT_VERSION,
  schemaVersion: CHARACTER_GRAPH_SCHEMA_VERSION,
  jsonSchemaName: 'character_graph_merge_result',
  responseSchema: characterGraphResponseSchema,
  buildPrompt: buildCharacterGraphMergePrompt,
  parseResponse: parseCharacterGraphJson,
  toResult: characterGraphResponseToGraph,
};

export const defaultCharacterGraphMergeRequestProfile: CharacterGraphMergeRequestProfile = {
  id: DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID,
  displayName: 'Character Graph Consolidation v2',
  description: 'Consolidates graph facts while preserving every identity for explicit duplicate review.',
  promptVersion: CHARACTER_GRAPH_CONSOLIDATION_PROMPT_VERSION,
  schemaVersion: CHARACTER_GRAPH_SCHEMA_VERSION,
  jsonSchemaName: 'character_graph_consolidation_result',
  responseSchema: characterGraphResponseSchema,
  buildPrompt: buildCharacterGraphConsolidationPromptV2,
  parseResponse: parseCharacterGraphJson,
  toResult: characterGraphResponseToGraphV2,
};

const characterGraphMergeRequestProfiles = new Map<string, CharacterGraphMergeRequestProfile>([
  [defaultCharacterGraphMergeRequestProfile.id, defaultCharacterGraphMergeRequestProfile],
  [defaultCharacterGraphMergeRequestProfile.promptVersion, defaultCharacterGraphMergeRequestProfile],
  [legacyCharacterGraphMergeRequestProfile.id, legacyCharacterGraphMergeRequestProfile],
  [legacyCharacterGraphMergeRequestProfile.promptVersion, legacyCharacterGraphMergeRequestProfile],
]);

function explicitCharacterGraphProfileId(providerOptions: Record<string, unknown> | undefined): string | undefined {
  const raw = providerOptions?.characterGraphProfileId ?? providerOptions?.graphRequestProfileId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function characterGraphMergeRequestProfileId(providerOptions: Record<string, unknown> | undefined): string {
  const explicit = explicitCharacterGraphProfileId(providerOptions);
  if (explicit) return explicit;
  const raw = providerOptions?.requestProfileId ?? providerOptions?.promptProfileId ?? providerOptions?.promptVersion;
  if (typeof raw === 'string' && raw.trim()) {
    const candidate = raw.trim();
    if (characterGraphMergeRequestProfiles.has(candidate)) return candidate;
  }
  return DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID;
}

export function resolveCharacterGraphMergeRequestProfile(
  providerOptions: Record<string, unknown> | undefined,
): CharacterGraphMergeRequestProfile {
  const profileId = characterGraphMergeRequestProfileId(providerOptions);
  const profile = characterGraphMergeRequestProfiles.get(profileId);
  if (!profile) throw new Error(`Unsupported character graph merge request profile: ${profileId}`);
  return profile;
}

export function listCharacterGraphMergeRequestProfileConfigs(): ProviderRequestProfileConfig[] {
  const uniqueProfiles = [...new Set(characterGraphMergeRequestProfiles.values())];
  return uniqueProfiles.map((profile) => ({
    profileId: profile.id,
    displayName: profile.displayName,
    description: profile.description,
    promptVersion: profile.promptVersion,
    schemaVersion: profile.schemaVersion,
    enabled: true,
  }));
}

export function providerApiOptionsForCharacterGraphMerge(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!providerOptions) return {};
  return Object.fromEntries(Object.entries(providerOptions).filter(([key]) => !internalProviderOptionKeys.has(key)));
}

export function buildCharacterGraphMergeRequest(
  input: MergeCharacterGraphInput,
  providerOptions: Record<string, unknown> | undefined,
): CharacterGraphMergeRequest {
  const profile = resolveCharacterGraphMergeRequestProfile(providerOptions);
  return {
    profile,
    prompt: profile.buildPrompt(input),
    responseSchema: profile.responseSchema,
    jsonSchemaName: profile.jsonSchemaName,
    providerOptions: providerApiOptionsForCharacterGraphMerge(providerOptions),
  };
}
