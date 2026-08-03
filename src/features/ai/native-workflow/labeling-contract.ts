import {
  DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  resolveChapterLabelingRequestProfile,
} from '../../../providers/chapter-labeling-request-profile';
import {
  SPEAKER_ATTRIBUTION_PROMPT_VERSION,
  SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
  SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
} from '../../../providers/speaker-attribution/contracts';
import {
  NATIVE_LABELING_CONTRACT_VERSION,
  NATIVE_SPEAKER_WORKFLOW_CONTRACT_VERSION,
  nativeLabelingContractFingerprint,
  type NativeLabelingContract,
  type NativeRichChapterLabelingContractV2,
} from '../../../storage/native-analysis-workflow';

function profileSelector(providerOptions: Readonly<Record<string, unknown>>): string | undefined {
  const selected =
    providerOptions.requestProfileId ??
    providerOptions.labelingProfileId ??
    providerOptions.promptProfileId ??
    providerOptions.promptVersion;
  if (typeof selected !== 'string' || !selected.trim() || selected.trim() === 'default') return undefined;
  return selected.trim();
}

export function resolveNativeLabelingContract(
  providerOptions: Readonly<Record<string, unknown>> = {},
): NativeLabelingContract {
  const selectedProfile = profileSelector(providerOptions);
  if (
    providerOptions.compactSpeakerAttributionV3 === true ||
    selectedProfile === SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID
  ) {
    return {
      version: NATIVE_LABELING_CONTRACT_VERSION,
      kind: 'speaker_attribution_v3',
      workflowContractVersion: NATIVE_SPEAKER_WORKFLOW_CONTRACT_VERSION,
      requestProfileId: SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
      promptVersion: SPEAKER_ATTRIBUTION_PROMPT_VERSION,
      schemaVersion: SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
    };
  }
  const profile = resolveChapterLabelingRequestProfile({
    ...providerOptions,
    requestProfileId: selectedProfile ?? DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  });
  return {
    version: NATIVE_LABELING_CONTRACT_VERSION,
    kind: 'rich_chapter_labeling_v2',
    requestProfileId: profile.id,
    promptVersion: profile.promptVersion,
    schemaVersion: profile.schemaVersion,
  };
}

export function assertNativeLabelingContractExecutable(contract: NativeLabelingContract | undefined): void {
  if (!contract) return;
  if (contract.version !== NATIVE_LABELING_CONTRACT_VERSION) {
    throw new Error(`Unsupported native labeling contract version: ${String(contract.version)}`);
  }
}

export function pinnedRichLabelingProviderOptions(
  providerOptions: Readonly<Record<string, unknown>>,
  contract: NativeLabelingContract | undefined,
): Record<string, unknown> {
  if (!contract) return { ...providerOptions };
  assertNativeLabelingContractExecutable(contract);
  if (contract.kind !== 'rich_chapter_labeling_v2') {
    throw new Error('Compact speaker attribution cannot be materialized by the native rich labeling request builder');
  }
  const richContract = contract as NativeRichChapterLabelingContractV2;
  const pinned: Record<string, unknown> = {
    ...providerOptions,
    requestProfileId: richContract.requestProfileId,
  };
  delete pinned.compactSpeakerAttributionV3;
  const profile = resolveChapterLabelingRequestProfile(pinned);
  if (
    profile.promptVersion !== richContract.promptVersion ||
    profile.schemaVersion !== richContract.schemaVersion ||
    nativeLabelingContractFingerprint({
      version: NATIVE_LABELING_CONTRACT_VERSION,
      kind: 'rich_chapter_labeling_v2',
      requestProfileId: profile.id,
      promptVersion: profile.promptVersion,
      schemaVersion: profile.schemaVersion,
    }) !== nativeLabelingContractFingerprint(richContract)
  ) {
    throw new Error('Pinned native rich labeling contract no longer matches the request profile implementation');
  }
  return pinned;
}
