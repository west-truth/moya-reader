import { createHash } from 'node:crypto';
import { ID_PATTERN, MAX_CONTENT_BYTES, SourceError, TXT_PROFILE } from './catalog.mjs';

export const ADAPTER_API_VERSION = 1;
export const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_PAGE_SIZE = 100;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Match the Moya text-server broker's public metadata limits.
export const MAX_LABEL_LENGTH = 256;
export const MAX_DESCRIPTION_LENGTH = 8_192;
const METHODS = ['listWorks', 'getWork', 'listReleases', 'getContent'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value, maximum, { empty = false, multiline = false } = {}) {
  return (
    typeof value === 'string' &&
    (empty || value.trim().length > 0) &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
    })
  );
}
function resultCondition(condition) {
  if (!condition) throw new SourceError(502, 'invalid_adapter_response');
}
export function validateSourceId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new SourceError(400, 'invalid_source_id');
  return id;
}
export function validatePagination(input = {}, { search = false } = {}) {
  if (!record(input)) throw new SourceError(400, 'invalid_query');
  const { cursor, query, signal } = input;
  const limit = input.limit ?? 50;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE ||
    (cursor !== undefined && !text(cursor, MAX_CURSOR_LENGTH))
  )
    throw new SourceError(400, 'invalid_pagination');
  if (query !== undefined && (!search || !text(query, 200, { empty: true })))
    throw new SourceError(400, 'invalid_query');
  return { limit, ...(cursor === undefined ? {} : { cursor }), ...(query === undefined ? {} : { query }), signal };
}

/** URL parsing owns duplicate/unknown parameters; adapters own the meaning and scope of opaque cursors. */
export function parseListParameters(parameters, { search = false } = {}) {
  for (const key of parameters.keys())
    if (!['cursor', 'limit', ...(search ? ['query'] : [])].includes(key) || parameters.getAll(key).length !== 1)
      throw new SourceError(400, 'invalid_query');
  const rawLimit = parameters.get('limit');
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) throw new SourceError(400, 'invalid_pagination');
  return validatePagination(
    {
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
      ...(parameters.has('cursor') ? { cursor: parameters.get('cursor') } : {}),
      ...(parameters.has('query') ? { query: parameters.get('query') } : {}),
    },
    { search },
  );
}

export function validateAdapter(adapter) {
  if (
    !record(adapter) ||
    adapter.apiVersion !== ADAPTER_API_VERSION ||
    typeof adapter.id !== 'string' ||
    !ID_PATTERN.test(adapter.id) ||
    !text(adapter.title, MAX_LABEL_LENGTH) ||
    METHODS.some((method) => typeof adapter[method] !== 'function')
  )
    throw new SourceError(500, 'invalid_source_adapter');
  const capabilities = adapter.capabilities ?? ['txt-content'];
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes('txt-content') ||
    capabilities.length > 3 ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability) => !['search', 'txt-content', 'cover-read'].includes(capability)) ||
    (capabilities.includes('cover-read') && typeof adapter.getCover !== 'function')
  )
    throw new SourceError(500, 'invalid_source_adapter');
  return { apiVersion: ADAPTER_API_VERSION, id: adapter.id, title: adapter.title, capabilities: [...capabilities] };
}

