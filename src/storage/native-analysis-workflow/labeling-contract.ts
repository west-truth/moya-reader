import { structuredIntegrityHash } from '../../domain/identity/structured-integrity';
import {
  SPEAKER_ATTRIBUTION_PROMPT_VERSION,
  SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
  SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
} from '../../providers/speaker-attribution/contracts';

export const NATIVE_LABELING_CONTRACT_VERSION = 'native-labeling-contract-v1' as const;
export const NATIVE_SPEAKER_WORKFLOW_CONTRACT_VERSION = 'speaker-attribution-workflow-v3' as const;

export interface NativeRichChapterLabelingContractV2 {
  readonly version: typeof NATIVE_LABELING_CONTRACT_VERSION;
  readonly kind: 'rich_chapter_labeling_v2';
  readonly requestProfileId: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
}

export interface NativeCompactSpeakerLabelingContractV3 {
  readonly version: typeof NATIVE_LABELING_CONTRACT_VERSION;
  readonly kind: 'speaker_attribution_v3';
  readonly workflowContractVersion: typeof NATIVE_SPEAKER_WORKFLOW_CONTRACT_VERSION;
  readonly requestProfileId: typeof SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID;
  readonly promptVersion: typeof SPEAKER_ATTRIBUTION_PROMPT_VERSION;
  readonly schemaVersion: typeof SPEAKER_ATTRIBUTION_SCHEMA_VERSION;
}

export type NativeLabelingContract = NativeRichChapterLabelingContractV2 | NativeCompactSpeakerLabelingContractV3;

function requiredContractValue(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertContractKeys(contract: NativeLabelingContract, expected: readonly string[]): void {
  const actual = Object.keys(contract).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error('native labeling contract contains unsupported fields');
  }
}

export function normalizeNativeLabelingContract(contract: NativeLabelingContract): NativeLabelingContract {
  if (!contract || contract.version !== NATIVE_LABELING_CONTRACT_VERSION) {
    throw new Error('native labeling contract version is unsupported');
  }
  if (contract.kind === 'speaker_attribution_v3') {
    assertContractKeys(contract, [
      'version',
      'kind',
      'workflowContractVersion',
      'requestProfileId',
      'promptVersion',
      'schemaVersion',
    ]);
    if (
      contract.workflowContractVersion !== NATIVE_SPEAKER_WORKFLOW_CONTRACT_VERSION ||
      contract.requestProfileId !== SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID ||
      contract.promptVersion !== SPEAKER_ATTRIBUTION_PROMPT_VERSION ||
      contract.schemaVersion !== SPEAKER_ATTRIBUTION_SCHEMA_VERSION
    ) {
      throw new Error('native compact speaker labeling contract is invalid');
    }
    return {
      version: NATIVE_LABELING_CONTRACT_VERSION,
      kind: 'speaker_attribution_v3',
      workflowContractVersion: NATIVE_SPEAKER_WORKFLOW_CONTRACT_VERSION,
      requestProfileId: SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID,
      promptVersion: SPEAKER_ATTRIBUTION_PROMPT_VERSION,
      schemaVersion: SPEAKER_ATTRIBUTION_SCHEMA_VERSION,
    };
  }
  if (contract.kind !== 'rich_chapter_labeling_v2') {
    throw new Error('native labeling contract kind is unsupported');
  }
  assertContractKeys(contract, ['version', 'kind', 'requestProfileId', 'promptVersion', 'schemaVersion']);
  return {
    version: NATIVE_LABELING_CONTRACT_VERSION,
    kind: 'rich_chapter_labeling_v2',
    requestProfileId: requiredContractValue(contract.requestProfileId, 'native labeling request profile id'),
    promptVersion: requiredContractValue(contract.promptVersion, 'native labeling prompt version'),
    schemaVersion: requiredContractValue(contract.schemaVersion, 'native labeling schema version'),
  };
}

export function nativeLabelingContractFingerprint(contract: NativeLabelingContract): string {
  return structuredIntegrityHash(normalizeNativeLabelingContract(contract));
}
