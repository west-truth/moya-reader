import { describe, expect, it, vi } from 'vitest';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import { cancelWorkflowProviderJob } from './workflow-cancellation-repository.js';

function job(): ProviderJobRow {
  return {
    id: 'job_1',
    user_id: 'user_1',
    book_id: 'book_1',
    chapter_id: null,
    job_type: 'character_bundle_analysis',
    provider_id: 'mock',
    model_id: 'mock-v1',
    input_hash: 'input_1',
    status: 'running',
    progress: {},
    current_attempt_id: 'attempt_1',
    attempt_count: 1,
    analysis_input_revision_id: null,
  };
}

describe('workflow cancellation repository', () => {
  it('derives billing state from the current provider attempt dispatch fence', async () => {
    const activeJob = job();
    const query = vi.fn(async (sql: string) => {
      const [jobUpdate, attemptUpdate] = sql.split('cancelled_attempt as');
      for (const attemptField of [
        'outcome_state',
        'billing_state',
        'normalized_error_code',
        'reconcile_after',
        'lease_expires_at',
      ]) {
        expect(jobUpdate).not.toContain(attemptField);
        expect(attemptUpdate).toContain(attemptField);
      }
      expect(attemptUpdate).toContain("outcome_state = 'cancelled'");
      expect(attemptUpdate).toContain("when attempt.dispatch_started_at is null then 'not_billable'");
      return { rows: [{ ...activeJob, status: 'cancelled' }] };
    });

    await expect(cancelWorkflowProviderJob({ query } as never, activeJob, { cancelled: true })).resolves.toMatchObject({
      id: 'job_1',
      status: 'cancelled',
    });
  });
});
