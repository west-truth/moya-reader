import type { SourceWebViewRequest } from './source-sdk';
export type { SourceWebViewRequest } from './source-sdk';

export function validSourceWebViewRequest(input: unknown): input is SourceWebViewRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const row = input as Record<string, unknown>;
  return (
    Object.keys(row).every((key) => ['url', 'script', 'headers', 'timeoutMs', 'waitUntil'].includes(key)) &&
    (row.waitUntil === undefined || row.waitUntil === 'load' || row.waitUntil === 'domcontentloaded') &&
    typeof row.url === 'string' &&
    row.url.length <= 8192 &&
    typeof row.script === 'string' &&
    row.script.length > 0 &&
    row.script.length <= 128 * 1024 &&
    (row.timeoutMs === undefined ||
      (Number.isInteger(row.timeoutMs) && Number(row.timeoutMs) >= 100 && Number(row.timeoutMs) <= 90000)) &&
    (row.headers === undefined ||
      (!!row.headers &&
        typeof row.headers === 'object' &&
        !Array.isArray(row.headers) &&
        Object.entries(row.headers).length <= 32 &&
        Object.entries(row.headers).every(
          ([key, value]) =>
            /^[a-zA-Z0-9-]{1,80}$/.test(key) &&
            !/^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(key) &&
            typeof value === 'string' &&
            value.length <= 8192 &&
            !/[\r\n]/.test(value),
        )))
  );
}
