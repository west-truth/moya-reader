import { pathToFileURL } from 'node:url';
import type { Chapter, Paragraph } from '@noveldesk/contracts';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import {
  chapterLabelingRequestProfileId,
  resolveChapterLabelingRequestProfile,
} from '../../../../src/providers/chapter-labeling-request-profile';
import { createServerAIProvider } from './server-ai-provider-factory.js';
import {
  isServerAIProviderId,
  loadServerAISettings,
  modelIdForProvider,
  providerOptionsForAIProvider,
  providerIsEnabled,
  serverAIProviderIsImplemented,
  type ServerAIProviderId,
} from './server-ai-config.js';
import { classifyProviderError } from './provider-error-classification.js';

export interface AIProviderSmokeInput {
  readonly providerId?: ServerAIProviderId;
  readonly modelId?: string;
  readonly requestProfileId?: string;
  readonly live?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface AIProviderSmokeSummary {
  readonly providerId: ServerAIProviderId;
  readonly modelId?: string;
  readonly requestProfile: {
    readonly profileId: string;
    readonly promptVersion: string;
    readonly schemaVersion: string;
  };
  readonly live: boolean;
  readonly ready: {
    readonly enabled: boolean;
    readonly implemented: boolean;
    readonly secretConfigured: boolean;
    readonly modelConfigured: boolean;
  };
  readonly sample: {
    readonly paragraphCount: number;
    readonly inputCharacters: number;
  };
  readonly result?: {
    readonly characterCount: number;
    readonly segmentCount: number;
    readonly unknownSegmentCount: number;
    readonly segmentTypes: Record<string, number>;
    readonly hasEpisodeContextSummary: boolean;
  };
}

interface ParsedArgs {
  providerId?: ServerAIProviderId;
  modelId?: string;
  requestProfileId?: string;
  live: boolean;
  json: boolean;
  project?: string;
  location?: string;
}

const sampleParagraphTexts = ['"여긴 어디지?"', '[시스템]'];

export async function runAIProviderSmoke(input: AIProviderSmokeInput = {}): Promise<AIProviderSmokeSummary> {
  const env = { ...(input.env ?? process.env) };
  if (input.requestProfileId?.trim()) env.AI_LABELING_REQUEST_PROFILE = input.requestProfileId.trim();
  const cwd = input.cwd ?? process.cwd();
  const settings = loadServerAISettings(env, cwd);
  const providerId = input.providerId ?? settings.defaultProviderId;
  if (!isServerAIProviderId(providerId)) throw new Error(`Unsupported AI provider: ${providerId}`);
  const modelId = modelIdForProvider(settings, providerId, input.modelId);
  const requestProfileOverride = input.requestProfileId?.trim() || env.AI_LABELING_REQUEST_PROFILE?.trim();
  const providerOptions = {
    ...providerOptionsForAIProvider(settings, providerId),
    ...(requestProfileOverride ? { requestProfileId: requestProfileOverride } : {}),
  };
  const requestProfile = resolveChapterLabelingRequestProfile(providerOptions);
  const sample = buildSmokeSample();
  const summary: AIProviderSmokeSummary = {
    providerId,
    modelId,
    requestProfile: {
      profileId: requestProfile.id,
      promptVersion: requestProfile.promptVersion,
      schemaVersion: requestProfile.schemaVersion,
    },
    live: Boolean(input.live),
    ready: {
      enabled: providerIsEnabled(settings, providerId),
      implemented: serverAIProviderIsImplemented(providerId),
      secretConfigured: settings.secretConfiguredByProvider[providerId],
      modelConfigured: Boolean(modelId),
    },
    sample: {
      paragraphCount: sample.paragraphs.length,
      inputCharacters: sample.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
    },
  };
  if (!input.live) return summary;
  const missing = Object.entries(summary.ready)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`AI provider smoke is not ready: ${missing.join(', ')}`);
  }
  const provider = createServerAIProvider({ providerId, modelId, settings });
  const result = await provider.labelChapterSegments({
    novelId: sample.chapter.novelId,
    chapter: sample.chapter,
    paragraphs: sample.paragraphs,
  });
  const segmentTypes: Record<string, number> = {};
  let unknownSegmentCount = 0;
  for (const segment of result.segments) {
    segmentTypes[segment.type] = (segmentTypes[segment.type] ?? 0) + 1;
    if (segment.speakerId === 'unknown') unknownSegmentCount += 1;
  }
  return {
    ...summary,
    result: {
      characterCount: result.characters.length,
      segmentCount: result.segments.length,
      unknownSegmentCount,
      segmentTypes,
      hasEpisodeContextSummary: Boolean(result.episodeContextSummary),
    },
  };
}

