import {
  createEmptyVoiceCastingWorkspace,
  normalizeVoiceCastingWorkspace,
  VOICE_CASTING_VERSION,
  type VoiceCastingWorkspaceUserArtifactsV1,
  type VoiceCastingWorkspaceV1,
} from '../providers/voice-casting';
import type { JsonValue } from './types';

export interface VoiceCastingUpdatedPayloadV1 {
  readonly version: typeof VOICE_CASTING_VERSION;
  readonly contentRevisionId: string;
  readonly storageRevision: number;
  readonly userArtifacts: VoiceCastingWorkspaceUserArtifactsV1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function voiceCastingUpdatedPayload(workspace: VoiceCastingWorkspaceV1): JsonValue {
  return jsonValue({
    version: VOICE_CASTING_VERSION,
    contentRevisionId: workspace.contentRevisionId,
    storageRevision: workspace.storageRevision,
    userArtifacts: workspace.userArtifacts,
  } satisfies VoiceCastingUpdatedPayloadV1);
}

export function parseVoiceCastingUpdatedPayload(
  value: unknown,
  bookId: string,
): VoiceCastingUpdatedPayloadV1 | undefined {
  const payload = record(value);
  const userArtifacts = record(payload?.userArtifacts);
  if (
    !payload ||
    !userArtifacts ||
    !hasExactKeys(payload, ['contentRevisionId', 'storageRevision', 'userArtifacts', 'version']) ||
    !hasExactKeys(userArtifacts, ['overrides', 'pools', 'traitEvidence', 'voiceProfileIds']) ||
    payload.version !== VOICE_CASTING_VERSION ||
    typeof payload.contentRevisionId !== 'string' ||
    !payload.contentRevisionId.trim() ||
    !Number.isSafeInteger(payload.storageRevision) ||
    Number(payload.storageRevision) < 1
  ) {
    return undefined;
  }

  const empty = createEmptyVoiceCastingWorkspace({
    bookId,
    contentRevisionId: payload.contentRevisionId,
    storageRevision: Number(payload.storageRevision),
  });
  try {
    const normalized = normalizeVoiceCastingWorkspace({
      bookId,
      contentRevisionId: payload.contentRevisionId,
      storageRevision: Number(payload.storageRevision),
      userArtifacts: userArtifacts as unknown as VoiceCastingWorkspaceUserArtifactsV1,
      derivedArtifacts: empty.derivedArtifacts,
    });
    return {
      version: VOICE_CASTING_VERSION,
      contentRevisionId: normalized.contentRevisionId,
      storageRevision: normalized.storageRevision,
      userArtifacts: normalized.userArtifacts,
    };
  } catch {
    return undefined;
  }
}
