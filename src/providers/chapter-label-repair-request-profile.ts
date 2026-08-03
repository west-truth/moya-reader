import type { Character, LabeledSegment, Paragraph } from '../domain/types';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { ChapterLabelingResult, RepairChapterLabelsInput } from './ai';
import type { ProviderRequestProfileConfig } from './provider-jobs';
import type { ChapterLabelingValidationPolicy } from './chapter-labeling-validator';
import { buildChapterLabelingPromptPayload } from './chapter-labeling-payload';
import {
  chapterLabelingResponseToResult,
  CHAPTER_LABELING_SCHEMA_VERSION,
  parseChapterLabelingJson,
  strictTTSChapterLabelingResponseSchema,
  type ChapterLabelingLLMResponse,
  type ChapterLabelingLLMSegment,
} from './chapter-labeling-contract';
import {
  applyLabelRepairPatchV2,
  chapterLabelRepairIssueId,
  chapterLabelRepairPatchV2Schema,
  chapterLabelSegmentAnchorHash,
  CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION,
  parseLabelRepairPatchV2Json,
  repairPatchPromptScope,
  type LabelRepairPatchV2,
} from './chapter-label-repair-v2-contract';

export const LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID = 'chapter-label-repair-v1';
export const DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID = 'chapter-label-repair-v2-patch';
export const CHAPTER_LABEL_REPAIR_PROMPT_VERSION = 'chapter-label-repair-v1';
export const CHAPTER_LABEL_REPAIR_V2_PROMPT_VERSION = 'chapter-label-repair-v2-issue-patch';

const internalProviderOptionKeys = new Set([
  'repairRequestProfileId',
  'repairProfileId',
  'requestProfileId',
  'labelingProfileId',
  'promptProfileId',
  'promptVersion',
  'schemaVersion',
  'autoRepairOnValidationFailure',
  'contextWindowTokens',
  'contextSafetyFactor',
  'estimatedCharactersPerToken',
  'contextHaloParagraphs',
  'maxContextCharacters',
  'maxContextRelations',
  'maxContextCorrections',
  'maxContextRecentTurns',
]);

export interface ChapterLabelRepairRequestProfile {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly jsonSchemaName: string;
  readonly responseSchema: unknown;
  readonly validationPolicy: ChapterLabelingValidationPolicy;
  buildPrompt(input: RepairChapterLabelsInput): string;
  parseResponse(text: string): unknown;
  toResult(input: RepairChapterLabelsInput, response: unknown): ChapterLabelingResult;
}

export interface ChapterLabelRepairRequest {
  readonly profile: ChapterLabelRepairRequestProfile;
  readonly prompt: string;
  readonly responseSchema: unknown;
  readonly jsonSchemaName: string;
  readonly providerOptions: Record<string, unknown>;
}

function characterPayload(character: Character): Record<string, unknown> {
  return {
    character_id: character.id,
    canonical_name: character.canonicalName,
    aliases: character.aliases,
    description: character.description,
    confidence: character.confidence,
    is_user_confirmed: character.isUserConfirmed,
  };
}

function segmentPayload(segment: LabeledSegment): ChapterLabelingLLMSegment & { is_user_corrected: boolean } {
  return {
    segment_id: segment.id,
    paragraph_id: segment.paragraphId,
    start_offset: segment.startOffset,
    end_offset: segment.endOffset,
    type: segment.type,
    speaker_id: segment.speakerId,
    candidate_speakers: segment.candidateSpeakers,
    listener_ids: segment.listenerIds,
    emotion: segment.emotion,
    confidence: segment.confidence,
    evidence: segment.evidence ?? '',
    tts: segment.voiceProfileId ? { voice_profile_id: segment.voiceProfileId } : undefined,
    is_user_corrected: segment.isUserCorrected,
  };
}

function paragraphAnchorPayload(paragraphs: Paragraph[]): Record<string, unknown>[] {
  return paragraphs.map((paragraph) => ({
    paragraph_id: paragraph.id,
    length: paragraph.text.length,
    text_hash: paragraph.textHash,
  }));
}

