import { providerOptionsIntegrityHash } from '@noveldesk/text-core/identity/provider';
import type { CharacterGraph } from '../../../../../src/providers/ai';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import type {
  ProviderJobStatus,
  TTSReadinessReport,
  WorkflowProviderJobLinkRow,
  WorkflowReviewTarget,
} from './workflow-contracts.js';

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export function providerOptionsFromProgress(progress: unknown): Record<string, unknown> {
  return recordValue(recordValue(progress)?.providerOptions) ?? {};
}

export function isoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

export function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function providerOptionsHash(providerOptions: Record<string, unknown>): string {
  return providerOptionsIntegrityHash(providerOptions);
}

export function sortedStageLinks(links: readonly WorkflowProviderJobLinkRow[]): WorkflowProviderJobLinkRow[] {
  return [...links].sort(
    (left, right) => left.sequence - right.sequence || left.provider_job_id.localeCompare(right.provider_job_id),
  );
}

const MANUAL_REVIEW_COMPLETION_STATUSES = new Set(['promoted', 'superseded']);

function manualReviewStatus(link: WorkflowProviderJobLinkRow): string | undefined {
  const status = recordValue(recordValue(link.progress)?.manualReview)?.status;
  return typeof status === 'string' && status.length > 0 ? status : undefined;
}

export function linkHasUnresolvedManualReview(link: WorkflowProviderJobLinkRow): boolean {
  const status = manualReviewStatus(link);
  return status !== undefined && !MANUAL_REVIEW_COMPLETION_STATUSES.has(status);
}

export function hasUnresolvedManualReview(links: readonly WorkflowProviderJobLinkRow[]): boolean {
  return links.some(linkHasUnresolvedManualReview);
}

export function terminalFailure(links: readonly WorkflowProviderJobLinkRow[]): WorkflowProviderJobLinkRow | undefined {
  return links.find(
    (link) =>
      (link.status === 'failed' || link.status === 'cancelled') &&
      !MANUAL_REVIEW_COMPLETION_STATUSES.has(manualReviewStatus(link) ?? ''),
  );
}

export function pendingLinks(links: readonly WorkflowProviderJobLinkRow[]): WorkflowProviderJobLinkRow[] {
  return links.filter((link) => link.status === 'queued' || link.status === 'running');
}

export function succeededLinks(links: readonly WorkflowProviderJobLinkRow[]): WorkflowProviderJobLinkRow[] {
  return links.filter((link) => {
    if (linkHasUnresolvedManualReview(link)) return false;
    const reviewStatus = manualReviewStatus(link);
    return link.status === 'succeeded' || reviewStatus === 'promoted';
  });
}

export function labelingWindowIdsForMissingParagraphs(progress: unknown, plan: BookAIWorkflowPlan): Set<string> {
  const ttsReadiness = recordValue(recordValue(progress)?.ttsReadiness);
  const missingParagraphIds = new Set(stringArrayValue(ttsReadiness?.missingPlannedParagraphIds));
  if (missingParagraphIds.size === 0) return new Set();
  return new Set(
    plan.labelingWindows
      .filter((window) => window.paragraphIds.some((paragraphId) => missingParagraphIds.has(paragraphId)))
      .map((window) => window.id),
  );
}

export function reviewTargetForFailedLink(link: WorkflowProviderJobLinkRow): WorkflowReviewTarget {
  const sourceContext = recordValue(recordValue(link.progress)?.sourceContext);
  const paragraphIds = stringArrayValue(sourceContext?.paragraphIds);
  const chapterId = typeof sourceContext?.chapterId === 'string' ? sourceContext.chapterId : undefined;
  return {
    id: `failed_child_job:${link.provider_job_id}`,
    kind: 'failed_child_job',
    stage: link.stage,
    planItemId: link.plan_item_id,
    providerJobId: link.provider_job_id,
    providerJobStatus: link.status,
    jobType: link.job_type,
    chapterId,
    paragraphIds,
    errorCode: link.error_code ?? undefined,
    message: link.error_message ?? undefined,
    recommendedAction:
      link.job_type === 'chapter_label_repair'
        ? 'retry_same_request'
        : link.stage === 'chapter_labeling'
          ? 'inspect_failed_job'
          : 'retry_workflow',
    repairMode: link.job_type === 'chapter_label_repair' ? 'pinned_candidate_repair' : undefined,
  };
}

export function reviewTargetsForTTSReadiness(
  plan: BookAIWorkflowPlan,
  readiness: TTSReadinessReport,
): WorkflowReviewTarget[] {
  const targets: WorkflowReviewTarget[] = [];
  if (readiness.missingPlannedParagraphIds.length > 0) {
    const missingParagraphIds = new Set(readiness.missingPlannedParagraphIds);
    const windows = plan.labelingWindows.filter((window) =>
      window.paragraphIds.some((paragraphId) => missingParagraphIds.has(paragraphId)),
    );
    targets.push({
      id: 'tts_readiness:missing_paragraph_labels',
      kind: 'missing_paragraph_labels',
      stage: 'chapter_labeling',
      labelingWindowIds: windows.map((window) => window.id),
      paragraphIds: readiness.missingPlannedParagraphIds,
      errorCode: readiness.errorCode,
      message: readiness.message,
      recommendedAction: 'retry_labeling_windows',
      repairMode: 'auto_repair_on_validation_failure',
    });
  }
  if (readiness.missingCharacterVoiceSpeakerIds.length > 0) {
    targets.push({
      id: 'tts_readiness:missing_voice_profiles',
      kind: 'missing_voice_profiles',
      stage: 'voice_profile_assignment',
      speakerIds: readiness.missingCharacterVoiceSpeakerIds,
      errorCode: readiness.errorCode,
      message: readiness.message,
      recommendedAction: 'assign_voice_profiles',
    });
  }
  if (readiness.metrics.unknownSegmentRatio > 0.25) {
    targets.push({
      id: 'tts_readiness:high_unknown_speaker_ratio',
      kind: 'high_unknown_speaker_ratio',
      stage: 'chapter_labeling',
      errorCode: readiness.errorCode,
      message: readiness.message,
      recommendedAction: 'review_labels',
    });
  }
  if (targets.length === 0) {
    targets.push({
      id: 'tts_readiness:failed',
      kind: 'tts_readiness_failed',
      stage: 'tts_ready_verification',
      errorCode: readiness.errorCode,
      message: readiness.message,
      recommendedAction: 'retry_workflow',
    });
  }
  return targets;
}

export function dedupeLinksByProviderJobId(links: readonly WorkflowProviderJobLinkRow[]): WorkflowProviderJobLinkRow[] {
  const seen = new Set<string>();
  const result: WorkflowProviderJobLinkRow[] = [];
  for (const link of links) {
    if (seen.has(link.provider_job_id)) continue;
    seen.add(link.provider_job_id);
    result.push(link);
  }
  return result;
}

export function mergeDiscoveredGraphs(bookId: string, links: readonly WorkflowProviderJobLinkRow[]): CharacterGraph {
  const characters = new Map<string, CharacterGraph['characters'][number]>();
  const relations = new Map<string, CharacterGraph['relations'][number]>();
  for (const link of links) {
    const graph = normalizeCharacterGraphSnapshot(recordValue(link.progress)?.discoveredGraph, bookId);
    for (const character of graph.characters) characters.set(character.id, character);
    for (const relation of graph.relations) relations.set(relation.id, relation);
  }
  return { novelId: bookId, characters: [...characters.values()], relations: [...relations.values()] };
}

export function providerJobIsTerminal(job: { readonly status: ProviderJobStatus }): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
}
