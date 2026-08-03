import type { AnalyzeCharacterBundleInput, CharacterBundleAnalysisResult } from './ai';
import type { ProviderRequestProfileConfig } from './provider-jobs';
import {
  buildCharacterBundleAnalysisPrompt,
  characterBundleResponseSchema,
  characterBundleResponseToResult,
  CHARACTER_BUNDLE_ANALYSIS_PROMPT_VERSION,
  CHARACTER_BUNDLE_SCHEMA_VERSION,
  parseCharacterBundleJson,
  type CharacterBundleLLMResponse,
} from './character-bundle-contract';

export const DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID = 'character-bundle-analysis-v1';

const internalProviderOptionKeys = new Set([
  'requestProfileId',
  'characterBundleProfileId',
  'bundleRequestProfileId',
  'bundleAnalysisProfileId',
  'promptProfileId',
  'promptVersion',
  'schemaVersion',
]);

export interface CharacterBundleAnalysisRequestProfile {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly jsonSchemaName: string;
  readonly responseSchema: unknown;
  buildPrompt(input: AnalyzeCharacterBundleInput): string;
  parseResponse(text: string): CharacterBundleLLMResponse;
  toResult(input: AnalyzeCharacterBundleInput, response: CharacterBundleLLMResponse): CharacterBundleAnalysisResult;
}

export interface CharacterBundleAnalysisRequest {
  readonly profile: CharacterBundleAnalysisRequestProfile;
  readonly prompt: string;
  readonly responseSchema: unknown;
  readonly jsonSchemaName: string;
  readonly providerOptions: Record<string, unknown>;
}

export const defaultCharacterBundleAnalysisRequestProfile: CharacterBundleAnalysisRequestProfile = {
  id: DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID,
  displayName: 'Character Bundle Analysis v1',
  description: 'Extracts character candidates, aliases, honorifics, relationships, and speech-style clues from chapter bundles.',
  promptVersion: CHARACTER_BUNDLE_ANALYSIS_PROMPT_VERSION,
  schemaVersion: CHARACTER_BUNDLE_SCHEMA_VERSION,
  jsonSchemaName: 'character_bundle_analysis_result',
  responseSchema: characterBundleResponseSchema,
  buildPrompt: buildCharacterBundleAnalysisPrompt,
  parseResponse: parseCharacterBundleJson,
  toResult: characterBundleResponseToResult,
};

const characterBundleAnalysisRequestProfiles = new Map<string, CharacterBundleAnalysisRequestProfile>([
  [defaultCharacterBundleAnalysisRequestProfile.id, defaultCharacterBundleAnalysisRequestProfile],
  [defaultCharacterBundleAnalysisRequestProfile.promptVersion, defaultCharacterBundleAnalysisRequestProfile],
]);

function explicitCharacterBundleProfileId(providerOptions: Record<string, unknown> | undefined): string | undefined {
  const raw =
    providerOptions?.characterBundleProfileId ??
    providerOptions?.bundleRequestProfileId ??
    providerOptions?.bundleAnalysisProfileId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function characterBundleAnalysisRequestProfileId(providerOptions: Record<string, unknown> | undefined): string {
  const explicit = explicitCharacterBundleProfileId(providerOptions);
  if (explicit) return explicit;
  const raw = providerOptions?.requestProfileId ?? providerOptions?.promptProfileId ?? providerOptions?.promptVersion;
  if (typeof raw === 'string' && raw.trim()) {
    const candidate = raw.trim();
    if (characterBundleAnalysisRequestProfiles.has(candidate)) return candidate;
  }
  return DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID;
}

export function resolveCharacterBundleAnalysisRequestProfile(
  providerOptions: Record<string, unknown> | undefined,
): CharacterBundleAnalysisRequestProfile {
  const profileId = characterBundleAnalysisRequestProfileId(providerOptions);
  const profile = characterBundleAnalysisRequestProfiles.get(profileId);
  if (!profile) throw new Error(`Unsupported character bundle analysis request profile: ${profileId}`);
  return profile;
}

export function listCharacterBundleAnalysisRequestProfileConfigs(): ProviderRequestProfileConfig[] {
  const uniqueProfiles = [...new Set(characterBundleAnalysisRequestProfiles.values())];
  return uniqueProfiles.map((profile) => ({
    profileId: profile.id,
    displayName: profile.displayName,
    description: profile.description,
    promptVersion: profile.promptVersion,
    schemaVersion: profile.schemaVersion,
    enabled: true,
  }));
}

export function providerApiOptionsForCharacterBundleAnalysis(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!providerOptions) return {};
  return Object.fromEntries(Object.entries(providerOptions).filter(([key]) => !internalProviderOptionKeys.has(key)));
}

export function buildCharacterBundleAnalysisRequest(
  input: AnalyzeCharacterBundleInput,
  providerOptions: Record<string, unknown> | undefined,
): CharacterBundleAnalysisRequest {
  const profile = resolveCharacterBundleAnalysisRequestProfile(providerOptions);
  return {
    profile,
    prompt: profile.buildPrompt(input),
    responseSchema: profile.responseSchema,
    jsonSchemaName: profile.jsonSchemaName,
    providerOptions: providerApiOptionsForCharacterBundleAnalysis(providerOptions),
  };
}
