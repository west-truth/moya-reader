import type { Queue } from 'bullmq';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { AnalysisInputStaleError } from './analysis-input-contracts.js';
import { promoteApprovedAnalysisReview } from './analysis-review-promotion-service.js';
import {
  AnalysisReviewConflictError,
  AnalysisReviewInputError,
  AnalysisReviewNotFoundError,
} from './analysis-review-service.js';
import {
  claimAnalysisReviewsForReconciliation,
  completeAnalysisReviewReconciliation,
  deferAnalysisReviewReconciliation,
  obsoleteAnalysisReviewReconciliation,
  type AnalysisReviewReconcileClaim,
} from './analysis-review-repository.js';

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 60_000;
const MAX_AUTO_ATTEMPTS = 5;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

export interface AnalysisReviewReconcileSummary {
  readonly claimed: number;
  readonly promoted: number;
  readonly obsolete: number;
  readonly deferred: number;
  readonly blocked: number;
}

export interface AnalysisReviewReconcileOptions {
  readonly owner: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly promote?: typeof promoteApprovedAnalysisReview;
}

interface PromotionFailurePolicy {
  readonly errorCode: string;
  readonly obsolete?: boolean;
  readonly retryAfterMs?: number;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

export function classifyAnalysisReviewPromotionFailure(error: unknown, attemptCount: number): PromotionFailurePolicy {
  if (error instanceof AnalysisInputStaleError) return { errorCode: error.code, obsolete: true };
  if (error instanceof AnalysisReviewInputError) return { errorCode: 'candidate_invalid' };
  if (error instanceof AnalysisReviewNotFoundError) return { errorCode: 'review_missing' };

  const errorCode = error instanceof AnalysisReviewConflictError ? 'promotion_conflict' : 'promotion_transient';
  if (attemptCount >= MAX_AUTO_ATTEMPTS) return { errorCode: `${errorCode}_retry_exhausted` };
  return {
    errorCode,
    retryAfterMs: Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attemptCount - 1), MAX_RETRY_MS),
  };
}

async function reconcileClaim(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  owner: string,
  claim: AnalysisReviewReconcileClaim,
  promote: typeof promoteApprovedAnalysisReview,
): Promise<'promoted' | 'obsolete' | 'deferred' | 'blocked'> {
  try {
    await promote(pool, config, claim.reviewId, queue);
    await completeAnalysisReviewReconciliation(pool, {
      reviewId: claim.reviewId,
      userId: config.defaultUserId,
      owner,
    });
    return 'promoted';
  } catch (error) {
    const policy = classifyAnalysisReviewPromotionFailure(error, claim.attemptCount);
    if (policy.obsolete) {
      await obsoleteAnalysisReviewReconciliation(pool, {
        reviewId: claim.reviewId,
        userId: config.defaultUserId,
        owner,
        errorCode: policy.errorCode,
      });
      return 'obsolete';
    }
    await deferAnalysisReviewReconciliation(pool, {
      reviewId: claim.reviewId,
      userId: config.defaultUserId,
      owner,
      errorCode: policy.errorCode,
      retryAfterMs: policy.retryAfterMs,
    });
    return policy.retryAfterMs === undefined ? 'blocked' : 'deferred';
  }
}

export async function reconcileApprovedAnalysisReviews(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  options: AnalysisReviewReconcileOptions,
): Promise<AnalysisReviewReconcileSummary> {
  const claims = await claimAnalysisReviewsForReconciliation(pool, {
    userId: config.defaultUserId,
    owner: options.owner,
    limit: boundedPositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 50),
    leaseMs: boundedPositiveInteger(options.leaseMs, DEFAULT_LEASE_MS, 10 * 60_000),
  });
  const summary = { claimed: claims.length, promoted: 0, obsolete: 0, deferred: 0, blocked: 0 };
  for (const claim of claims) {
    const outcome = await reconcileClaim(
      pool,
      config,
      queue,
      options.owner,
      claim,
      options.promote ?? promoteApprovedAnalysisReview,
    );
    summary[outcome] += 1;
  }
  return summary;
}
