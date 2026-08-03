import type { VoiceProfile } from '../../domain/types';
import { compareText, voiceCastingIdentity } from './artifact';
import type { VoicePoolDefinitionV1 } from './contracts';
import { VOICE_CASTING_VERSION } from './contracts';

export interface VoicePoolValidationIssueV1 {
  readonly code:
    | 'duplicate_pool_key'
    | 'duplicate_profile_id'
    | 'duplicate_actual_voice'
    | 'missing_voice_profile'
    | 'provider_mismatch'
    | 'model_mismatch'
    | 'narrator_excluded';
  readonly poolId: string;
  readonly voiceProfileId?: string;
  readonly conflictingVoiceProfileId?: string;
}

export interface VoicePoolValidationResultV1 {
  readonly valid: boolean;
  readonly issues: readonly VoicePoolValidationIssueV1[];
}

function normalized(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function actualProviderVoiceKey(
  profile: Pick<VoiceProfile, 'providerId' | 'providerModel' | 'providerVoiceId'>,
): string {
  return [profile.providerId, profile.providerModel ?? '', profile.providerVoiceId]
    .map((value) => encodeURIComponent(normalized(value)))
    .join('|');
}

export function createVoicePoolDefinition(
  input: Omit<VoicePoolDefinitionV1, 'version' | 'id' | 'revision' | 'fingerprint'>,
): VoicePoolDefinitionV1 {
  if (!input.providerId.trim()) throw new Error('Voice pool providerId is required');
  if (!input.key.trim()) throw new Error('Voice pool key is required');
  const core = {
    version: VOICE_CASTING_VERSION,
    ...input,
    voiceProfileIds: [...input.voiceProfileIds].sort(compareText),
  };
  return { ...core, ...voiceCastingIdentity('voice_pool_definition', core) };
}

export function validateVoicePools(input: {
  readonly pools: readonly VoicePoolDefinitionV1[];
  readonly voiceProfiles: readonly VoiceProfile[];
}): VoicePoolValidationResultV1 {
  const issues: VoicePoolValidationIssueV1[] = [];
  const profiles = new Map(input.voiceProfiles.map((profile) => [profile.id, profile]));
  const activeKeys = new Map<string, string>();
  for (const pool of [...input.pools].sort((left, right) => compareText(left.id, right.id))) {
    if (pool.status !== 'active') continue;
    const keyScope = `${pool.bookId}\u0000${pool.contentRevisionId}\u0000${pool.key}`;
    const priorPoolId = activeKeys.get(keyScope);
    if (priorPoolId) {
      issues.push({ code: 'duplicate_pool_key', poolId: pool.id, conflictingVoiceProfileId: priorPoolId });
    } else {
      activeKeys.set(keyScope, pool.id);
    }

    const seenProfileIds = new Set<string>();
    const seenActualVoices = new Map<string, string>();
    for (const voiceProfileId of pool.voiceProfileIds) {
      if (seenProfileIds.has(voiceProfileId)) {
        issues.push({ code: 'duplicate_profile_id', poolId: pool.id, voiceProfileId });
        continue;
      }
      seenProfileIds.add(voiceProfileId);
      const profile = profiles.get(voiceProfileId);
      if (!profile) {
        issues.push({ code: 'missing_voice_profile', poolId: pool.id, voiceProfileId });
        continue;
      }
      if (profile.providerId !== pool.providerId) {
        issues.push({ code: 'provider_mismatch', poolId: pool.id, voiceProfileId });
      }
      if (pool.providerModel !== undefined && profile.providerModel !== pool.providerModel) {
        issues.push({ code: 'model_mismatch', poolId: pool.id, voiceProfileId });
      }
      if (pool.narratorExcluded && profile.role === 'narrator') {
        issues.push({ code: 'narrator_excluded', poolId: pool.id, voiceProfileId });
      }
      const actualKey = actualProviderVoiceKey(profile);
      const priorProfileId = seenActualVoices.get(actualKey);
      if (priorProfileId) {
        issues.push({
          code: 'duplicate_actual_voice',
          poolId: pool.id,
          voiceProfileId,
          conflictingVoiceProfileId: priorProfileId,
        });
      } else {
        seenActualVoices.set(actualKey, voiceProfileId);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}
