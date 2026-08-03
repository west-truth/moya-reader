import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { CandidateSelectionDecisionV1 } from './candidate-selector';

export interface CandidateSelectionReportV1 {
  readonly version: 'candidate-selection-report-v2';
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly candidateMemoryHash: string;
  readonly decisions: readonly CandidateSelectionDecisionV1[];
  readonly targetCount: number;
  readonly splitRequiredCount: number;
  readonly candidateMissingCount: number;
  readonly candidateInsufficientCount: number;
  readonly newFromMentionCount: number;
  readonly fingerprint: string;
}

export function buildCandidateSelectionReport(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly candidateMemoryHash: string;
  readonly decisions: readonly CandidateSelectionDecisionV1[];
}): CandidateSelectionReportV1 {
  const core = {
    version: 'candidate-selection-report-v2' as const,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    sceneId: input.sceneId,
    candidateMemoryHash: input.candidateMemoryHash,
    decisions: input.decisions,
    targetCount: input.decisions.length,
    splitRequiredCount: input.decisions.filter((decision) => decision.requiresWindowSplit).length,
    candidateMissingCount: input.decisions.filter((decision) => decision.issueCodes.includes('candidate_missing'))
      .length,
    candidateInsufficientCount: input.decisions.filter((decision) => decision.candidateSufficiency === 'insufficient')
      .length,
    newFromMentionCount: input.decisions.filter((decision) => decision.newFromMentionOrdinals.length > 0).length,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('candidate_selection_report', [input.contentRevisionId, input.sceneId, fingerprint]),
    fingerprint,
  };
}