function work(value) {
  resultCondition(
    record(value) && typeof value.id === 'string' && ID_PATTERN.test(value.id) && text(value.title, MAX_LABEL_LENGTH),
  );
  const output = { id: value.id, title: value.title };
  if (value.hasCover !== undefined) {
    resultCondition(typeof value.hasCover === 'boolean');
    output.hasCover = value.hasCover;
  }
  for (const [key, maximum] of [
    ['author', MAX_LABEL_LENGTH],
    ['description', MAX_DESCRIPTION_LENGTH],
  ]) {
    if (value[key] !== undefined) {
      resultCondition(text(value[key], maximum, { multiline: key === 'description' }));
      output[key] = value[key];
    }
  }
  if (value.tags !== undefined) {
    resultCondition(Array.isArray(value.tags) && value.tags.length <= 50 && value.tags.every((tag) => text(tag, 100)));
    output.tags = [...value.tags];
  }
  return output;
}
function revision(value) {
  // The route writes this value directly to ETag. Keep the ABI stricter than Node's header byte range.
  resultCondition(
    value === undefined ||
      (typeof value === 'string' && value.length <= 256 && /^(?:W\/)?"[\x21\x23-\x7e]*"$/u.test(value)),
  );
  return value;
}
function release(value) {
  resultCondition(
    record(value) &&
      typeof value.id === 'string' &&
      ID_PATTERN.test(value.id) &&
      text(value.title, MAX_LABEL_LENGTH) &&
      typeof value.sourceOrder === 'number' &&
      Number.isFinite(value.sourceOrder),
  );
  return {
    id: value.id,
    title: value.title,
    sourceOrder: value.sourceOrder,
    ...(value.revision === undefined ? {} : { revision: revision(value.revision) }),
  };
}
export function boundedMetadata(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_METADATA_BYTES)
    throw new SourceError(502, 'adapter_metadata_limit');
  return value;
}
export function validatePage(value, input, kind) {
  resultCondition(record(value) && Array.isArray(value.items) && value.items.length <= input.limit);
  resultCondition(value.nextCursor === undefined || text(value.nextCursor, MAX_CURSOR_LENGTH));
  resultCondition(value.nextCursor === undefined || (value.items.length > 0 && value.nextCursor !== input.cursor));
  const items = value.items.map(kind === 'works' ? work : release);
  resultCondition(new Set(items.map((item) => item.id)).size === items.length);
  return boundedMetadata({ items, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) });
}
export function validateWork(value, workId) {
  const output = work(value);
  resultCondition(
    output.id === workId &&
      record(value.seriesProfile) &&
      Object.entries(TXT_PROFILE).every(([key, expected]) => value.seriesProfile[key] === expected),
  );
  return boundedMetadata({ ...output, seriesProfile: TXT_PROFILE });
}
export function validateContent(value) {
  resultCondition(record(value) && value.bytes instanceof Uint8Array && value.bytes.byteLength > 0);
  if (value.bytes.byteLength > MAX_CONTENT_BYTES) throw new SourceError(413, 'source_size_limit');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(value.bytes);
  } catch {
    throw new SourceError(422, 'invalid_utf8_content');
  }
  return { bytes: value.bytes, ...(value.revision === undefined ? {} : { revision: revision(value.revision) }) };
}

export function validateCover(value) {
  resultCondition(record(value) && value.bytes instanceof Uint8Array && value.bytes.byteLength > 0);
  resultCondition(value.bytes.byteLength <= MAX_COVER_BYTES && COVER_TYPES.includes(value.contentType));
  return { bytes: value.bytes, contentType: value.contentType };
}

/** Only these safe fields cross the HTTP error boundary; arbitrary adapter messages never do. */
export function safeAdapterError(error) {
  if (
    error instanceof SourceError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    typeof error.code === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  )
    return new SourceError(error.status, error.code);
  return new SourceError(502, 'adapter_request_failed');
}

/** In-memory adapters use a stable cursor bound to their source/query/work and ordered ID snapshot. */
export function cursorScope(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}
export function paginateItems(items, input, scope) {
  let offset = 0;
  if (input.cursor !== undefined) {
    const match = /^s1\.([a-f0-9]{32})\.(0|[1-9][0-9]{0,8})$/u.exec(input.cursor);
    if (!match || match[1] !== scope) throw new SourceError(400, 'invalid_pagination');
    offset = Number(match[2]);
  }
  if (offset > items.length) throw new SourceError(400, 'invalid_pagination');
  return {
    items: items.slice(offset, offset + input.limit),
    ...(offset + input.limit < items.length ? { nextCursor: `s1.${scope}.${offset + input.limit}` } : {}),
  };
}
