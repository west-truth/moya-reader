import { setTimeout as sleep } from 'node:timers/promises';
import { approveSourceUrl } from '../../packages/extension-runtime/source-http.mjs';
import { compatibilityHttp, type CompatibilityHttpInput } from '../../apps/server/src/extensions/mangayomi/http';
import { validSourcePreferenceValue } from '../../packages/extension-contracts/source-preferences';
import type { VerifiedMoyaPackage } from '../../src/extensions/packages/package-archive';
import type { DevelopmentFixture } from './project';

/** Development uses local values only: no production cookies, vault or private-origin grants. */
export function developmentContext(
  pkg: VerifiedMoyaPackage,
  sourceId: string,
  options: { network?: boolean; fixtures?: readonly DevelopmentFixture[]; preferences?: unknown },
  onFixtureMissing: () => void,
) {
  const fields = pkg.manifest.preferences?.find((entry) => entry.sourceId === sourceId)?.fields ?? [];
  const supplied = options.preferences ?? {};
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied))
    throw new Error('invalid_source_preferences');
  for (const [key, value] of Object.entries(supplied)) {
    const field = fields.find((entry) => entry.key === key);
    if (!field || !validSourcePreferenceValue(field, value)) throw new Error('invalid_source_preferences');
  }
  const values = Object.fromEntries(
    fields.map((field) => [
      field.key,
      Object.prototype.hasOwnProperty.call(supplied, field.key)
        ? supplied[field.key as keyof typeof supplied]
        : (field.defaultValue ?? null),
    ]),
  );
  let requestedBytes = 0;
  return {
    'source.sleep': async (request: unknown, signal: AbortSignal) => {
      const milliseconds = (request as { milliseconds?: unknown })?.milliseconds;
      if (!Number.isInteger(milliseconds) || Number(milliseconds) < 0 || Number(milliseconds) > 10000)
        throw new Error('invalid_source_invocation');
      await sleep(Number(milliseconds), undefined, { signal });
      return null;
    },
    'preferences.get': async (request: unknown) => {
      const key = (request as { key?: unknown })?.key;
      if (typeof key !== 'string') throw new Error('invalid_source_preferences');
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    'source.request': async (request: unknown, signal: AbortSignal) => {
      const input = request as CompatibilityHttpInput;
      signal.throwIfAborted();
      const origins = pkg.manifest.requestedAccess.networkOrigins;
      // Validate origin before fixture lookup too. Fixtures never grant extra network access.
      await approveSourceUrl(input?.url, origins, async () => [{ address: '93.184.216.34', family: 4 }]);
      let response;
      if (options.network) {
        response = await compatibilityHttp(input, signal, [], 2 * 1024 * 1024, undefined, false);
      } else {
        const fixture = options.fixtures?.find(
          (item) => item.url === input.url && (item.method ?? 'GET') === (input.method ?? 'GET'),
        );
        if (!fixture) {
          onFixtureMissing();
          throw new Error('fixture_missing');
        }
        response = {
          bytes:
            fixture.bodyBase64 !== undefined
              ? Buffer.from(fixture.bodyBase64, 'base64')
              : Buffer.from(fixture.body ?? ''),
          statusCode: fixture.status ?? 200,
          headers: { 'content-type': fixture.contentType ?? 'text/plain', ...fixture.headers },
        };
      }
      signal.throwIfAborted();
      requestedBytes += response.bytes.length;
      if (response.bytes.length > 2 * 1024 * 1024 || requestedBytes > 32 * 1024 * 1024)
        throw new Error('source_body_limit');
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
      };
    },
  };
}
