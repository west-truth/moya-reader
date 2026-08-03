export type ProviderErrorCategory =
  | 'auth'
  | 'quota'
  | 'missing_config'
  | 'schema'
  | 'retryable_network'
  | 'content_too_large'
  | 'unsupported'
  | 'cancelled'
  | 'unknown';

export interface ClassifiedProviderError {
  readonly category: ProviderErrorCategory;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly safeMessage: string;
}

const safeMessages: Record<ProviderErrorCategory, string> = {
  auth: 'Provider authentication or authorization failed. Check server-side credentials and permissions.',
  quota: 'Provider quota or billing limit was reached.',
  missing_config:
    'Provider configuration is incomplete. Check enabled provider, model, voice, endpoint, and server-side credentials.',
  schema: 'Provider output did not match the expected schema or validation rules.',
  retryable_network: 'Provider request failed with a retryable network or temporary service error.',
  content_too_large: 'Provider input exceeded the configured or provider-supported size limit.',
  unsupported: 'Requested provider capability is unsupported or unavailable.',
  cancelled: 'Provider job was cancelled.',
  unknown:
    'Provider request failed. Details were suppressed because provider errors can include secrets or endpoint response bodies.',
};

const retryableCategories = new Set<ProviderErrorCategory>(['retryable_network']);

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  const category = providerErrorCategory(error);
  return {
    category,
    errorCode: `provider_error_${category}`,
    retryable: retryableCategories.has(category),
    safeMessage: safeMessages[category],
  };
}

function providerErrorCategory(error: unknown): ProviderErrorCategory {
  const status = statusCode(error);
  const details = providerErrorDetails(error);
  const lower = details.toLowerCase();

  if (
    lower.includes('providerjobcancellederror') ||
    lower.includes('provider job cancelled') ||
    lower.includes('aborterror')
  ) {
    return 'cancelled';
  }
  if (
    lower.includes('unsupported ') ||
    lower.includes('not available for server synthesis') ||
    lower.includes('does not support')
  ) {
    return 'unsupported';
  }
  if (
    matches(lower, [
      'budget exceeded',
      'too large',
      'content too large',
      'payload too large',
      'input size',
      'max input',
      'maximum input',
      'context length',
      'maximum context',
      'token limit',
    ]) ||
    status === 413 ||
    status === 414
  ) {
    return 'content_too_large';
  }
  if (lower.includes('chapterlabelingvalidationerror')) {
    return 'schema';
  }
  if (lower.includes('provideroutputincompleteerror') || lower.includes('provider_output_incomplete')) {
    return 'schema';
  }
  if (
    matches(lower, [
      'is required',
      'are required',
      'not ready',
      'not configured',
      'missing',
      'must set',
      'model id is required',
      'voice id is required',
      'endpoint_url is required',
      'endpoint url is required',
      'secretconfigured',
      'modelconfigured',
      'voiceconfigured',
      'secret-like',
      'must not contain',
    ])
  ) {
    return 'missing_config';
  }
  if (
    matches(lower, ['quota', 'billing', 'insufficient_quota', 'resource_exhausted', 'credits', 'credit balance']) ||
    status === 402
  ) {
    return 'quota';
  }
  if (
    matches(lower, [
      'unauthorized',
      'unauthenticated',
      'permission denied',
      'forbidden',
      'invalid api key',
      'invalid_api_key',
      'access denied',
      'invalid credential',
    ]) ||
    status === 401 ||
    status === 403
  ) {
    return 'auth';
  }
  if (
    matches(lower, [
      'schema',
      'validation',
      'quality failed',
      'quality check failed',
      'invalid json',
      'invalid response',
      'returned no',
      'empty response',
      'no message content',
      'no text content',
      'no audiobase64',
      'no audiocontent',
      'response did not include',
      'does not match',
      'mismatch',
    ]) ||
    status === 400 ||
    status === 422
  ) {
    return 'schema';
  }
  if (
    matches(lower, [
      'fetch failed',
      'network',
      'timeout',
      'timed out',
      'temporary',
      'temporarily',
      'econnreset',
      'econnrefused',
      'etimedout',
      'enotfound',
      'socket hang up',
    ]) ||
    [408, 409, 425, 429, 500, 502, 503, 504].includes(status ?? 0)
  ) {
    return 'retryable_network';
  }

  return 'unknown';
}

function providerErrorDetails(error: unknown): string {
  const parts: string[] = [];
  appendErrorDetails(parts, error);
  return parts.join(' ');
}

function appendErrorDetails(parts: string[], value: unknown): void {
  if (!value) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (value instanceof Error) {
    parts.push(value.name, value.message);
    appendErrorDetails(parts, value.cause);
    return;
  }
  if (typeof value !== 'object') {
    parts.push(String(value));
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'message', 'code', 'status', 'statusCode', 'type']) {
    const field = record[key];
    if (typeof field === 'string' || typeof field === 'number') parts.push(String(field));
  }
  appendErrorDetails(parts, record.cause);
}

function statusCode(error: unknown): number | undefined {
  const explicit = explicitStatusCode(error);
  if (explicit !== undefined) return explicit;
  const details = providerErrorDetails(error);
  const match = details.match(/\b(?:status|with|\()\s*(\d{3})\b/i) ?? details.match(/\b([45]\d{2})\b/);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function explicitStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['status', 'statusCode']) {
    const field = record[key];
    const parsed = typeof field === 'number' ? field : typeof field === 'string' ? Number(field) : NaN;
    if (Number.isInteger(parsed)) return parsed;
  }
  return explicitStatusCode(record.cause);
}

function matches(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
