import { persistentId128 } from '../id-hash-contract';
import { structuredIntegrityHash } from './structured-integrity';

export function workflowSourceFingerprint(parts: readonly string[]): string {
  return structuredIntegrityHash(parts);
}

export function bookAIBundleId(input: {
  novelId: string;
  startChapterIndex: number;
  endChapterIndex: number;
  sourceFingerprint: string;
}): string {
  return persistentId128('book_ai_bundle', [
    input.novelId,
    String(input.startChapterIndex),
    String(input.endChapterIndex),
    input.sourceFingerprint,
  ]);
}

export function bookAILabelWindowId(input: {
  novelId: string;
  chapterId: string;
  startParagraphIndex: number | 'chapter';
  endParagraphIndex: number | 'chapter';
  sourceFingerprint: string;
}): string {
  return persistentId128('book_ai_label_window', [
    input.novelId,
    input.chapterId,
    String(input.startParagraphIndex),
    String(input.endParagraphIndex),
    input.sourceFingerprint,
  ]);
}

export function bookAIWorkflowPlanIntegrityHash(plan: unknown): string {
  return structuredIntegrityHash(plan);
}

export function bookAIWorkflowId(input: {
  userId: string;
  novelId: string;
  providerId: string;
  modelId?: string;
  planHash: string;
  startedAt: string;
}): string {
  return persistentId128('book_ai_workflow', [
    input.userId,
    input.novelId,
    input.providerId,
    input.modelId ?? '',
    input.planHash,
    input.startedAt,
  ]);
}

export function bookAIWorkflowJobId(workflowId: string, stage: string, planItemId: string): string {
  return persistentId128('book_ai_workflow_job', [workflowId, stage, planItemId]);
}
