import type { ProviderJobAdmissionLimits } from '../../config.js';

export const PROVIDER_JOB_ADMISSION_ERROR_CODE = 'provider_job_admission_rejected';

export type ProviderJobAdmissionLimit = 'active_attempts' | 'attempts_per_minute' | 'attempts_per_utc_day';

export interface ProviderQueueAttempt {
  readonly attemptId: string;
  readonly bullmqJobId: string;
}

export interface ProviderJobAdmissionRejection {
  readonly code: typeof PROVIDER_JOB_ADMISSION_ERROR_CODE;
  readonly limit: ProviderJobAdmissionLimit;
  readonly retryAfterSeconds?: number;
}

export type ProviderJobAdmissionDecision =
  | {
      readonly kind: 'admitted';
      readonly attempt: ProviderQueueAttempt;
      readonly reused: boolean;
    }
  | {
      readonly kind: 'not_queued';
    }
  | {
      readonly kind: 'rejected';
      readonly rejection: ProviderJobAdmissionRejection;
    };

export class ProviderJobAdmissionError extends Error {
  readonly code = PROVIDER_JOB_ADMISSION_ERROR_CODE;
  readonly limit: ProviderJobAdmissionLimit;
  readonly retryAfterSeconds?: number;

  constructor(rejection: ProviderJobAdmissionRejection) {
    super('Provider job admission limit was reached.');
    this.name = 'ProviderJobAdmissionError';
    this.limit = rejection.limit;
    this.retryAfterSeconds = rejection.retryAfterSeconds;
  }
}

export function providerJobAdmissionErrorBody(error: ProviderJobAdmissionError): {
  error: typeof PROVIDER_JOB_ADMISSION_ERROR_CODE;
  code: typeof PROVIDER_JOB_ADMISSION_ERROR_CODE;
  limit: ProviderJobAdmissionLimit;
  retryAfterSeconds?: number;
} {
  return {
    error: error.code,
    code: error.code,
    limit: error.limit,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  };
}

export function assertProviderJobAdmissionLimits(limits: ProviderJobAdmissionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Provider job admission limit ${name} must be a non-negative safe integer.`);
    }
  }
}
