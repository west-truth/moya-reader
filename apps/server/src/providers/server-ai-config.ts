import fs from 'node:fs';
import path from 'node:path';

export type ServerAIProviderId =
  'mock' | 'openai' | 'gemini-ai-studio' | 'gemini-vertex' | 'gemini-agent-platform' | 'anthropic';

export const serverAIProviderIds: ServerAIProviderId[] = [
  'mock',
  'openai',
  'gemini-ai-studio',
  'gemini-vertex',
  'gemini-agent-platform',
  'anthropic',
];

export const implementedServerAIProviderIds: ServerAIProviderId[] = [
  'mock',
  'openai',
  'gemini-ai-studio',
  'gemini-vertex',
  'gemini-agent-platform',
  'anthropic',
];

export interface ServerAISettings {
  readonly defaultProviderId: ServerAIProviderId;
  readonly enabledProviderIds: Set<ServerAIProviderId>;
  readonly implementedProviderIds: Set<ServerAIProviderId>;
  readonly labelingModelIdByProvider: Record<ServerAIProviderId, string | undefined>;
  readonly labelingMaxInputCharacters: number;
  readonly secretConfiguredByProvider: Record<ServerAIProviderId, boolean>;
  readonly openAI: {
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly organization?: string;
    readonly project?: string;
    readonly providerOptions: Record<string, unknown>;
  };
  readonly geminiAIStudio: {
    readonly apiKey?: string;
    readonly providerOptions: Record<string, unknown>;
  };
  readonly geminiVertex: {
    readonly project?: string;
    readonly location: string;
    readonly credentialsPath?: string;
    readonly providerOptions: Record<string, unknown>;
  };
  readonly geminiAgentPlatform: {
    readonly project?: string;
    readonly location: string;
    readonly credentialsPath?: string;
    readonly providerOptions: Record<string, unknown>;
  };
  readonly anthropic: {
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly anthropicVersion: string;
    readonly providerOptions: Record<string, unknown>;
  };
}

export function isServerAIProviderId(value: string | undefined): value is ServerAIProviderId {
  return serverAIProviderIds.includes(value as ServerAIProviderId);
}

export function serverAIProviderIsImplemented(value: string | undefined): value is ServerAIProviderId {
  return implementedServerAIProviderIds.includes(value as ServerAIProviderId);
}

export function parseServerAIProviderId(
  value: string | undefined,
  fallback: ServerAIProviderId = 'mock',
): ServerAIProviderId {
  if (isServerAIProviderId(value)) return value;
  return fallback;
}

function enabledProvidersFromEnv(
  env: NodeJS.ProcessEnv,
  defaultProviderId: ServerAIProviderId,
): Set<ServerAIProviderId> {
  const values = (env.AI_PROVIDER_ENABLED ?? defaultProviderId)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const enabled = new Set<ServerAIProviderId>(['mock']);
  for (const value of values) {
    if (isServerAIProviderId(value)) enabled.add(value);
  }
  enabled.add(defaultProviderId);
  return enabled;
}

function safeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanOption(value: string | undefined): boolean | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function resolveLocalPath(cwd: string, value: string): string {
  if (path.isAbsolute(value)) return value;
  const direct = path.resolve(cwd, value);
  if (fs.existsSync(direct)) return direct;
  const workspaceRoot = path.resolve(cwd, '..', '..', value);
  if (fs.existsSync(workspaceRoot)) return workspaceRoot;
  return direct;
}

function resolveVertexCredentialsPath(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim())
    return resolveLocalPath(cwd, env.GOOGLE_APPLICATION_CREDENTIALS.trim());
  const credentialsDir = resolveLocalPath(cwd, env.VERTEX_CREDENTIALS_DIR?.trim() || 'vertex env');
  if (!fs.existsSync(credentialsDir)) return undefined;
  const jsonFiles = fs
    .readdirSync(credentialsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(credentialsDir, entry.name));
  return jsonFiles.length === 1 ? jsonFiles[0] : undefined;
}

