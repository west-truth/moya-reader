import { validFilterChanges, validSourceBrowse } from './source-browse-validation';
import type {
  SourceAsset,
  SourceContent,
  SourceContentRequest,
  SourcePage,
  SourceRelease,
  SourceWork,
} from './source-sdk';
import { MAX_SOURCE_IMAGES, MAX_SOURCE_ASSET_BYTES } from './content-limits.mjs';

/** This intermediate result must never cross the public catalog/Reader boundary. */
export function validateSourceContentRequest(value: unknown): value is SourceContentRequest {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['kind', 'service', 'version', 'url'].includes(key)) &&
    value.kind === 'service' &&
    value.service === 'text-content' &&
    value.version === 1 &&
    string(value.url, 4096)
  );
}

export const SOURCE_METHODS = [
  'source.listWorks',
  'source.getWork',
  'source.listReleases',
  'source.getContent',
  'source.getCover',
] as const;
export type SourceMethod = (typeof SOURCE_METHODS)[number];

export interface SourceResults {
  'source.listWorks': SourcePage<SourceWork>;
  'source.getWork': SourceWork;
  'source.listReleases': SourcePage<SourceRelease>;
  'source.getContent': SourceContent;
  'source.getCover': SourceAsset | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes(String.fromCharCode(0))
  );
}
function optionalString(value: unknown, max?: number): boolean {
  return value === undefined || string(value, max);
}
function asset(value: unknown): value is SourceAsset {
  return (
    object(value) &&
    string(value.handle, 128) &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) > 0 &&
    (value.byteLength as number) <= MAX_SOURCE_ASSET_BYTES &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    string(value.contentType, 128)
  );
}
function work(value: unknown): value is SourceWork {
  return (
    object(value) &&
    string(value.id) &&
    string(value.title, 2000) &&
    optionalString(value.author, 2000) &&
    optionalString(value.description, 64000) &&
    optionalString(value.revision) &&
    (value.hasCover === undefined || typeof value.hasCover === 'boolean') &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) && value.tags.length <= 100 && value.tags.every((tag) => string(tag))))
  );
}
function release(value: unknown): value is SourceRelease {
  return (
    object(value) &&
    string(value.id) &&
    string(value.title, 2000) &&
    typeof value.order === 'number' &&
    Number.isFinite(value.order) &&
    Math.abs(value.order) <= Number.MAX_SAFE_INTEGER &&
    (value.number === undefined || (typeof value.number === 'number' && Number.isFinite(value.number))) &&
    optionalString(value.revision)
  );
}
function page(value: unknown, item: (value: unknown) => boolean): boolean {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 500 ||
    !optionalString(value.nextCursor, 4096) ||
    !value.items.every(item)
  )
    return false;
  return new Set(value.items.map((entry) => (entry as { id: string }).id)).size === value.items.length;
}

/** Host-side validation is mandatory even when a source uses the typed SDK. */
export function validateSourceResult<M extends SourceMethod>(method: M, value: unknown): value is SourceResults[M] {
  switch (method) {
    case 'source.listWorks':
      return page(value, work) && validSourceBrowse((value as Record<string, unknown>).browse);
    case 'source.getWork':
      return work(value);
    case 'source.listReleases':
      return page(value, release);
    case 'source.getCover':
      return value === null || asset(value);
    case 'source.getContent':
      return (
        object(value) &&
        ((value.kind === 'text' && asset(value.asset)) ||
          (value.kind === 'images' &&
            Array.isArray(value.assets) &&
            value.assets.length > 0 &&
            value.assets.length <= MAX_SOURCE_IMAGES &&
            value.assets.every(asset) &&
            new Set(value.assets.map((entry) => entry.handle)).size === value.assets.length))
      );
    default:
      return false;
  }
}

export function validateSourceInput(method: SourceMethod, value: unknown): value is Record<string, unknown> {
  if (
    !object(value) ||
    !validFilterChanges(value.filters) ||
    (value.browseMode !== undefined && !['popular', 'latest', 'search'].includes(String(value.browseMode))) ||
    !string(value.sourceId) ||
    !optionalString(value.cursor, 4096) ||
    !(value.query === undefined || value.query === '' || string(value.query, 2000))
  )
    return false;
  if (method !== 'source.listWorks' && !string(value.workId)) return false;
  return method !== 'source.getContent' || string(value.releaseId);
}
