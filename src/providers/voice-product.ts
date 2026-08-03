import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Character, LabeledSegment, VoiceProfile } from '../domain/types';
import type { TTSCapabilitySnapshot } from './provider-capability';
import type { TTSVoice } from './tts';

export const VOICE_PRODUCT_VERSION = 'voice-product-v1' as const;
export const PRONUNCIATION_PROJECTION_VERSION = 'pronunciation-projection-v1' as const;

export interface VoiceCatalogEntryV1 {
  readonly id: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly voiceId: string;
  readonly label: string;
  readonly locale?: string;
  readonly available: boolean;
  readonly metadataVerified: boolean;
  readonly supportedFormats: readonly string[];
  readonly supportedControls: readonly string[];
  readonly timingMarks: 'none' | 'word' | 'segment';
  readonly fingerprint: string;
}

export interface VoiceCatalogSnapshotV1 {
  readonly id: string;
  readonly novelId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly region?: string;
  readonly accountScope?: string;
  readonly source: 'live_discovery' | 'system_discovery' | 'manual_entry';
  readonly capabilitySnapshotId?: string;
  readonly capturedAt: string;
  readonly verifiedAt?: string;
  readonly fingerprint: string;
  readonly entries: readonly VoiceCatalogEntryV1[];
}

export interface VoiceSuggestionV1 {
  readonly id: string;
  readonly novelId: string;
  readonly targetKey: string;
  readonly characterId?: string;
  readonly role: VoiceProfile['role'];
  readonly voiceProfileId: string;
  readonly voiceEntryFingerprint: string;
  readonly providerId: string;
  readonly providerVoiceId: string;
  readonly major: boolean;
  readonly reason: 'user_selected' | 'verified_metadata' | 'deterministic_rotation' | 'fallback';
  readonly metadataLimitations: readonly string[];
  readonly createdAt: string;
}

export type VoiceSampleKind = 'neutral' | 'in_context';

export interface VoiceSampleRequestV1 {
  readonly id: string;
  readonly novelId: string;
  readonly characterId?: string;
  readonly voiceProfileId: string;
  readonly kind: VoiceSampleKind;
  readonly sampleTextHash: string;
  readonly sourceSegmentId?: string;
  readonly voiceEntryFingerprint: string;
  readonly normalizedControlsHash: string;
  readonly pronunciationRevisionId: string;
  readonly capabilitySnapshotId?: string;
  readonly estimatedCharacters: number;
  readonly estimatedCostMinorUnits?: number;
  readonly createdAt: string;
}

export interface VoiceSampleApprovalV1 {
  readonly approvalId: string;
  readonly novelId: string;
  readonly characterId?: string;
  readonly voiceProfileId: string;
  readonly voiceEntryFingerprint: string;
  readonly resolvedModelVersion?: string;
  readonly normalizedControlsHash: string;
  readonly pronunciationRevisionId: string;
  readonly sampleTextHashes: readonly string[];
  readonly capabilitySnapshotId?: string;
  readonly decision: 'approved' | 'rejected';
  readonly approvedAt?: string;
  readonly staleReason?: VoiceApprovalStaleReason;
}

export type VoiceApprovalStaleReason =
  | 'voice_entry_changed'
  | 'voice_unavailable'
  | 'model_version_changed'
  | 'controls_changed'
  | 'pronunciation_changed'
  | 'user_voice_override';

export interface PronunciationRuleV1 {
  readonly id: string;
  readonly sourceTerm: string;
  readonly replacement: string;
  readonly mode: 'literal' | 'phoneme';
  readonly locale?: string;
  readonly providerId?: string;
  readonly chapterId?: string;
  readonly userConfirmed: boolean;
  readonly provenance: 'user' | 'analysis' | 'import';
  readonly enabled: boolean;
}

export interface PronunciationProfileV1 {
  readonly id: string;
  readonly novelId: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly rules: readonly PronunciationRuleV1[];
  readonly updatedAt: string;
}

export interface VoiceProductStateV1 {
  readonly version: typeof VOICE_PRODUCT_VERSION;
  readonly novelId: string;
  readonly catalogSnapshots: readonly VoiceCatalogSnapshotV1[];
  readonly suggestions: readonly VoiceSuggestionV1[];
  readonly sampleRequests: readonly VoiceSampleRequestV1[];
  readonly approvals: readonly VoiceSampleApprovalV1[];
  readonly pronunciationProfile: PronunciationProfileV1;
  readonly minorFallbackEnabled: boolean;
  readonly majorCharacterLimit: number;
  readonly updatedAt: string;
}

