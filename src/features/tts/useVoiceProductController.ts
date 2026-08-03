import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Character, VoiceProfile } from '../../domain/types';
import { voiceProfilesRevision } from '../../domain/resource-revisions';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { TTSVoice } from '../../providers/tts';
import type { TTSCapabilitySnapshot } from '../../providers/provider-capability';
import {
  approveVoiceSamples,
  buildVoiceCatalogSnapshot,
  buildVoiceSampleRequest,
  emptyVoiceProductState,
  projectPronunciation,
  replaceCatalogSnapshot,
  updatePronunciationProfile,
  voiceApprovalForProfile,
  type PronunciationRuleV1,
  type VoiceProductStateV1,
  type VoiceSampleKind,
} from '../../providers/voice-product';
import {
  computeVoiceCastingState,
  createVoiceAssignmentOverride,
  normalizeVoiceCastingWorkspace,
  resolveTtsVoiceBindings,
  type VoiceCastingWorkspaceV1,
} from '../../providers/voice-casting';
import {
  buildVoiceCastingProductDraft,
  invalidateVoiceCastingWorkspace,
  replaceVoiceCastingPool,
  shouldPersistVoiceCastingDraft,
} from './voice-casting-product';

type NoticeTone = 'success' | 'warning' | 'info' | 'danger';

export interface VoiceProductProviderInput {
  readonly providerId: string;
  readonly modelId?: string;
  readonly voices: readonly TTSVoice[];
  readonly source?: 'live_discovery' | 'system_discovery' | 'manual_entry';
  readonly capability?: TTSCapabilitySnapshot;
}