export function buildChapterLabelRepairPromptPayload(input: RepairChapterLabelsInput): Record<string, unknown> {
  return {
    ...buildChapterLabelingPromptPayload(input, {
      requestProfileId: LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
      promptVersion: CHAPTER_LABEL_REPAIR_PROMPT_VERSION,
      schemaVersion: CHAPTER_LABELING_SCHEMA_VERSION,
    }),
    repair_input: {
      paragraph_anchors: paragraphAnchorPayload(input.paragraphs),
      existing_labeling_result: {
        characters: input.existingResult.characters.map(characterPayload),
        segments: input.existingResult.segments.map(segmentPayload),
        episode_context_summary: input.existingResult.episodeContextSummary
          ? {
              chapter_id: input.existingResult.episodeContextSummary.chapterId,
              scene: input.existingResult.episodeContextSummary.scene,
              active_character_ids: input.existingResult.episodeContextSummary.activeCharacterIds,
              unresolved: input.existingResult.episodeContextSummary.unresolved,
              summary_for_next_chapter: input.existingResult.episodeContextSummary.summaryForNextChapter,
            }
          : undefined,
      },
      validator_issues: input.validationIssues.map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        segment_id: issue.segmentId,
        paragraph_id: issue.paragraphId,
      })),
      repair_policy: {
        preserve_valid_segment_ids: true,
        preserve_user_corrected_segments: true,
        rewrite_source_text: false,
        return_complete_result: true,
      },
    },
  };
}

export function buildChapterLabelRepairPrompt(input: RepairChapterLabelsInput): string {
  return [
    'You are a validation and repair module for speaker-labeled Korean web novel segments.',
    'Use the same JSON schema as the chapter labeling request and return a complete corrected result.',
    'Repair rules:',
    '- Fix only invalid or suspicious segments listed in repair_input.validator_issues.',
    '- Preserve valid segment_id values wherever possible.',
    '- Keep user-corrected segments unchanged.',
    '- Do not rewrite, paraphrase, normalize, translate, or insert source text.',
    '- Use only paragraph_id plus start_offset/end_offset from the provided original paragraphs.',
    '- Change offsets only when the validator issue requires it.',
    '- Preserve valid speakers, emotions, candidate speakers, listener ids, and TTS voice hints where they still fit the source.',
    '- If a speaker cannot be repaired confidently, use speaker_id = "unknown", include candidate_speakers, lower confidence, and explain evidence.',
    '- Return only JSON matching the provided schema. Do not include markdown or commentary.',
    '',
    JSON.stringify(buildChapterLabelRepairPromptPayload(input)),
  ].join('\n');
}

export const defaultChapterLabelRepairRequestProfile: ChapterLabelRepairRequestProfile = {
  id: LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
  displayName: 'Chapter Label Repair v1',
  description: 'Repairs validated chapter speaker/emotion labels without rewriting source text.',
  promptVersion: CHAPTER_LABEL_REPAIR_PROMPT_VERSION,
  schemaVersion: CHAPTER_LABELING_SCHEMA_VERSION,
  jsonSchemaName: 'chapter_labeling_result',
  responseSchema: strictTTSChapterLabelingResponseSchema,
  validationPolicy: 'strict_tts',
  buildPrompt: buildChapterLabelRepairPrompt,
  parseResponse: parseChapterLabelingJson,
  toResult: (input, response) => chapterLabelingResponseToResult(input, response as ChapterLabelingLLMResponse),
};

export function buildChapterLabelRepairV2Prompt(input: RepairChapterLabelsInput): string {
  const scope = repairPatchPromptScope(input);
  const baseArtifactId = input.baseArtifactId ?? 'inline';
  const baseArtifactHash = input.baseArtifactHash ?? structuredIntegrityHash(input.existingResult);
  const segmentById = new Map(input.existingResult.segments.map((segment) => [segment.id, segment]));
  return [
    'You repair a validated Korean web-novel labeling artifact with a bounded patch.',
    'Return LabelRepairPatchV2 JSON only. Do not return the complete labeling result.',
    'Patch rules:',
    '- Address exactly the supplied issue_ids and do not invent new issue IDs.',
    '- Change only segments or paragraphs in repair_scope.',
    '- Copy every expected anchor/hash exactly from repair_scope.',
    '- Never change a user-corrected segment.',
    '- Preserve source text and use exact UTF-16 offsets.',
    '- Use replace_segment, split_segment, merge_segments, replace_paragraph_result, or patch_context_delta.',
    '- Prefer the smallest operation set that fixes all supplied issues.',
    '- Return no markdown or commentary.',
    '',
    JSON.stringify({
      ...buildChapterLabelingPromptPayload(
        { ...input, paragraphs: scope.paragraphs },
        {
          requestProfileId: DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
          promptVersion: CHAPTER_LABEL_REPAIR_V2_PROMPT_VERSION,
          schemaVersion: CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION,
          windowId: input.windowId,
        },
      ),
      repair_scope: {
        base_artifact_id: baseArtifactId,
        base_artifact_hash: baseArtifactHash,
        issue_ids: scope.issueIds,
        issues: input.validationIssues.map((issue) => ({
          issue_id: chapterLabelRepairIssueId(issue),
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
          segment_id: issue.segmentId,
          paragraph_id: issue.paragraphId,
        })),
        paragraph_anchors: scope.paragraphs.map((paragraph) => ({
          paragraph_id: paragraph.id,
          paragraph_hash: paragraph.textHash,
          length: paragraph.text.length,
        })),
        segments: scope.segments.map((segment) => ({
          ...segmentPayload(segment),
          expected_anchor_hash: chapterLabelSegmentAnchorHash(segment),
          is_user_corrected: segment.isUserCorrected,
        })),
        context: input.existingResult.episodeContextSummary,
        expected_context_hash: structuredIntegrityHash(input.existingResult.episodeContextSummary ?? null),
        allowed_segment_ids: [...segmentById.keys()].filter((id) =>
          scope.segments.some((segment) => segment.id === id),
        ),
      },
    }),
  ].join('\n');
}