export interface VoiceDraftTarget {
  readonly key: string;
  readonly role: VoiceProfile['role'];
  readonly characterId?: string;
  readonly label: string;
  readonly major: boolean;
  readonly spokenCharacters: number;
}

export function emptyVoiceProductState(novelId: string, now = new Date().toISOString()): VoiceProductStateV1 {
  return {
    version: VOICE_PRODUCT_VERSION,
    novelId,
    catalogSnapshots: [],
    suggestions: [],
    sampleRequests: [],
    approvals: [],
    pronunciationProfile: pronunciationProfile(novelId, [], 0, now),
    minorFallbackEnabled: false,
    majorCharacterLimit: 5,
    updatedAt: now,
  };
}

export function buildVoiceCatalogSnapshot(input: {
  readonly novelId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly voices: readonly TTSVoice[];
  readonly capability?: TTSCapabilitySnapshot;
  readonly source?: VoiceCatalogSnapshotV1['source'];
  readonly capturedAt?: string;
}): VoiceCatalogSnapshotV1 {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const entries = input.voices
    .map((voice) => {
      const core = {
        providerId: input.providerId,
        modelId: input.modelId ?? '',
        voiceId: voice.id,
        locale: voice.lang || '',
        available: true,
        supportedFormats: input.capability?.formats ?? [],
        supportedControls: input.capability?.supportedControls ?? ['voice', 'speed'],
        timingMarks: input.capability?.timingMarks ?? ('none' as const),
      };
      return {
        id: persistentId128('voice_catalog_entry', [input.providerId, input.modelId ?? '', voice.id]),
        providerId: input.providerId,
        modelId: input.modelId,
        voiceId: voice.id,
        label: voice.label,
        locale: voice.lang || undefined,
        available: true,
        metadataVerified:
          input.source === 'system_discovery' ||
          input.providerId === 'system' ||
          Boolean(input.capability && input.capability.freshness === 'verified'),
        supportedFormats: core.supportedFormats,
        supportedControls: core.supportedControls,
        timingMarks: core.timingMarks,
        fingerprint: structuredIntegrityHash(core),
      } satisfies VoiceCatalogEntryV1;
    })
    .sort((left, right) => left.voiceId.localeCompare(right.voiceId));
  const fingerprint = structuredIntegrityHash(entries.map((entry) => entry.fingerprint));
  return {
    id: persistentId128('voice_catalog_snapshot', [input.novelId, input.providerId, input.modelId ?? '', fingerprint]),
    novelId: input.novelId,
    providerId: input.providerId,
    modelId: input.modelId,
    source: input.source ?? (input.providerId === 'system' ? 'system_discovery' : 'live_discovery'),
    capabilitySnapshotId: input.capability?.id,
    capturedAt,
    verifiedAt:
      input.source === 'system_discovery' || input.providerId === 'system' || input.capability?.freshness === 'verified'
        ? capturedAt
        : undefined,
    fingerprint,
    entries,
  };
}

export function replaceCatalogSnapshot(
  state: VoiceProductStateV1,
  snapshot: VoiceCatalogSnapshotV1,
): VoiceProductStateV1 {
  const catalogSnapshots = [
    ...state.catalogSnapshots.filter(
      (item) => item.providerId !== snapshot.providerId || (item.modelId ?? '') !== (snapshot.modelId ?? ''),
    ),
    snapshot,
  ];
  return refreshApprovalStaleness({ ...state, catalogSnapshots, updatedAt: snapshot.capturedAt });
}

