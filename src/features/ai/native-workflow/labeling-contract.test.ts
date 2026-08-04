import { describe, expect, it } from 'vitest';
import {
  NATIVE_LABELING_CONTRACT_VERSION,
  type NativeLabelingContract,
} from '../../../storage/native-analysis-workflow';
import {
  assertNativeLabelingContractExecutable,
  pinnedRichLabelingProviderOptions,
  resolveNativeLabelingContract,
} from './labeling-contract';

const richContract: NativeLabelingContract = {
  version: NATIVE_LABELING_CONTRACT_VERSION,
  kind: 'rich_chapter_labeling_v2',
  requestProfileId: 'chapter-labeling-v2-strict-tts',
  promptVersion: 'chapter-labeler-v2-context-packet',
  schemaVersion: 'chapter-labeling-v2',
};

describe('native labeling contract pinning', () => {
  it('pins a rich profile independently from later mutable compact flags', () => {
    expect(
      pinnedRichLabelingProviderOptions(
        {
          requestProfileId: 'speaker-attribution-v3-compact',
          compactSpeakerAttributionV3: true,
          temperature: 0.1,
        },
        richContract,
      ),
    ).toEqual({ requestProfileId: 'chapter-labeling-v2-strict-tts', temperature: 0.1 });
  });

  it('resolves compact once and admits it through the native batch execution boundary', () => {
    const contract = resolveNativeLabelingContract({ requestProfileId: 'speaker-attribution-v3-compact' });
    expect(contract).toMatchObject({
      kind: 'speaker_attribution_v3',
      workflowContractVersion: 'speaker-attribution-workflow-v3',
      schemaVersion: 'speaker-wire-v2',
    });
    expect(() => assertNativeLabelingContractExecutable(contract)).not.toThrow();
    expect(() => pinnedRichLabelingProviderOptions({}, contract)).toThrow(/cannot be materialized/i);
  });
});
