import { describe, expect, it } from 'vitest';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { segmentTextIntegrityHash } from '../domain/identity/ai-identities';
import type { LabeledSegment, Paragraph } from '../domain/types';
import type { RepairChapterLabelsInput } from '../providers/ai';
import {
  applyLabelRepairPatchV2,
  chapterLabelRepairIssueId,
  chapterLabelSegmentAnchorHash,
  parseLabelRepairPatchV2,
  type LabelRepairPatchV2,
} from '../providers/chapter-label-repair-v2-contract';
import {
  buildChapterLabelRepairRequest,
  DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
  LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
  resolveChapterLabelRepairRequestProfile,
} from '../providers/chapter-label-repair-request-profile';

const paragraphs: Paragraph[] = [
  {
    id: 'p1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 0,
    text: '안녕!!',
    startOffsetInChapter: 0,
    endOffsetInChapter: 4,
    textHash: 'p1_hash',
  },
  {
    id: 'p2',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 1,
    text: '밖은 조용했다.',
    startOffsetInChapter: 5,
    endOffsetInChapter: 12,
    textHash: 'p2_hash',
  },
];

function segment(
  id: string,
  paragraphId: string,
  startOffset: number,
  endOffset: number,
  text: string,
  patch: Partial<LabeledSegment> = {},
): LabeledSegment {
  return {
    id,
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId,
    segmentIndex: 0,
    startOffset,
    endOffset,
    segmentTextHash: segmentTextIntegrityHash(text.slice(startOffset, endOffset)),
    type: 'quoted_dialogue',
    speakerId: 'unknown',
    candidateSpeakers: ['char_a'],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.4,
    evidence: 'ambiguous',
    isUserCorrected: false,
    ...patch,
  };
}

