import { describe, expect, it } from 'vitest';
import { mapProviderJob } from './provider-job-contract.js';

describe('provider job response contract', () => {
  it('exposes safe outcome and billing state without lease credentials', () => {
    const job = mapProviderJob({
      id: 'job_1',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'openai',
      model_id: 'model_1',
      input_hash: 'input_hash',
      status: 'failed',
      stage: 'failed',
      progress: {},
      error_code: 'provider_attempt_outcome_unknown',
      error_message: 'Provider request outcome is unknown; automatic retry is blocked',
      created_at: '2026-07-11T00:00:00.000Z',
      updated_at: '2026-07-11T00:01:00.000Z',
      started_at: '2026-07-11T00:00:10.000Z',
      finished_at: '2026-07-11T00:01:00.000Z',
      current_attempt_id: 'attempt_1',
      attempt_generation: 2,
      outcome_state: 'outcome_unknown',
      billing_state: 'billed_possible',
      heartbeat_at: '2026-07-11T00:00:40.000Z',
      dispatch_started_at: '2026-07-11T00:00:20.000Z',
      reconcile_after: '2026-07-11T00:01:00.000Z',
      normalized_completion_code: null,
      normalized_error_code: 'provider_attempt_lease_expired_after_dispatch',
    });

    expect(job.attempt).toEqual({
      attemptId: 'attempt_1',
      generation: 2,
      outcomeState: 'outcome_unknown',
      billingState: 'billed_possible',
      heartbeatAt: '2026-07-11T00:00:40.000Z',
      dispatchStartedAt: '2026-07-11T00:00:20.000Z',
      reconcileAfter: '2026-07-11T00:01:00.000Z',
      normalizedCompletionCode: undefined,
      normalizedErrorCode: 'provider_attempt_lease_expired_after_dispatch',
    });
    expect(JSON.stringify(job)).not.toMatch(/leaseOwner|leaseToken|providerRequestId/);
  });
});