function projectIdFromVertexCredentials(credentialsPath: string | undefined): string | undefined {
  if (!credentialsPath) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as { project_id?: unknown };
    return typeof parsed.project_id === 'string' && parsed.project_id.trim() ? parsed.project_id.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function loadServerAISettings(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerAISettings {
  const defaultProviderId = parseServerAIProviderId(env.AI_PROVIDER_DEFAULT, 'mock');
  const enabledProviderIds = enabledProvidersFromEnv(env, defaultProviderId);
  const mockModelId = env.AI_MOCK_LABELING_MODEL_ID?.trim() || 'mock-segment-labeler-v1';
  const labelingModelId = env.AI_LABELING_MODEL_ID?.trim() || undefined;
  const openAIModelId = env.AI_OPENAI_LABELING_MODEL_ID?.trim() || labelingModelId;
  const geminiAIStudioModelId = env.AI_GEMINI_AI_STUDIO_LABELING_MODEL_ID?.trim() || labelingModelId;
  const geminiVertexModelId = env.AI_GEMINI_VERTEX_LABELING_MODEL_ID?.trim() || labelingModelId;
  const geminiAgentPlatformModelId = env.AI_GEMINI_AGENT_PLATFORM_LABELING_MODEL_ID?.trim() || labelingModelId;
  const anthropicModelId = env.AI_ANTHROPIC_LABELING_MODEL_ID?.trim() || labelingModelId;
  const vertexCredentialsPath = resolveVertexCredentialsPath(env, cwd);
  const googleCloudProject = env.GOOGLE_CLOUD_PROJECT?.trim() || projectIdFromVertexCredentials(vertexCredentialsPath);
  const commonProviderOptions = {
    temperature: env.AI_LABELING_TEMPERATURE ? Number(env.AI_LABELING_TEMPERATURE) : undefined,
    topP: env.AI_LABELING_TOP_P ? Number(env.AI_LABELING_TOP_P) : undefined,
    maxOutputTokens: env.AI_LABELING_MAX_OUTPUT_TOKENS ? Number(env.AI_LABELING_MAX_OUTPUT_TOKENS) : undefined,
    contextWindowTokens: env.AI_LABELING_CONTEXT_WINDOW_TOKENS
      ? Number(env.AI_LABELING_CONTEXT_WINDOW_TOKENS)
      : undefined,
    contextSafetyFactor: env.AI_LABELING_CONTEXT_SAFETY_FACTOR
      ? Number(env.AI_LABELING_CONTEXT_SAFETY_FACTOR)
      : undefined,
    estimatedCharactersPerToken: env.AI_LABELING_ESTIMATED_CHARACTERS_PER_TOKEN
      ? Number(env.AI_LABELING_ESTIMATED_CHARACTERS_PER_TOKEN)
      : undefined,
    contextHaloParagraphs: env.AI_LABELING_CONTEXT_HALO_PARAGRAPHS
      ? Number(env.AI_LABELING_CONTEXT_HALO_PARAGRAPHS)
      : undefined,
    requestProfileId: env.AI_LABELING_REQUEST_PROFILE?.trim() || undefined,
    autoRepairOnValidationFailure: booleanOption(env.AI_LABELING_AUTO_REPAIR),
  };
  return {
    defaultProviderId,
    enabledProviderIds,
    implementedProviderIds: new Set(implementedServerAIProviderIds),
    labelingModelIdByProvider: {
      mock: mockModelId,
      openai: openAIModelId,
      'gemini-ai-studio': geminiAIStudioModelId,
      'gemini-vertex': geminiVertexModelId,
      'gemini-agent-platform': geminiAgentPlatformModelId,
      anthropic: anthropicModelId,
    },
    labelingMaxInputCharacters: safeInteger(env.AI_LABELING_MAX_INPUT_CHARACTERS, 80_000),
    secretConfiguredByProvider: {
      mock: true,
      openai: Boolean(env.OPENAI_API_KEY?.trim()),
      'gemini-ai-studio': Boolean(env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()),
      'gemini-vertex': Boolean(googleCloudProject && vertexCredentialsPath),
      'gemini-agent-platform': Boolean(googleCloudProject && vertexCredentialsPath),
      anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    },
    openAI: {
      apiKey: env.OPENAI_API_KEY?.trim() || undefined,
      baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      organization: env.OPENAI_ORGANIZATION?.trim() || undefined,
      project: env.OPENAI_PROJECT?.trim() || undefined,
      providerOptions: commonProviderOptions,
    },
    geminiAIStudio: {
      apiKey: env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined,
      providerOptions: commonProviderOptions,
    },
    geminiVertex: {
      project: googleCloudProject,
      location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
      credentialsPath: vertexCredentialsPath,
      providerOptions: commonProviderOptions,
    },
    geminiAgentPlatform: {
      project: googleCloudProject,
      location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
      credentialsPath: vertexCredentialsPath,
      providerOptions: commonProviderOptions,
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
      baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
      anthropicVersion: env.ANTHROPIC_VERSION?.trim() || '2023-06-01',
      providerOptions: commonProviderOptions,
    },
  };
}

export function providerIsEnabled(settings: ServerAISettings, providerId: string): providerId is ServerAIProviderId {
  return isServerAIProviderId(providerId) && settings.enabledProviderIds.has(providerId);
}

export function modelIdForProvider(
  settings: ServerAISettings,
  providerId: ServerAIProviderId,
  requestedModelId?: string,
): string | undefined {
  return requestedModelId?.trim() || settings.labelingModelIdByProvider[providerId];
}

export function providerOptionsForAIProvider(
  settings: ServerAISettings,
  providerId: ServerAIProviderId,
): Record<string, unknown> {
  if (providerId === 'openai') return settings.openAI.providerOptions;
  if (providerId === 'gemini-ai-studio') return settings.geminiAIStudio.providerOptions;
  if (providerId === 'gemini-vertex') return settings.geminiVertex.providerOptions;
  if (providerId === 'gemini-agent-platform') return settings.geminiAgentPlatform.providerOptions;
  if (providerId === 'anthropic') return settings.anthropic.providerOptions;
  return {};
}