export function voiceDraftTargets(input: {
  readonly characters: readonly Character[];
  readonly segments: readonly LabeledSegment[];
  readonly majorCharacterLimit?: number;
  readonly pinnedCharacterIds?: readonly string[];
}): VoiceDraftTarget[] {
  const counts = new Map<string, number>();
  for (const segment of input.segments) {
    if (segment.speakerId === 'narrator' || segment.speakerId === 'system' || segment.speakerId === 'unknown') continue;
    counts.set(
      segment.speakerId,
      (counts.get(segment.speakerId) ?? 0) + Math.max(1, segment.endOffset - segment.startOffset),
    );
  }
  const limit = Math.max(1, Math.floor(input.majorCharacterLimit ?? 5));
  const pinned = new Set(input.pinnedCharacterIds ?? []);
  const rankedIds = new Set(
    [...input.characters]
      .sort(
        (left, right) => (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((character) => character.id),
  );
  return [
    { key: 'role:narrator', role: 'narrator', label: '내레이터', major: true, spokenCharacters: 0 },
    { key: 'role:system', role: 'system', label: '시스템 문구', major: true, spokenCharacters: 0 },
    { key: 'role:unknown', role: 'unknown', label: '화자 미정', major: true, spokenCharacters: 0 },
    ...input.characters.map((character) => ({
      key: `character:${character.id}`,
      role: 'character' as const,
      characterId: character.id,
      label: character.canonicalName,
      major: pinned.has(character.id) || rankedIds.has(character.id),
      spokenCharacters: counts.get(character.id) ?? 0,
    })),
  ];
}

function profileMatchesTarget(profile: VoiceProfile, target: VoiceDraftTarget): boolean {
  return (
    profile.role === target.role &&
    (target.characterId ? profile.characterId === target.characterId : !profile.characterId)
  );
}

export function buildAutomaticVoiceDraft(input: {
  readonly novelId: string;
  readonly snapshot: VoiceCatalogSnapshotV1;
  readonly targets: readonly VoiceDraftTarget[];
  readonly existingProfiles: readonly VoiceProfile[];
  readonly preferredLocale?: string;
  readonly createdAt?: string;
}): { readonly profiles: VoiceProfile[]; readonly suggestions: VoiceSuggestionV1[] } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const availableEntries = input.snapshot.entries.filter((entry) => entry.available);
  if (availableEntries.length === 0) return { profiles: [...input.existingProfiles], suggestions: [] };
  const preferredLanguage = input.preferredLocale?.split('-')[0]?.toLowerCase();
  const localeEntries = preferredLanguage
    ? availableEntries.filter((entry) => entry.locale?.split('-')[0]?.toLowerCase() === preferredLanguage)
    : [];
  const draftEntries = localeEntries.length > 0 ? localeEntries : availableEntries;
  const profiles = [...input.existingProfiles];
  const suggestions: VoiceSuggestionV1[] = [];
  const usedMajorVoices = new Set(
    input.targets
      .filter((target) => target.major)
      .flatMap((target) => profiles.filter((profile) => profileMatchesTarget(profile, target)))
      .map((profile) => profile.providerVoiceId),
  );
  let rotation = 0;
  for (const target of input.targets) {
    const existing = profiles.find(
      (profile) => profile.providerId === input.snapshot.providerId && profileMatchesTarget(profile, target),
    );
    if (existing?.isUserSelected) {
      const entry = availableEntries.find((candidate) => candidate.voiceId === existing.providerVoiceId);
      if (entry) suggestions.push(suggestion(input.novelId, target, existing, entry, 'user_selected', createdAt));
      continue;
    }
    const candidates = target.major
      ? draftEntries.filter((entry) => !usedMajorVoices.has(entry.voiceId))
      : draftEntries;
    const pool = candidates.length > 0 ? candidates : draftEntries;
    const entry = pool[rotation % pool.length];
    rotation += 1;
    if (target.major) usedMajorVoices.add(entry.voiceId);
    const profile: VoiceProfile = {
      ...(existing ?? {}),
      id:
        existing?.id ??
        persistentId128('voice_profile', [
          input.novelId,
          target.role,
          target.characterId ?? '',
          input.snapshot.providerId,
        ]),
      novelId: input.novelId,
      characterId: target.characterId,
      role: target.role,
      providerId: input.snapshot.providerId,
      providerVoiceId: entry.voiceId,
      providerModel: input.snapshot.modelId,
      label: `${target.label} · ${entry.label}`,
      language: entry.locale,
      speed: existing?.speed ?? 1,
      providerOptions: existing?.providerOptions ?? {},
      isUserSelected: false,
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: createdAt,
    };
    const existingIndex = profiles.findIndex((candidate) => candidate.id === profile.id);
    if (existingIndex >= 0) profiles[existingIndex] = profile;
    else profiles.push(profile);
    suggestions.push(
      suggestion(
        input.novelId,
        target,
        profile,
        entry,
        entry.metadataVerified ? 'verified_metadata' : 'deterministic_rotation',
        createdAt,
      ),
    );
  }
  return { profiles, suggestions };
}

function suggestion(
  novelId: string,
  target: VoiceDraftTarget,
  profile: VoiceProfile,
  entry: VoiceCatalogEntryV1,
  reason: VoiceSuggestionV1['reason'],
  createdAt: string,
): VoiceSuggestionV1 {
  return {
    id: persistentId128('voice_suggestion', [novelId, target.key, profile.id, entry.fingerprint]),
    novelId,
    targetKey: target.key,
    characterId: target.characterId,
    role: target.role,
    voiceProfileId: profile.id,
    voiceEntryFingerprint: entry.fingerprint,
    providerId: profile.providerId,
    providerVoiceId: profile.providerVoiceId,
    major: target.major,
    reason,
    metadataLimitations: entry.metadataVerified ? [] : ['provider_metadata_unverified', 'acoustic_traits_unknown'],
    createdAt,
  };
}

export function normalizedVoiceControlsHash(profile: VoiceProfile): string {
  return structuredIntegrityHash({
    speed: profile.speed,
    pitch: profile.pitch ?? null,
    tone: profile.tone ?? '',
    emotionPolicy: profile.emotionPolicy ?? '',
    providerOptions: profile.providerOptions ?? {},
  });
}

export function buildVoiceSampleRequest(input: {
  readonly state: VoiceProductStateV1;
  readonly profile: VoiceProfile;
  readonly kind: VoiceSampleKind;
  readonly text: string;
  readonly sourceSegmentId?: string;
  readonly capabilitySnapshotId?: string;
  readonly estimatedCostMinorUnits?: number;
  readonly createdAt?: string;
}): VoiceSampleRequestV1 {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entry = currentVoiceEntry(input.state, input.profile);
  if (!entry) throw new Error('Selected voice is not present in the current voice catalog');
  const sampleTextHash = structuredIntegrityHash(input.text);
  const controlsHash = normalizedVoiceControlsHash(input.profile);
  return {
    id: persistentId128('voice_sample_request', [
      input.profile.id,
      input.kind,
      sampleTextHash,
      entry.fingerprint,
      controlsHash,
    ]),
    novelId: input.profile.novelId,
    characterId: input.profile.characterId,
    voiceProfileId: input.profile.id,
    kind: input.kind,
    sampleTextHash,
    sourceSegmentId: input.sourceSegmentId,
    voiceEntryFingerprint: entry.fingerprint,
    normalizedControlsHash: controlsHash,
    pronunciationRevisionId: input.state.pronunciationProfile.revisionId,
    capabilitySnapshotId: input.capabilitySnapshotId,
    estimatedCharacters: input.text.length,
    estimatedCostMinorUnits: input.estimatedCostMinorUnits,
    createdAt,
  };
}

export function approveVoiceSamples(input: {
  readonly state: VoiceProductStateV1;
  readonly profile: VoiceProfile;
  readonly decision: VoiceSampleApprovalV1['decision'];
  readonly resolvedModelVersion?: string;
  readonly approvedAt?: string;
}): VoiceSampleApprovalV1 {
  const requests = input.state.sampleRequests.filter((request) => request.voiceProfileId === input.profile.id);
  if (requests.length === 0) throw new Error('At least one voice sample is required before approval');
  const entry = currentVoiceEntry(input.state, input.profile);
  if (!entry) throw new Error('Selected voice is not present in the current voice catalog');
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  const normalizedControlsHash = normalizedVoiceControlsHash(input.profile);
  return {
    approvalId: persistentId128('voice_sample_approval', [
      input.profile.id,
      entry.fingerprint,
      normalizedControlsHash,
      input.state.pronunciationProfile.revisionId,
    ]),
    novelId: input.profile.novelId,
    characterId: input.profile.characterId,
    voiceProfileId: input.profile.id,
    voiceEntryFingerprint: entry.fingerprint,
    resolvedModelVersion: input.resolvedModelVersion,
    normalizedControlsHash,
    pronunciationRevisionId: input.state.pronunciationProfile.revisionId,
    sampleTextHashes: [...new Set(requests.map((request) => request.sampleTextHash))],
    capabilitySnapshotId: requests.find((request) => request.capabilitySnapshotId)?.capabilitySnapshotId,
    decision: input.decision,
    approvedAt: input.decision === 'approved' ? approvedAt : undefined,
  };
}

export function voiceApprovalForProfile(
  state: VoiceProductStateV1,
  profile: VoiceProfile,
): VoiceSampleApprovalV1 | undefined {
  const approval = state.approvals.find((item) => item.voiceProfileId === profile.id);
  return approval ? staleVoiceApproval(state, profile, approval) : undefined;
}

export function staleVoiceApproval(
  state: VoiceProductStateV1,
  profile: VoiceProfile,
  approval: VoiceSampleApprovalV1,
): VoiceSampleApprovalV1 {
  const entry = currentVoiceEntry(state, profile);
  const staleReason: VoiceApprovalStaleReason | undefined = !entry
    ? 'voice_unavailable'
    : entry.fingerprint !== approval.voiceEntryFingerprint
      ? 'voice_entry_changed'
      : normalizedVoiceControlsHash(profile) !== approval.normalizedControlsHash
        ? 'controls_changed'
        : state.pronunciationProfile.revisionId !== approval.pronunciationRevisionId
          ? 'pronunciation_changed'
          : undefined;
  return { ...approval, staleReason };
}

export function refreshApprovalStaleness(
  state: VoiceProductStateV1,
  profiles: readonly VoiceProfile[] = [],
): VoiceProductStateV1 {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const approvals = state.approvals.map((approval) => {
    const profile = byId.get(approval.voiceProfileId);
    if (profile) return staleVoiceApproval(state, profile, approval);
    const entryExists = state.catalogSnapshots.some((snapshot) =>
      snapshot.entries.some((entry) => entry.fingerprint === approval.voiceEntryFingerprint && entry.available),
    );
    return { ...approval, staleReason: entryExists ? approval.staleReason : 'voice_unavailable' };
  });
  return { ...state, approvals };
}

export function updatePronunciationProfile(
  state: VoiceProductStateV1,
  rules: readonly PronunciationRuleV1[],
  updatedAt = new Date().toISOString(),
): VoiceProductStateV1 {
  const nextProfile = pronunciationProfile(state.novelId, rules, state.pronunciationProfile.revision + 1, updatedAt);
  return refreshApprovalStaleness({ ...state, pronunciationProfile: nextProfile, updatedAt });
}

function pronunciationProfile(
  novelId: string,
  rules: readonly PronunciationRuleV1[],
  revision: number,
  updatedAt: string,
): PronunciationProfileV1 {
  const normalizedRules = [...rules].sort((left, right) => left.id.localeCompare(right.id));
  const fingerprint = structuredIntegrityHash(normalizedRules);
  return {
    id: persistentId128('pronunciation_profile', [novelId]),
    novelId,
    revision,
    revisionId: persistentId128('pronunciation_revision', [novelId, String(revision), fingerprint]),
    rules: normalizedRules,
    updatedAt,
  };
}

export function projectPronunciation(input: {
  readonly text: string;
  readonly profile: PronunciationProfileV1;
  readonly providerId?: string;
  readonly locale?: string;
  readonly chapterId?: string;
  readonly supportsSsml?: boolean;
}): { readonly text: string; readonly appliedRuleIds: readonly string[]; readonly fingerprint: string } {
  let text = input.text;
  const appliedRuleIds: string[] = [];
  const rules = input.profile.rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.sourceTerm &&
        (!rule.providerId || rule.providerId === input.providerId) &&
        (!rule.locale || rule.locale === input.locale) &&
        (!rule.chapterId || rule.chapterId === input.chapterId),
    )
    .sort(
      (left, right) =>
        Number(right.userConfirmed) - Number(left.userConfirmed) ||
        right.sourceTerm.length - left.sourceTerm.length ||
        left.id.localeCompare(right.id),
    );
  for (const rule of rules) {
    if (rule.mode === 'phoneme' && !input.supportsSsml) continue;
    if (rule.mode === 'phoneme') continue; // Provider-specific allowlist serializers are introduced at the adapter boundary.
    if (!text.includes(rule.sourceTerm)) continue;
    text = text.split(rule.sourceTerm).join(rule.replacement);
    appliedRuleIds.push(rule.id);
  }
  return {
    text,
    appliedRuleIds,
    fingerprint: structuredIntegrityHash({
      projectionVersion: PRONUNCIATION_PROJECTION_VERSION,
      pronunciationRevisionId: input.profile.revisionId,
      appliedRuleIds,
      text,
    }),
  };
}

export function currentVoiceEntry(state: VoiceProductStateV1, profile: VoiceProfile): VoiceCatalogEntryV1 | undefined {
  return state.catalogSnapshots
    .filter(
      (snapshot) =>
        snapshot.providerId === profile.providerId &&
        (!profile.providerModel || !snapshot.modelId || snapshot.modelId === profile.providerModel),
    )
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0]
    ?.entries.find((entry) => entry.voiceId === profile.providerVoiceId && entry.available);
}

export function canWarmMajorVoice(state: VoiceProductStateV1, profile: VoiceProfile, major: boolean): boolean {
  if (!major) return state.minorFallbackEnabled || profile.isUserSelected;
  const approval = voiceApprovalForProfile(state, profile);
  return approval?.decision === 'approved' && !approval.staleReason;
}
