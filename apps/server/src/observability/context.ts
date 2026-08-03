import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface CorrelationContext {
  requestId?: string;
  correlationId: string;
  jobId?: string;
  workflowId?: string;
  attemptId?: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();
const safeCorrelationValue = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeCorrelationValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return safeCorrelationValue.test(normalized) ? normalized : undefined;
}

export function requestCorrelationContext(headers: Record<string, string | string[] | undefined>): CorrelationContext {
  const requestId = normalizeCorrelationValue(firstHeaderValue(headers['x-request-id'])) ?? randomUUID();
  const correlationId = normalizeCorrelationValue(firstHeaderValue(headers['x-correlation-id'])) ?? requestId;
  return { requestId, correlationId };
}

export function jobCorrelationContext(input: {
  jobId: string;
  attemptId?: string;
  workflowId?: string;
}): CorrelationContext {
  const jobId = normalizeCorrelationValue(input.jobId) ?? 'invalid-job-id';
  const workflowId = normalizeCorrelationValue(input.workflowId);
  const attemptId = normalizeCorrelationValue(input.attemptId);
  return {
    correlationId: workflowId ?? jobId,
    jobId,
    ...(workflowId ? { workflowId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}

export function currentCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function runWithCorrelation<T>(context: CorrelationContext, callback: () => T): T {
  return correlationStorage.run(context, callback);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
