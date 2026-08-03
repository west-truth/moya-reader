import crypto from 'node:crypto';
import type pg from 'pg';
import type { ProviderJobAdmissionLimits } from '../../config.js';
import {
  ProviderJobAdmissionError,
  assertProviderJobAdmissionLimits,
  type ProviderJobAdmissionDecision,
  type ProviderQueueAttempt,
} from './contracts.js';
import { admitProviderJobAttempt } from './repository.js';

function newProviderQueueAttempt(): ProviderQueueAttempt {
  const attemptId = `provider_attempt_${crypto.randomUUID().replaceAll('-', '')}`;
  return { attemptId, bullmqJobId: attemptId };
}

function providerAttemptOutboxId(attemptId: string): string {
  return `${attemptId}_outbox`;
}

export async function prepareAdmittedProviderAttempt(
  pool: pg.Pool,
  jobId: string,
  limits: ProviderJobAdmissionLimits,
): Promise<ProviderQueueAttempt | undefined> {
  assertProviderJobAdmissionLimits(limits);
  const attempt = newProviderQueueAttempt();
  const decision: ProviderJobAdmissionDecision = await admitProviderJobAttempt(pool, {
    jobId,
    attempt,
    outboxId: providerAttemptOutboxId(attempt.attemptId),
    limits,
  });
  if (decision.kind === 'rejected') throw new ProviderJobAdmissionError(decision.rejection);
  return decision.kind === 'admitted' ? decision.attempt : undefined;
}
