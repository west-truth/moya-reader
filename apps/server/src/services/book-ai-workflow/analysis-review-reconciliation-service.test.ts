import type { ChapterLabelAnalysisReviewArtifact } from '../../../../../src/providers/analysis-review';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { testConfig } from './book-ai-workflow-test-harness.js';
import { AnalysisInputStaleError } from './analysis-input-contracts.js';
import {
  classifyAnalysisReviewPromotionFailure,
  reconcileApprovedAnalysisReviews,
} from './analysis-review-reconciliation-service.js';
import { AnalysisReviewConflictError, AnalysisReviewInputError } from './analysis-review-service.js';

function claimRow(attemptCount = 1) {
  return {
    id: 'review_1',
    review_revision: 2,
    status: 'approved',
    promotion_attempt_count: attemptCount,
  };
}

function poolWithClaim(attemptCount = 1) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('with due')) return { rows: [claimRow(attemptCount)], rowCount: 1 };
    return { rows: [], rowCount: 1, params };
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

describe('analysis review reconciliation', () => {
  it('claims and completes a due approved review', async () => {
    const { pool, query } = poolWithClaim();
    const promote = vi.fn(async () => ({ id: 'review_1' }) as ChapterLabelAnalysisReviewArtifact);

    const summary = await reconcileApprovedAnalysisReviews(pool, testConfig(), undefined, {
      owner: 'worker:test',
      promote,
    });

    expect(summary).toEqual({ claimed: 1, promoted: 1, obsolete: 0, deferred: 0, blocked: 0 });
    expect(promote).toHaveBeenCalledOnce();
    const claim = query.mock.calls.find(([sql]) => String(sql).includes('with due'));
    expect(String(claim?.[0])).toContain('for update skip locked');
    expect(String(claim?.[0])).not.toContain('next_reconcile_at = null');
    expect(claim?.[1]).toEqual(['user_test', 'worker:test', 20, 60_000]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('promotion_last_error_code = null'))).toBe(true);
  });

  it('defers transient failures with bounded backoff and no raw error body', async () => {
    const { pool, query } = poolWithClaim(2);
    const promote = vi.fn(async () => {
      throw new Error('provider response body must not be persisted');
    });

    const summary = await reconcileApprovedAnalysisReviews(pool, testConfig(), undefined, {
      owner: 'worker:test',
      promote,
    });

    expect(summary.deferred).toBe(1);
    const deferred = query.mock.calls.find(([sql]) => String(sql).includes('promotion_last_error_code = $4'));
    expect(deferred?.[1]).toEqual(['review_1', 'user_test', 'worker:test', 'promotion_transient', 10_000]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('provider response body');
  });

  it('classifies stale and deterministic failures without automatic retry', () => {
    expect(
      classifyAnalysisReviewPromotionFailure(
        new AnalysisInputStaleError('analysis_graph_revision_stale', 'graph changed'),
        1,
      ),
    ).toEqual({ errorCode: 'analysis_graph_revision_stale', obsolete: true });
    expect(classifyAnalysisReviewPromotionFailure(new AnalysisReviewInputError('invalid candidate'), 1)).toEqual({
      errorCode: 'candidate_invalid',
    });
    expect(classifyAnalysisReviewPromotionFailure(new AnalysisReviewConflictError('busy'), 5)).toEqual({
      errorCode: 'promotion_conflict_retry_exhausted',
    });
  });
});