export function parseProviderSmokeArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { live: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const [flag, inlineValue] = item.startsWith('--') ? item.split('=', 2) : [item, undefined];
    const value = inlineValue ?? argv[index + 1];
    if (flag === '--live') {
      args.live = true;
    } else if (flag === '--json') {
      args.json = true;
    } else if (flag === '--provider' && value) {
      if (!inlineValue) index += 1;
      if (!isServerAIProviderId(value)) throw new Error(`Unsupported AI provider: ${value}`);
      args.providerId = value;
    } else if (flag === '--model' && value) {
      if (!inlineValue) index += 1;
      args.modelId = value;
    } else if ((flag === '--profile' || flag === '--request-profile') && value) {
      if (!inlineValue) index += 1;
      args.requestProfileId = value;
    } else if (flag === '--project' && value) {
      if (!inlineValue) index += 1;
      args.project = value;
    } else if (flag === '--location' && value) {
      if (!inlineValue) index += 1;
      args.location = value;
    } else if (flag === '--help' || flag === '-h') {
      throw new Error(helpText());
    }
  }
  return args;
}

function buildSmokeSample(): { chapter: Chapter; paragraphs: Paragraph[] } {
  const paragraphs: Paragraph[] = [];
  let offset = 0;
  for (const [index, text] of sampleParagraphTexts.entries()) {
    const startOffsetInChapter = offset;
    const endOffsetInChapter = startOffsetInChapter + text.length;
    paragraphs.push({
      id: `smoke_paragraph_${index + 1}`,
      novelId: 'smoke_book',
      chapterId: 'smoke_chapter',
      index,
      text,
      startOffsetInChapter,
      endOffsetInChapter,
      textHash: textIntegrityHash(text),
    });
    offset = endOffsetInChapter + 1;
  }
  const chapter: Chapter = {
    id: 'smoke_chapter',
    novelId: 'smoke_book',
    index: 0,
    title: 'Provider Smoke',
    normalizedText: '',
    textHash: textIntegrityHash(sampleParagraphTexts.join('\n')),
    rawStartOffset: 0,
    rawEndOffset: offset,
    characterCount: sampleParagraphTexts.join('\n').length,
    paragraphCount: paragraphs.length,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return { chapter, paragraphs };
}

function applyCliEnv(args: ParsedArgs): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (args.project) env.GOOGLE_CLOUD_PROJECT = args.project;
  if (args.location) env.GOOGLE_CLOUD_LOCATION = args.location;
  if (args.requestProfileId) env.AI_LABELING_REQUEST_PROFILE = args.requestProfileId;
  return env;
}

function helpText(): string {
  return [
    'Usage: pnpm --filter server provider:smoke -- [--provider gemini-vertex] [--model gemini-3.1-flash-lite] [--profile chapter-labeling-v1-strict-tts] [--live] [--json]',
    '',
    'Dry-run is the default and does not call external providers.',
    'Live mode requires server env/provider credentials to be configured and makes one small labeling request.',
    `Default profile: ${chapterLabelingRequestProfileId(undefined)}.`,
  ].join('\n');
}

export function formatAIProviderSmokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Usage:')) return message;
  const classification = classifyProviderError(error);
  if (message.startsWith('AI provider smoke is not ready:')) {
    return `AI provider smoke is not ready (${classification.category}): ${message.replace('AI provider smoke is not ready: ', '')}`;
  }
  if (message.startsWith('Unsupported AI provider:')) {
    return `AI provider smoke failed (${classification.category}). Unsupported AI provider.`;
  }
  if (message.startsWith('Unsupported chapter labeling request profile:')) {
    return `AI provider smoke failed (${classification.category}). ${message}`;
  }
  return `AI provider smoke failed (${classification.category}). ${classification.safeMessage}`;
}

async function main(): Promise<void> {
  const args = parseProviderSmokeArgs(process.argv.slice(2));
  const summary = await runAIProviderSmoke({
    providerId: args.providerId,
    modelId: args.modelId,
    requestProfileId: args.requestProfileId,
    live: args.live,
    env: applyCliEnv(args),
  });
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`provider=${summary.providerId}`);
    console.log(`model=${summary.modelId ?? '(not configured)'}`);
    console.log(`profile=${summary.requestProfile.profileId}`);
    console.log(`live=${summary.live ? 'yes' : 'no'}`);
    console.log(`ready=${JSON.stringify(summary.ready)}`);
    console.log(`sample=${summary.sample.paragraphCount} paragraphs, ${summary.sample.inputCharacters} chars`);
    if (summary.result) {
      console.log(`result=${summary.result.segmentCount} segments, ${summary.result.characterCount} characters`);
      console.log(`segmentTypes=${JSON.stringify(summary.result.segmentTypes)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(formatAIProviderSmokeError(error));
    process.exitCode = 1;
  });
}
