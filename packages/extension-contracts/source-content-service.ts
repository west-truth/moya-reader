/** Optional host service, independent of the provider's implementation/protocol and endpoint. */
export interface SourceContentService {
  readonly sourceId: string;
  readonly version: 1;
  readonly origins: readonly string[];
}

export type ContentConnectionRequest =
  { action: 'status' } | { action: 'remove' } | { action: 'save'; endpoint: string; key?: string };
export interface ContentConnectionStatus {
  configured: boolean;
  endpoint?: string;
  keySaved?: boolean;
  managed?: boolean;
}
export function validContentConnectionRequest(value: unknown): value is ContentConnectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.action === 'status' || row.action === 'remove') return Object.keys(row).length === 1;
  return (
    row.action === 'save' &&
    Object.keys(row).every((k) => ['action', 'endpoint', 'key'].includes(k)) &&
    typeof row.endpoint === 'string' &&
    row.endpoint.length > 0 &&
    row.endpoint.length <= 2048 &&
    (row.key === undefined || (typeof row.key === 'string' && row.key.length <= 4096 && !/\s/.test(row.key)))
  );
}

export function validateSourceContentServices(value: unknown, sources: readonly string[], origins: readonly string[]) {
  if (!Array.isArray(value) || value.length > 16) return false;
  const seen = new Set<string>();
  return value.every((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !['sourceId', 'version', 'origins'].includes(key)) ||
      typeof entry.sourceId !== 'string' ||
      !sources.includes(entry.sourceId) ||
      seen.has(entry.sourceId) ||
      entry.version !== 1 ||
      !Array.isArray(entry.origins) ||
      !entry.origins.length ||
      entry.origins.length > 16 ||
      new Set(entry.origins).size !== entry.origins.length ||
      entry.origins.some((origin: unknown) => typeof origin !== 'string' || !origins.includes(origin))
    )
      return false;
    seen.add(entry.sourceId);
    return true;
  });
}
