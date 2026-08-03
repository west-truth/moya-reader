import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Chapter, Character, Paragraph } from '../../../domain/types';
import type { ChapterLabelAnalysisReviewArtifact } from '../../../providers/analysis-review';
import type { CharacterGraph } from '../../../providers/ai';
import { validateChapterLabelingQuality } from '../../../providers/chapter-labeling-quality';
import { resolveChapterLabelingRequestProfile } from '../../../providers/chapter-labeling-request-profile';
import { validateChapterLabelingResult } from '../../../providers/chapter-labeling-validator';
import type { LabelingContextHaloParagraph } from '../../../providers/labeling-context-packet';
import type {
  NativeAnalysisStagedOutput,
  NativeAnalysisWorkflowDescriptor,
} from '../../../storage/native-analysis-workflow';
import type { NativeBookWorkflowView } from './contracts';

function reviewStatus(artifact: NativeAnalysisStagedOutput): ChapterLabelAnalysisReviewArtifact['status'] {
  if (artifact.status === 'promoted') return 'promoted';
  if (artifact.status === 'stale') return 'obsolete';
  if (artifact.status === 'quarantined') return 'obsolete';
  if (artifact.reviewStatus) return artifact.reviewStatus;
  return 'open';
}

function haloParagraphs(all: readonly Paragraph[], targetIds: ReadonlySet<string>): LabelingContextHaloParagraph[] {
  const indexes = all.flatMap((paragraph, index) => (targetIds.has(paragraph.id) ? [index] : []));
  if (indexes.length === 0) return [];
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  return [
    ...(first > 0 ? [{ paragraph: all[first - 1]!, side: 'before' as const }] : []),
    ...(last + 1 < all.length ? [{ paragraph: all[last + 1]!, side: 'after' as const }] : []),
  ].map(({ paragraph, side }) => ({
    paragraphId: paragraph.id,
    index: paragraph.index,
    side,
    text: paragraph.text,
    textHash: paragraph.textHash,
  }));
}

function characterOptions(characters: readonly Character[], candidateCharacters: readonly Character[]) {
  return [...new Map([...characters, ...candidateCharacters].map((character) => [character.id, character])).values()]
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'ko'))
    .map((character) => ({
      id: character.id,
      canonicalName: character.canonicalName,
      aliases: [...character.aliases],
    }));
}

export function buildNativeAnalysisReviewArtifact(input: {
  readonly artifact: NativeAnalysisStagedOutput;
  readonly descriptor: NativeAnalysisWorkflowDescriptor;
  readonly workflow: NativeBookWorkflowView;
  readonly chapter: Chapter;
  readonly chapterParagraphs: readonly Paragraph[];
  readonly graph: CharacterGraph;
}): ChapterLabelAnalysisReviewArtifact {
  const { artifact } = input;
  if (artifact.payload.kind !== 'label_window' || !artifact.payload.result || !artifact.chapterId) {
    throw new Error(`Native analysis artifact is not reviewable: ${artifact.id}`);
  }
  const targetIds = new Set(artifact.plannedParagraphIds);
  const paragraphs = input.chapterParagraphs.filter((paragraph) => targetIds.has(paragraph.id));
  const candidate = artifact.reviewDraft ?? artifact.payload.result;
  const validation = validateChapterLabelingResult({
    novelId: artifact.novelId,
    chapter: input.chapter,
    paragraphs,
    knownCharacters: [...input.graph.characters],
    characterGraph: input.graph,
    validationPolicy: resolveChapterLabelingRequestProfile(input.descriptor.provider.providerOptions).validationPolicy,
    result: candidate,
  });
  const quality = validateChapterLabelingQuality({ chapter: input.chapter, paragraphs, result: candidate });
  const checkpoint = input.workflow.checkpoints.find((item) => item.jobId === artifact.jobId);
  const originalCandidate = artifact.payload.result;
  const status = reviewStatus(artifact);
  const updatedAt = artifact.reviewUpdatedAt ?? artifact.promotedAt ?? artifact.createdAt;
  return {
    id: artifact.id,
    workflowId: artifact.workflowId,
    providerJobId: artifact.jobId,
    inputRevisionId: checkpoint?.requestHash ?? artifact.expectedContentRevisionId,
    stagingArtifactId: artifact.id,
    reviewKind: 'chapter_labeling',
    windowId: artifact.jobId,
    chapterId: artifact.chapterId,
    chapter: input.chapter,
    paragraphs,
    haloParagraphs: haloParagraphs(input.chapterParagraphs, targetIds),
    characterOptions: characterOptions(input.graph.characters, candidate.characters),
    candidate,
    candidateHash: structuredIntegrityHash(candidate),
    originalCandidate,
    originalCandidateHash: structuredIntegrityHash(originalCandidate),
    editIntents: artifact.reviewEditIntents ?? {},
    validationIssues: validation.issues,
    qualityIssues: quality.issues,
    validationSummary: validation.summary,
    qualitySummary: quality.summary,
    providerExecution: checkpoint?.providerExecution,
    status,
    reviewRevision: artifact.reviewRevision ?? 1,
    contentRevisionId: artifact.expectedContentRevisionId,
    revisionFence: artifact.workflowFence,
    graphRevisionId: artifact.expectedGraphFingerprint,
    graphFingerprint: artifact.expectedGraphFingerprint,
    correctionFingerprint: artifact.correctionFingerprint,
    promotedArtifactId: status === 'promoted' ? artifact.id : undefined,
    createdAt: artifact.createdAt,
    updatedAt,
    promotedAt: artifact.promotedAt,
  };
}
