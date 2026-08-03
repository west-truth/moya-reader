import type {
  ProviderBillingState,
  ProviderJob,
  ProviderJobStatus,
  ProviderJobType,
  ProviderOutcomeState,
} from '../../../../../src/providers/provider-jobs';
import { normalizeProviderExecutionMetadata } from '../../../../../src/providers/provider-execution';
import { isoString } from './database-row-contract.js';
import { recordBody } from './request-contracts.js';

export interface ProviderJobRow {
  id: string;
  book_id: string;
  chapter_id: string | null;
  job_type: string;
  provider_id: string;
  model_id: string | null;
  input_hash: string;
  status: ProviderJobStatus;
  stage: string;
  progress: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  current_attempt_id?: string | null;
  attempt_generation?: number | string | null;
  outcome_state?: ProviderOutcomeState | null;
  billing_state?: ProviderBillingState | null;
  heartbeat_at?: Date | string | null;
  dispatch_started_at?: Date | string | null;
  reconcile_after?: Date | string | null;
  normalized_completion_code?: string | null;
  normalized_error_code?: string | null;
}

export interface ProviderJobResponse extends ProviderJob {
  readonly stage: string;
  readonly progress: unknown;
}

export function mapProviderJob(row: ProviderJobRow): ProviderJobResponse {
  return {
    id: row.id,
    novelId: row.book_id,
    chapterId: row.chapter_id ?? undefined,
    type: row.job_type as ProviderJobType,
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    inputHash: row.input_hash,
    status: row.status,
    stage: row.stage,
    progress: sanitizeProviderJobProgress(row.progress ?? {}),
    createdAt: isoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoString(row.updated_at) ?? new Date(0).toISOString(),
    startedAt: isoString(row.started_at),
    finishedAt: isoString(row.finished_at),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    attempt:
      row.current_attempt_id && row.outcome_state && row.billing_state
        ? {
            attemptId: row.current_attempt_id,
            generation: Number(row.attempt_generation ?? 0),
            outcomeState: row.outcome_state,
            billingState: row.billing_state,
            heartbeatAt: isoString(row.heartbeat_at),
            dispatchStartedAt: isoString(row.dispatch_started_at),
            reconcileAfter: isoString(row.reconcile_after),
            normalizedCompletionCode: row.normalized_completion_code ?? undefined,
            normalizedErrorCode: row.normalized_error_code ?? undefined,
          }
        : undefined,
  };
}

export function providerJobProgressRecord(value: unknown): Record<string, unknown> {
  const record = recordBody(value);
  return record ? { ...record } : {};
}

export function sanitizeProviderJobProgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProviderJobProgress);
  const record = recordBody(value);
  if (!record) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === 'providerOptions') continue;
    if (key === 'providerExecution' || key === 'initialProviderExecution') {
      const metadata = normalizeProviderExecutionMetadata(item);
      if (metadata) sanitized[key] = metadata;
      continue;
    }
    sanitized[key] = sanitizeProviderJobProgress(item);
  }
  return sanitized;
}

export function providerJobFromJson(value: unknown): ProviderJobResponse | undefined {
  const row = recordBody(value);
  if (!row) return undefined;
  return mapProviderJob({
    id: String(row.id ?? ''),
    book_id: String(row.book_id ?? row.novelId ?? ''),
    chapter_id:
      typeof row.chapter_id === 'string' ? row.chapter_id : typeof row.chapterId === 'string' ? row.chapterId : null,
    job_type: String(row.job_type ?? row.type ?? 'chapter_segment_labeling'),
    provider_id: String(row.provider_id ?? row.providerId ?? ''),
    model_id: typeof row.model_id === 'string' ? row.model_id : typeof row.modelId === 'string' ? row.modelId : null,
    input_hash: String(row.input_hash ?? row.inputHash ?? ''),
    status: String(row.status ?? 'queued') as ProviderJobStatus,
    stage: String(row.stage ?? 'queued'),
    progress: row.progress ?? {},
    error_code:
      typeof row.error_code === 'string' ? row.error_code : typeof row.errorCode === 'string' ? row.errorCode : null,
    error_message:
      typeof row.error_message === 'string'
        ? row.error_message
        : typeof row.errorMessage === 'string'
          ? row.errorMessage
          : null,
    created_at:
      typeof row.created_at === 'string'
        ? row.created_at
        : typeof row.createdAt === 'string'
          ? row.createdAt
          : new Date(0).toISOString(),
    updated_at:
      typeof row.updated_at === 'string'
        ? row.updated_at
        : typeof row.updatedAt === 'string'
          ? row.updatedAt
          : new Date(0).toISOString(),
    started_at:
      typeof row.started_at === 'string' ? row.started_at : typeof row.startedAt === 'string' ? row.startedAt : null,
    finished_at:
      typeof row.finished_at === 'string'
        ? row.finished_at
        : typeof row.finishedAt === 'string'
          ? row.finishedAt
          : null,
    current_attempt_id:
      typeof row.current_attempt_id === 'string'
        ? row.current_attempt_id
        : typeof row.attempt === 'object' && row.attempt && 'attemptId' in row.attempt
          ? String(row.attempt.attemptId)
          : null,
    attempt_generation:
      typeof row.attempt_generation === 'number'
        ? row.attempt_generation
        : typeof row.attempt === 'object' && row.attempt && 'generation' in row.attempt
          ? Number(row.attempt.generation)
          : null,
    outcome_state:
      typeof row.outcome_state === 'string'
        ? (row.outcome_state as ProviderOutcomeState)
        : typeof row.attempt === 'object' && row.attempt && 'outcomeState' in row.attempt
          ? (String(row.attempt.outcomeState) as ProviderOutcomeState)
          : null,
    billing_state:
      typeof row.billing_state === 'string'
        ? (row.billing_state as ProviderBillingState)
        : typeof row.attempt === 'object' && row.attempt && 'billingState' in row.attempt
          ? (String(row.attempt.billingState) as ProviderBillingState)
          : null,
    heartbeat_at:
      typeof row.heartbeat_at === 'string'
        ? row.heartbeat_at
        : typeof row.attempt === 'object' && row.attempt && 'heartbeatAt' in row.attempt
          ? String(row.attempt.heartbeatAt)
          : null,
    dispatch_started_at:
      typeof row.dispatch_started_at === 'string'
        ? row.dispatch_started_at
        : typeof row.attempt === 'object' && row.attempt && 'dispatchStartedAt' in row.attempt
          ? String(row.attempt.dispatchStartedAt)
          : null,
    reconcile_after:
      typeof row.reconcile_after === 'string'
        ? row.reconcile_after
        : typeof row.attempt === 'object' && row.attempt && 'reconcileAfter' in row.attempt
          ? String(row.attempt.reconcileAfter)
          : null,
    normalized_completion_code:
      typeof row.normalized_completion_code === 'string'
        ? row.normalized_completion_code
        : typeof row.attempt === 'object' && row.attempt && 'normalizedCompletionCode' in row.attempt
          ? String(row.attempt.normalizedCompletionCode)
          : null,
    normalized_error_code:
      typeof row.normalized_error_code === 'string'
        ? row.normalized_error_code
        : typeof row.attempt === 'object' && row.attempt && 'normalizedErrorCode' in row.attempt
          ? String(row.attempt.normalizedErrorCode)
          : null,
  });
}