export const chapterLabelRepairV2RequestProfile: ChapterLabelRepairRequestProfile = {
  id: DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
  displayName: 'Chapter Label Repair v2 patch',
  description: 'Applies a bounded issue-scoped patch while preserving labels outside the repair scope.',
  promptVersion: CHAPTER_LABEL_REPAIR_V2_PROMPT_VERSION,
  schemaVersion: CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION,
  jsonSchemaName: 'chapter_label_repair_patch_v2',
  responseSchema: chapterLabelRepairPatchV2Schema,
  validationPolicy: 'strict_tts',
  buildPrompt: buildChapterLabelRepairV2Prompt,
  parseResponse: parseLabelRepairPatchV2Json,
  toResult: (input, response) => applyLabelRepairPatchV2(input, response as LabelRepairPatchV2),
};

const chapterLabelRepairRequestProfiles = new Map<string, ChapterLabelRepairRequestProfile>([
  [defaultChapterLabelRepairRequestProfile.id, defaultChapterLabelRepairRequestProfile],
  [defaultChapterLabelRepairRequestProfile.promptVersion, defaultChapterLabelRepairRequestProfile],
  [chapterLabelRepairV2RequestProfile.id, chapterLabelRepairV2RequestProfile],
  [chapterLabelRepairV2RequestProfile.promptVersion, chapterLabelRepairV2RequestProfile],
]);

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function chapterLabelRepairRequestProfileId(providerOptions: Record<string, unknown> | undefined): string {
  const explicit =
    stringOption(providerOptions?.repairRequestProfileId) ?? stringOption(providerOptions?.repairProfileId);
  if (explicit) return explicit;
  const generic =
    stringOption(providerOptions?.requestProfileId) ??
    stringOption(providerOptions?.promptProfileId) ??
    stringOption(providerOptions?.promptVersion);
  return generic && chapterLabelRepairRequestProfiles.has(generic)
    ? generic
    : DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID;
}

export function resolveChapterLabelRepairRequestProfile(
  providerOptions: Record<string, unknown> | undefined,
): ChapterLabelRepairRequestProfile {
  const profileId = chapterLabelRepairRequestProfileId(providerOptions);
  const profile = chapterLabelRepairRequestProfiles.get(profileId);
  if (!profile) throw new Error(`Unsupported chapter label repair request profile: ${profileId}`);
  return profile;
}

export function listChapterLabelRepairRequestProfileConfigs(): ProviderRequestProfileConfig[] {
  const uniqueProfiles = [...new Set(chapterLabelRepairRequestProfiles.values())];
  return uniqueProfiles.map((profile) => ({
    profileId: profile.id,
    displayName: profile.displayName,
    description: profile.description,
    promptVersion: profile.promptVersion,
    schemaVersion: profile.schemaVersion,
    enabled: true,
  }));
}

export function providerApiOptionsForChapterLabelRepair(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!providerOptions) return {};
  return Object.fromEntries(Object.entries(providerOptions).filter(([key]) => !internalProviderOptionKeys.has(key)));
}

export function buildChapterLabelRepairRequest(
  input: RepairChapterLabelsInput,
  providerOptions: Record<string, unknown> | undefined,
): ChapterLabelRepairRequest {
  const profile = resolveChapterLabelRepairRequestProfile(providerOptions);
  return {
    profile,
    prompt: profile.buildPrompt(input),
    responseSchema: profile.responseSchema,
    jsonSchemaName: profile.jsonSchemaName,
    providerOptions: providerApiOptionsForChapterLabelRepair(providerOptions),
  };
}