export interface VoiceProductControllerInput {
  readonly repository: ReaderRepository;
  readonly novelId?: string;
  readonly contentRevisionId?: string;
  readonly characters: readonly Character[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly systemProvider: VoiceProductProviderInput;
  readonly hostedProvider?: VoiceProductProviderInput;
  readonly playSample: (profile: VoiceProfile, text: string, kind: VoiceSampleKind) => Promise<boolean>;
  readonly onProfilesChanged: (profiles: VoiceProfile[]) => void;
  readonly notify: (message: string, tone: NoticeTone) => void;
}

export interface VoiceCastingPoolView {
  readonly providerId: string;
  readonly providerModel?: string;
  readonly userPinned: boolean;
  readonly options: readonly {
    readonly profile: VoiceProfile;
    readonly voice: TTSVoice;
    readonly selected: boolean;
  }[];
}

export function useVoiceProductController(input: VoiceProductControllerInput) {
  const [state, setState] = useState<VoiceProductStateV1>();
  const [castingWorkspace, setCastingWorkspace] = useState<VoiceCastingWorkspaceV1>();
  const [busy, setBusy] = useState(false);
  const [sampleBusyProfileId, setSampleBusyProfileId] = useState<string>();
  const epochRef = useRef(0);
  const notify = input.notify;
  const novelId = input.novelId;
  const repository = input.repository;

  useEffect(() => {
    const epoch = ++epochRef.current;
    setState(novelId ? emptyVoiceProductState(novelId) : undefined);
    setCastingWorkspace(undefined);
    setBusy(false);
    setSampleBusyProfileId(undefined);
    if (!novelId) return;
    void Promise.all([
      repository.getVoiceProductState(novelId),
      repository.getVoiceCastingWorkspace?.(novelId) ?? Promise.resolve(undefined),
    ])
      .then(([loaded, loadedCasting]) => {
        if (epochRef.current === epoch) {
          setState(loaded);
          setCastingWorkspace(loadedCasting);
        }
      })
      .catch(() => {
        if (epochRef.current === epoch) notify('음성 승인 설정을 불러오지 못했습니다.', 'warning');
      });
  }, [novelId, notify, repository]);

  const saveState = useCallback(
    async (next: VoiceProductStateV1) => {
      await input.repository.saveVoiceProductState(next.novelId, next);
      if (epochRef.current > 0 && input.novelId === next.novelId) setState(next);
    },
    [input.novelId, input.repository],
  );

  const generateDraft = useCallback(
    async (scope: 'system' | 'hosted') => {
      if (!input.novelId || !state || busy) return;
      if (!input.contentRevisionId) {
        input.notify(
          '현재 본문 리비전이 없어 음성 배정을 만들 수 없습니다. 원본을 다시 선택해 책을 갱신하세요.',
          'warning',
        );
        return;
      }
      const provider = scope === 'system' ? input.systemProvider : input.hostedProvider;
      if (!provider || provider.voices.length === 0) {
        input.notify('먼저 사용할 provider의 음성 목록을 불러오세요.', 'warning');
        return;
      }
      setBusy(true);
      try {
        const now = new Date().toISOString();
        const snapshot = buildVoiceCatalogSnapshot({
          novelId: input.novelId,
          providerId: provider.providerId,
          modelId: provider.modelId,
          voices: provider.voices,
          source: provider.source,
          capability: provider.capability,
          capturedAt: now,
        });
        const withCatalog = replaceCatalogSnapshot(state, snapshot);
        if (
          !input.repository.listAcceptedSpeakerUtterances ||
          !input.repository.getVoiceCastingWorkspace ||
          !input.repository.saveVoiceCastingWorkspace
        ) {
          throw new Error('현재 저장 모드는 작품 전체 음성 배정을 지원하지 않습니다.');
        }
        const currentProfiles = await input.repository.listVoiceProfiles(input.novelId);
        const [utterances, existingWorkspace, characterKnowledge] = await Promise.all([
          input.repository.listAcceptedSpeakerUtterances({
            bookId: input.novelId,
            contentRevisionId: input.contentRevisionId,
          }),
          input.repository.getVoiceCastingWorkspace(input.novelId),
          input.repository.getCharacterGraphKnowledgeV2(input.novelId),
        ]);
        const draft = buildVoiceCastingProductDraft({
          bookId: input.novelId,
          contentRevisionId: input.contentRevisionId,
          utterances,
          characters: input.characters,
          snapshot,
          existingProfiles: currentProfiles,
          existingWorkspace,
          characterKnowledge,
          majorCharacterLimit: state.majorCharacterLimit,
          preferredLocale: 'ko-KR',
          createdAt: now,
        });
        const persistCasting = shouldPersistVoiceCastingDraft({
          scope,
          providerId: provider.providerId,
          existingWorkspace,
          existingProfiles: currentProfiles,
        });
        if (persistCasting) {
          await input.repository.saveVoiceCastingWorkspace({
            workspace: draft.workspace,
            expectedStorageRevision: existingWorkspace?.storageRevision ?? 0,
          });
        }
        try {
          await input.repository.saveVoiceProfiles(input.novelId, [...draft.voiceProfiles], {
            expectedRevision: voiceProfilesRevision(currentProfiles),
          });
        } catch (error) {
          if (persistCasting) {
            const invalidated = invalidateVoiceCastingWorkspace(draft.workspace);
            setCastingWorkspace(invalidated);
            await input.repository
              .saveVoiceCastingWorkspace({
                workspace: invalidated,
                expectedStorageRevision: draft.workspace.storageRevision,
              })
              .catch(() => undefined);
          }
          throw error;
        }
        const next = {
          ...withCatalog,
          suggestions: [
            ...withCatalog.suggestions.filter((item) => item.providerId !== provider.providerId),
            ...draft.suggestions,
          ],
          updatedAt: now,
        };
        await saveState(next);
        if (persistCasting) setCastingWorkspace(draft.workspace);
        input.onProfilesChanged([...draft.voiceProfiles]);
        input.notify(
          !persistCasting
            ? '시스템 음성 초안을 갱신했습니다. 기존 Hosted 음성 배정은 유지됩니다.'
            : utterances.length > 0
              ? `작품 전체 승인 라벨로 음성을 배정했습니다. ${draft.workspace.derivedArtifacts.state.reviews.length}건은 검토가 필요합니다.`
              : '승인된 화자 라벨이 없어 역할 음성과 음성 풀만 준비했습니다.',
          'success',
        );
      } catch (error) {
        input.notify(error instanceof Error ? error.message : '음성 초안을 저장하지 못했습니다.', 'danger');
      } finally {
        setBusy(false);
      }
    },
    [busy, input, saveState, state],
  );

  const playAndRecordSample = useCallback(
    async (profile: VoiceProfile, kind: VoiceSampleKind, text: string, sourceSegmentId?: string) => {
      if (!state || sampleBusyProfileId || !text.trim()) return false;
      setSampleBusyProfileId(profile.id);
      try {
        const projected = projectPronunciation({
          text,
          profile: state.pronunciationProfile,
          providerId: profile.providerId,
          locale: profile.language,
        });
        const played = await input.playSample(profile, kind === 'neutral' ? text : projected.text, kind);
        if (!played) {
          input.notify('샘플 오디오를 재생하지 못했습니다.', 'warning');
          return false;
        }
        const request = buildVoiceSampleRequest({ state, profile, kind, text, sourceSegmentId });
        await saveState({
          ...state,
          sampleRequests: [...state.sampleRequests.filter((item) => item.id !== request.id), request],
          updatedAt: request.createdAt,
        });
        return true;
      } catch (error) {
        input.notify(error instanceof Error ? error.message : '샘플 합성에 실패했습니다.', 'danger');
        return false;
      } finally {
        setSampleBusyProfileId(undefined);
      }
    },
    [input, sampleBusyProfileId, saveState, state],
  );

  const decide = useCallback(
    async (profile: VoiceProfile, decision: 'approved' | 'rejected') => {
      if (!state || busy) return;
      setBusy(true);
      try {
        const approval = approveVoiceSamples({ state, profile, decision });
        await saveState({
          ...state,
          approvals: [...state.approvals.filter((item) => item.voiceProfileId !== profile.id), approval],
          updatedAt: new Date().toISOString(),
        });
        input.notify(decision === 'approved' ? '이 음성을 승인했습니다.' : '이 음성을 제외했습니다.', 'success');
      } catch (error) {
        input.notify(error instanceof Error ? error.message : '샘플 결정을 저장하지 못했습니다.', 'warning');
      } finally {
        setBusy(false);
      }
    },
    [busy, input, saveState, state],
  );

  const savePronunciationRule = useCallback(
    async (rule: Omit<PronunciationRuleV1, 'id' | 'userConfirmed' | 'provenance' | 'enabled'> & { id?: string }) => {
      if (!state || busy || !rule.sourceTerm.trim() || !rule.replacement.trim()) return;
      const id = rule.id ?? `pronunciation_${crypto.randomUUID()}`;
      const nextRule: PronunciationRuleV1 = {
        ...rule,
        id,
        sourceTerm: rule.sourceTerm.trim(),
        replacement: rule.replacement.trim(),
        userConfirmed: true,
        provenance: 'user',
        enabled: true,
      };
      const rules = [...state.pronunciationProfile.rules.filter((item) => item.id !== id), nextRule];
      await saveState(updatePronunciationProfile(state, rules));
      input.notify('발음 규칙을 저장했습니다. 기존 음성 승인은 재검토가 필요합니다.', 'success');
    },
    [busy, input, saveState, state],
  );

  const deletePronunciationRule = useCallback(
    async (id: string) => {
      if (!state || busy) return;
      await saveState(
        updatePronunciationProfile(
          state,
          state.pronunciationProfile.rules.filter((item) => item.id !== id),
        ),
      );
    },
    [busy, saveState, state],
  );

  const setMinorFallbackEnabled = useCallback(
    async (enabled: boolean) => {
      if (!state) return;
      await saveState({ ...state, minorFallbackEnabled: enabled, updatedAt: new Date().toISOString() });
    },
    [saveState, state],
  );

  const setMajorCharacterLimit = useCallback(
    async (value: number) => {
      if (!state) return;
      const majorCharacterLimit = Math.min(50, Math.max(1, Math.floor(value)));
      await saveState({ ...state, majorCharacterLimit, updatedAt: new Date().toISOString() });
    },
    [saveState, state],
  );

  const summary = useMemo(() => {
    if (!state) return { major: 0, approved: 0, stale: 0 };
    const majorProfileIds = new Set(state.suggestions.filter((item) => item.major).map((item) => item.voiceProfileId));
    let approved = 0;
    let stale = 0;
    for (const profile of input.voiceProfiles) {
      if (!majorProfileIds.has(profile.id)) continue;
      const approval = voiceApprovalForProfile(state, profile);
      if (approval?.decision === 'approved' && !approval.staleReason) approved += 1;
      else if (approval?.staleReason) stale += 1;
    }
    return { major: majorProfileIds.size, approved, stale };
  }, [input.voiceProfiles, state]);

  const castingIsActive = Boolean(
    castingWorkspace &&
    castingWorkspace.contentRevisionId === input.contentRevisionId &&
    castingWorkspace.status === 'active' &&
    castingWorkspace.derivedArtifacts.state.status === 'active',
  );

  const castingProjection = useMemo(() => {
    if (!castingWorkspace || !castingIsActive) {
      return { bindings: [], unresolvedSegmentIds: [] } as const;
    }
    return resolveTtsVoiceBindings({
      utterances: castingWorkspace.derivedArtifacts.utterances,
      assignments: castingWorkspace.derivedArtifacts.state.assignments,
      voiceProfiles: input.voiceProfiles,
    });
  }, [castingIsActive, castingWorkspace, input.voiceProfiles]);

  const activeCastingProviderIds = useMemo(
    () =>
      new Set(
        castingWorkspace?.derivedArtifacts.state.assignments.flatMap((assignment) => {
          const providerId = input.voiceProfiles.find(
            (profile) => profile.id === assignment.voiceProfileId,
          )?.providerId;
          return providerId ? [providerId] : [];
        }) ?? [],
      ),
    [castingWorkspace, input.voiceProfiles],
  );

  const castingSummary = useMemo(
    () => ({
      assigned:
        castingWorkspace?.derivedArtifacts.state.assignments.filter((item) => item.status === 'active').length ?? 0,
      reviews: castingWorkspace?.derivedArtifacts.state.reviews.filter((item) => item.status === 'open').length ?? 0,
      unresolved: castingProjection.unresolvedSegmentIds.length,
      stale: Boolean(castingWorkspace && !castingIsActive),
    }),
    [castingIsActive, castingProjection.unresolvedSegmentIds.length, castingWorkspace],
  );

  const voicePoolViews = useMemo(() => {
    const view = (provider?: VoiceProductProviderInput): VoiceCastingPoolView | undefined => {
      if (!provider || !castingWorkspace || !castingIsActive) return undefined;
      if (activeCastingProviderIds.size > 0 && !activeCastingProviderIds.has(provider.providerId)) return undefined;
      const key = `default:${provider.providerId}:${provider.modelId ?? 'default'}`;
      const pool = [...castingWorkspace.userArtifacts.pools, ...castingWorkspace.derivedArtifacts.pools].find(
        (candidate) => candidate.status === 'active' && candidate.key === key,
      );
      if (!pool) return undefined;
      const selected = new Set(pool.voiceProfileIds);
      const options = provider.voices.flatMap((voice) => {
        const profile = input.voiceProfiles.find(
          (candidate) =>
            candidate.id.startsWith('voice_pool_profile_') &&
            candidate.providerId === provider.providerId &&
            candidate.providerModel === provider.modelId &&
            candidate.providerVoiceId === voice.id,
        );
        return profile ? [{ profile, voice, selected: selected.has(profile.id) }] : [];
      });
      return options.length > 0
        ? {
            providerId: provider.providerId,
            providerModel: provider.modelId,
            userPinned: pool.userPinned,
            options,
          }
        : undefined;
    };
    return { system: view(input.systemProvider), hosted: view(input.hostedProvider) } as const;
  }, [
    activeCastingProviderIds,
    castingIsActive,
    castingWorkspace,
    input.hostedProvider,
    input.systemProvider,
    input.voiceProfiles,
  ]);

  const loadVoiceBindings = useCallback(
    async (chapterId?: string, providerId?: string) => {
      if (!castingWorkspace || !castingIsActive) return [];
      if (!input.repository.listAcceptedSpeakerUtterances) {
        return castingProjection.bindings.filter(
          (binding) =>
            (chapterId === undefined || binding.chapterId === chapterId) &&
            (providerId === undefined || binding.voiceProfile.providerId === providerId),
        );
      }
      const utterances = await input.repository.listAcceptedSpeakerUtterances({
        bookId: castingWorkspace.bookId,
        contentRevisionId: castingWorkspace.contentRevisionId,
        chapterId,
      });
      return resolveTtsVoiceBindings({
        utterances,
        assignments: castingWorkspace.derivedArtifacts.state.assignments,
        voiceProfiles: input.voiceProfiles,
        providerId,
      }).bindings;
    },
    [castingIsActive, castingProjection.bindings, castingWorkspace, input.repository, input.voiceProfiles],
  );

  const reconcileUserVoiceProfiles = useCallback(
    async (nextProfiles: readonly VoiceProfile[]) => {
      if (!castingWorkspace || !castingIsActive || !input.repository.saveVoiceCastingWorkspace) return;
      const derived = castingWorkspace.derivedArtifacts;
      const profileById = new Map(nextProfiles.map((profile) => [profile.id, profile] as const));
      const previousProfileById = new Map(input.voiceProfiles.map((profile) => [profile.id, profile] as const));
      const activeProviderBySpeaker = new Map<string, string>();
      for (const assignment of derived.state.assignments.filter((item) => item.status === 'active')) {
        const providerId =
          profileById.get(assignment.voiceProfileId)?.providerId ??
          previousProfileById.get(assignment.voiceProfileId)?.providerId;
        if (providerId) activeProviderBySpeaker.set(assignment.speakerEntityId, providerId);
      }
      const canonicalBySpeaker = new Map<string, string>();
      for (const utterance of [...derived.utterances].sort(
        (left, right) => left.narrativeOrder - right.narrativeOrder,
      )) {
        if (!['unknown', 'narrator', 'system'].includes(utterance.canonicalSpeakerId)) {
          canonicalBySpeaker.set(utterance.speakerEntityId, utterance.canonicalSpeakerId);
        }
      }
      const importanceBySpeaker = new Map(
        derived.importanceProfiles.map((profile) => [profile.speakerEntityId, profile] as const),
      );
      const retainedOverrides = castingWorkspace.userArtifacts.overrides.filter(
        (override) => !canonicalBySpeaker.has(override.speakerEntityId),
      );
      const manualOverrides = [...canonicalBySpeaker.entries()].flatMap(([speakerEntityId, characterId]) => {
        const providerId = activeProviderBySpeaker.get(speakerEntityId);
        const selected = nextProfiles
          .filter(
            (profile) =>
              profile.isUserSelected &&
              profile.role === 'character' &&
              profile.characterId === characterId &&
              (providerId === undefined || profile.providerId === providerId),
          )
          .sort(
            (left, right) =>
              (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id),
          )[0];
        const importance = importanceBySpeaker.get(speakerEntityId);
        if (!selected || !importance) return [];
        const existing = castingWorkspace.userArtifacts.overrides.find(
          (override) => override.speakerEntityId === speakerEntityId && override.voiceProfileId === selected.id,
        );
        if (existing) return [existing];
        return [
          createVoiceAssignmentOverride({
            bookId: castingWorkspace.bookId,
            contentRevisionId: castingWorkspace.contentRevisionId,
            speakerEntityId,
            voiceIdentityId: `user_voice_${speakerEntityId}`,
            voiceProfileId: selected.id,
            reasonCode: 'user_selection',
            effectiveFromOrder: importance.effectiveFromOrder,
            effectiveToOrder: importance.effectiveToOrder,
            effectiveFromSceneId: importance.effectiveFromSceneId,
            effectiveToSceneId: importance.effectiveToSceneId,
            status: 'active',
          }),
        ];
      });
      const overrides = [...retainedOverrides, ...manualOverrides];
      const dedicatedVoiceProfileIdsBySpeakerEntityId = Object.fromEntries(
        derived.state.assignments
          .filter((assignment) => assignment.status === 'active' && assignment.voiceTier === 'A_dedicated')
          .map((assignment) => [assignment.speakerEntityId, [assignment.voiceProfileId]] as const),
      );
      const state = computeVoiceCastingState({
        bookId: castingWorkspace.bookId,
        contentRevisionId: castingWorkspace.contentRevisionId,
        utterances: derived.utterances,
        importanceProfiles: derived.importanceProfiles,
        traitProfiles: derived.traitProfiles,
        pools: [...castingWorkspace.userArtifacts.pools, ...derived.pools],
        voiceProfiles: nextProfiles,
        existingAssignments: derived.state.assignments,
        overrides,
        dedicatedVoiceProfileIdsBySpeakerEntityId,
      });
      const workspace = normalizeVoiceCastingWorkspace({
        bookId: castingWorkspace.bookId,
        contentRevisionId: castingWorkspace.contentRevisionId,
        storageRevision: castingWorkspace.storageRevision + 1,
        userArtifacts: {
          ...castingWorkspace.userArtifacts,
          voiceProfileIds: nextProfiles.filter((profile) => profile.isUserSelected).map((profile) => profile.id),
          overrides,
        },
        derivedArtifacts: { ...derived, state },
      });
      try {
        await input.repository.saveVoiceCastingWorkspace({
          workspace,
          expectedStorageRevision: castingWorkspace.storageRevision,
        });
        setCastingWorkspace(workspace);
      } catch (error) {
        const invalidated = invalidateVoiceCastingWorkspace(castingWorkspace);
        setCastingWorkspace(invalidated);
        await input.repository
          .saveVoiceCastingWorkspace({
            workspace: invalidated,
            expectedStorageRevision: castingWorkspace.storageRevision,
          })
          .catch(() => undefined);
        throw error;
      }
    },
    [castingIsActive, castingWorkspace, input.repository, input.voiceProfiles],
  );

  const saveVoicePool = useCallback(
    async (scope: 'system' | 'hosted', voiceProfileIds: readonly string[], userPinned: boolean) => {
      if (busy) return;
      if (!castingWorkspace || !input.repository.saveVoiceCastingWorkspace) {
        input.notify('먼저 해당 provider의 음성 초안을 생성하세요.', 'warning');
        return;
      }
      const provider = scope === 'system' ? input.systemProvider : input.hostedProvider;
      const view = scope === 'system' ? voicePoolViews.system : voicePoolViews.hosted;
      if (!provider || !view) {
        input.notify('현재 활성 음성 배정과 provider가 일치하지 않습니다.', 'warning');
        return;
      }
      const available = new Set(view.options.map((option) => option.profile.id));
      const selected = [...new Set(voiceProfileIds)].filter((profileId) => available.has(profileId));
      if (selected.length === 0) {
        input.notify('공유 음성을 하나 이상 선택하세요.', 'warning');
        return;
      }
      setBusy(true);
      try {
        const workspace = replaceVoiceCastingPool({
          workspace: castingWorkspace,
          providerId: provider.providerId,
          providerModel: provider.modelId,
          voiceProfileIds: selected,
          voiceProfiles: input.voiceProfiles,
          userPinned,
        });
        await input.repository.saveVoiceCastingWorkspace({
          workspace,
          expectedStorageRevision: castingWorkspace.storageRevision,
        });
        setCastingWorkspace(workspace);
        input.notify(
          userPinned ? '공유 음성 풀을 저장했습니다.' : '공유 음성 풀을 자동 구성으로 되돌렸습니다.',
          'success',
        );
      } catch (error) {
        input.notify(error instanceof Error ? error.message : '공유 음성 풀을 저장하지 못했습니다.', 'danger');
      } finally {
        setBusy(false);
      }
    },
    [busy, castingWorkspace, input, voicePoolViews.hosted, voicePoolViews.system],
  );

  return {
    state,
    busy,
    sampleBusyProfileId,
    summary,
    castingWorkspace,
    voiceBindings: castingProjection.bindings,
    castingSummary,
    voicePoolViews,
    loadVoiceBindings,
    reconcileUserVoiceProfiles,
    saveVoicePool,
    generateDraft,
    playAndRecordSample,
    decide,
    savePronunciationRule,
    deletePronunciationRule,
    setMinorFallbackEnabled,
    setMajorCharacterLimit,
  } as const;
}