function repairInput(): RepairChapterLabelsInput {
  const issue = {
    severity: 'error' as const,
    code: 'unknown_speaker',
    message: 'speaker must be repaired',
    segmentId: 's1',
    paragraphId: 'p1',
  };
  const existingResult = {
    characters: [],
    segments: [
      segment('s1', 'p1', 0, 4, paragraphs[0].text, { segmentIndex: 1 }),
      segment('s2', 'p2', 0, 7, paragraphs[1].text, {
        segmentIndex: 2,
        type: 'narration',
        speakerId: 'narrator',
        confidence: 1,
      }),
      segment('s_user', 'p1', 0, 2, paragraphs[0].text, {
        segmentIndex: 0,
        speakerId: 'char_user',
        confidence: 1,
        isUserCorrected: true,
      }),
    ],
    episodeContextSummary: {
      chapterId: 'chapter_1',
      scene: '복도',
      activeCharacterIds: ['char_a'],
      unresolved: [],
    },
  };
  return {
    novelId: 'book_1',
    windowId: 'window_1',
    chapter: {
      id: 'chapter_1',
      novelId: 'book_1',
      index: 1,
      title: '1화',
      normalizedText: '',
      textHash: 'chapter_hash',
      rawStartOffset: 0,
      rawEndOffset: 12,
      characterCount: 12,
      paragraphCount: 2,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    paragraphs,
    existingResult,
    validationIssues: [issue],
    baseArtifactId: 'artifact_1',
    baseArtifactHash: structuredIntegrityHash(existingResult),
    issueIds: [chapterLabelRepairIssueId(issue)],
  };
}

function replacementPatch(input: RepairChapterLabelsInput): LabelRepairPatchV2 {
  const existing = input.existingResult.segments.find((item) => item.id === 's1')!;
  return {
    schemaVersion: 'chapter-label-repair-patch-v2',
    baseArtifactId: input.baseArtifactId!,
    baseArtifactHash: input.baseArtifactHash!,
    issueIds: [...input.issueIds!],
    operations: [
      {
        op: 'replace_segment',
        segmentId: existing.id,
        expectedAnchorHash: chapterLabelSegmentAnchorHash(existing),
        value: {
          start_offset: 0,
          end_offset: 4,
          type: 'quoted_dialogue',
          speaker_id: 'char_a',
          candidate_speakers: [],
          listener_ids: [],
          emotion: 'excited',
          prosody_intent: { pace: 'fast', intensity: 'high', delivery: 'shout' },
          confidence: 0.95,
          evidence_codes: ['explicit_exclamation', 'turn_continuity'],
        },
      },
    ],
  };
}

describe('LabelRepairPatchV2', () => {
  it('applies the scoped replacement while preserving unrelated and user-corrected segments', () => {
    const input = repairInput();
    const beforeOutside = structuredClone(input.existingResult.segments.find((item) => item.id === 's2'));
    const beforeUser = structuredClone(input.existingResult.segments.find((item) => item.id === 's_user'));
    const result = applyLabelRepairPatchV2(input, replacementPatch(input));

    expect(result.segments.find((item) => item.id === 's1')).toMatchObject({
      speakerId: 'char_a',
      emotion: 'excited',
      confidence: 0.95,
    });
    expect(result.segments.find((item) => item.id === 's2')).toEqual(beforeOutside);
    expect(result.segments.find((item) => item.id === 's_user')).toEqual(beforeUser);
    expect(result.segmentAnnotations?.s1).toEqual({
      evidenceCodes: ['explicit_exclamation', 'turn_continuity'],
      prosodyIntent: { pace: 'fast', intensity: 'high', delivery: 'shout' },
    });
  });

  it('rejects stale anchors, wrong issue sets, out-of-scope edits, and user-corrected edits', () => {
    const input = repairInput();
    const baseOperation = replacementPatch(input).operations[0];
    if (baseOperation.op !== 'replace_segment') throw new Error('test expected replace_segment');
    const stale: LabelRepairPatchV2 = {
      ...replacementPatch(input),
      operations: [{ ...baseOperation, expectedAnchorHash: 'stale' }],
    };
    expect(() => applyLabelRepairPatchV2(input, stale)).toThrow('anchor hash is stale');

    const wrongIssues = { ...replacementPatch(input), issueIds: ['other_issue'] };
    expect(() => applyLabelRepairPatchV2(input, wrongIssues)).toThrow('issue ids do not match');

    const outside = input.existingResult.segments.find((item) => item.id === 's2')!;
    const outsidePatch: LabelRepairPatchV2 = {
      ...replacementPatch(input),
      operations: [
        {
          ...baseOperation,
          segmentId: outside.id,
          expectedAnchorHash: chapterLabelSegmentAnchorHash(outside),
        },
      ],
    };
    expect(() => applyLabelRepairPatchV2(input, outsidePatch)).toThrow('outside issue scope');

    const corrected = input.existingResult.segments.find((item) => item.id === 's_user')!;
    const correctedInput = {
      ...input,
      validationIssues: [{ ...input.validationIssues[0], segmentId: corrected.id }],
    };
    correctedInput.issueIds = correctedInput.validationIssues.map(chapterLabelRepairIssueId);
    const correctedPatch: LabelRepairPatchV2 = {
      ...replacementPatch(correctedInput),
      issueIds: [...correctedInput.issueIds],
      operations: [
        {
          ...baseOperation,
          segmentId: corrected.id,
          expectedAnchorHash: chapterLabelSegmentAnchorHash(corrected),
        },
      ],
    };
    expect(() => applyLabelRepairPatchV2(correctedInput, correctedPatch)).toThrow('user-corrected');

    const contextPatch: LabelRepairPatchV2 = {
      ...replacementPatch(input),
      operations: [
        {
          op: 'patch_context_delta',
          expectedContextHash: structuredIntegrityHash(input.existingResult.episodeContextSummary ?? null),
          value: {
            scene: '무관한 변경',
            activeCharacterIds: [],
            unresolved: [],
          },
        },
      ],
    };
    expect(() => applyLabelRepairPatchV2(input, contextPatch)).toThrow('context outside issue scope');
  });

  it('parses the provider patch wire contract', () => {
    const input = repairInput();
    const patch = replacementPatch(input);
    const operation = patch.operations[0];
    expect(operation.op).toBe('replace_segment');
    const parsed = parseLabelRepairPatchV2({
      schema_version: patch.schemaVersion,
      base_artifact_id: patch.baseArtifactId,
      base_artifact_hash: patch.baseArtifactHash,
      issue_ids: patch.issueIds,
      operations: [
        {
          op: 'replace_segment',
          segment_id: operation.op === 'replace_segment' ? operation.segmentId : '',
          expected_anchor_hash: operation.op === 'replace_segment' ? operation.expectedAnchorHash : '',
          value: operation.op === 'replace_segment' ? operation.value : undefined,
        },
      ],
    });
    expect(parsed).toEqual(patch);
  });

  it('builds a bounded v2 prompt by default and retains explicit v1 compatibility', () => {
    const input = repairInput();
    const request = buildChapterLabelRepairRequest(input, undefined);

    expect(request.profile.id).toBe(DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID);
    expect(request.profile.schemaVersion).toBe('chapter-label-repair-patch-v2');
    expect(request.prompt).toContain('Return LabelRepairPatchV2 JSON only');
    expect(request.prompt).toContain('"paragraph_id":"p1"');
    expect(request.prompt).not.toContain('밖은 조용했다.');
    expect(
      resolveChapterLabelRepairRequestProfile({
        repairRequestProfileId: LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
      }).id,
    ).toBe('chapter-label-repair-v1');
  });
});
