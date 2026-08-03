import {
  normalizeApplyLabelCorrectionsCommandV2,
  type ApplyLabelCorrectionsCommandV2,
  type LabelMutationIntent,
  type LabelMutationPatch,
} from '../../../../../src/providers/label-mutation-contract';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function intentValue(value: unknown): LabelMutationIntent {
  const body = record(value, 'edit.intent');
  const kind = stringValue(body.kind, 'edit.intent.kind');
  if (kind === 'segment_only') return { kind };
  if (kind === 'relabel_from_window') {
    return { kind, windowId: stringValue(body.windowId, 'edit.intent.windowId') };
  }
  if (kind === 'reference_mapping') {
    const rule = record(body.rule, 'edit.intent.rule');
    return {
      kind,
      rule: {
        surface: stringValue(rule.surface, 'edit.intent.rule.surface'),
        characterId: stringValue(rule.characterId, 'edit.intent.rule.characterId'),
        fromChapterIndex: Number(rule.fromChapterIndex),
        toChapterIndex: rule.toChapterIndex === undefined ? undefined : Number(rule.toChapterIndex),
      },
    };
  }
  throw new Error('edit.intent.kind is invalid');
}

function patchValue(value: unknown): LabelMutationPatch {
  const body = record(value, 'edit.patch');
  const prosody = body.prosodyIntent;
  const prosodyIntent =
    prosody === undefined || prosody === null
      ? prosody
      : (() => {
          const item = record(prosody, 'edit.patch.prosodyIntent');
          return {
            pace: item.pace === undefined ? undefined : stringValue(item.pace, 'prosody pace'),
            intensity: item.intensity === undefined ? undefined : stringValue(item.intensity, 'prosody intensity'),
            delivery: item.delivery === undefined ? undefined : stringValue(item.delivery, 'prosody delivery'),
          };
        })();
  return {
    segmentType:
      body.segmentType === undefined
        ? undefined
        : (stringValue(body.segmentType, 'edit.patch.segmentType') as LabelMutationPatch['segmentType']),
    speakerId: body.speakerId === undefined ? undefined : stringValue(body.speakerId, 'edit.patch.speakerId'),
    listenerIds: optionalStringArray(body.listenerIds, 'edit.patch.listenerIds'),
    emotion: body.emotion === undefined ? undefined : stringValue(body.emotion, 'edit.patch.emotion'),
    prosodyIntent,
  };
}

export function parseApplyLabelCorrectionsCommandV2(value: unknown): ApplyLabelCorrectionsCommandV2 {
  const body = record(value, 'label mutation command');
  const expected = record(body.expected, 'label mutation expected fences');
  if (!Array.isArray(body.edits)) throw new Error('label mutation edits must be an array');
  return normalizeApplyLabelCorrectionsCommandV2({
    operationId: stringValue(body.operationId, 'operationId'),
    bookId: stringValue(body.bookId, 'bookId'),
    chapterId: stringValue(body.chapterId, 'chapterId'),
    createdAt: stringValue(body.createdAt, 'createdAt'),
    expected: {
      contentRevisionId: stringValue(expected.contentRevisionId, 'expected.contentRevisionId'),
      chapterTextHash:
        expected.chapterTextHash === undefined
          ? undefined
          : stringValue(expected.chapterTextHash, 'expected.chapterTextHash'),
      graphRevisionId:
        expected.graphRevisionId === undefined
          ? undefined
          : stringValue(expected.graphRevisionId, 'expected.graphRevisionId'),
      graphFingerprint:
        expected.graphFingerprint === undefined
          ? undefined
          : stringValue(expected.graphFingerprint, 'expected.graphFingerprint'),
      correctionRevisionId: stringValue(expected.correctionRevisionId, 'expected.correctionRevisionId'),
      segmentCollectionRevision: stringValue(expected.segmentCollectionRevision, 'expected.segmentCollectionRevision'),
      contextRevisionId:
        expected.contextRevisionId === undefined
          ? undefined
          : stringValue(expected.contextRevisionId, 'expected.contextRevisionId'),
      workflowGeneration: expected.workflowGeneration === undefined ? undefined : Number(expected.workflowGeneration),
    },
    edits: body.edits.map((item) => {
      const edit = record(item, 'label mutation edit');
      return {
        segmentId: stringValue(edit.segmentId, 'edit.segmentId'),
        expectedSegmentHash: stringValue(edit.expectedSegmentHash, 'edit.expectedSegmentHash'),
        patch: patchValue(edit.patch),
        intent: intentValue(edit.intent),
      };
    }),
    sourceReviewArtifactId:
      body.sourceReviewArtifactId === undefined
        ? undefined
        : stringValue(body.sourceReviewArtifactId, 'sourceReviewArtifactId'),
  });
}
