const REDACTED = '[REDACTED]';
const safeStringKeys = new Set([
  'application',
  'attemptId',
  'component',
  'correlationId',
  'errorCategory',
  'errorCode',
  'errorName',
  'event',
  'jobId',
  'jobType',
  'level',
  'method',
  'outcome',
  'queue',
  'requestId',
  'service',
  'state',
  'timestamp',
  'uploadId',
  'worker',
  'workflowId',
]);
const sensitiveKey =
  /(authorization|cookie|secret|token|api.?key|credential|endpoint|url|uri|body|raw|novel.?text|paragraph.?text|segment.?text|input.?text|output.?text|prompt|content|message|stack|cause|path)/i;
const unsafeString = /(https?:\/\/|file:\/\/|bearer\s+|\bsk-[A-Za-z0-9_-]+|[A-Za-z]:\\|^\/(?:home|root|users|etc)\/)/i;

export function redactLogFields(value: unknown): unknown {
  return redactValue(value, undefined, new WeakSet<object>());
}

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return redactString(value, key);
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (isBinaryValue(value)) return REDACTED;
  if (value instanceof Error) return { errorName: safeErrorName(value.name) };
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key, seen));
  if (typeof value !== 'object') return REDACTED;
  if (seen.has(value)) return '[CIRCULAR]';

  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (sensitiveKey.test(entryKey) && !safeStringKeys.has(entryKey)) {
      result[entryKey] = REDACTED;
      continue;
    }
    const redacted = redactValue(entryValue, entryKey, seen);
    if (redacted !== undefined) result[entryKey] = redacted;
  }
  seen.delete(value);
  return result;
}

function isBinaryValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function redactString(value: string, key: string | undefined): string {
  if (key && sensitiveKey.test(key) && !safeStringKeys.has(key)) return REDACTED;
  if (unsafeString.test(value)) return REDACTED;
  if (!key || !safeStringKeys.has(key)) return REDACTED;
  if (key === 'errorName') return safeErrorName(value);
  return value.slice(0, 128);
}

function safeErrorName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error';
}
