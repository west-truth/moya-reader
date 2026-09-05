import { SourceError } from './catalog.mjs';
import {
  boundedMetadata,
  cursorScope,
  paginateItems,
  safeAdapterError,
  validateAdapter,
  validateContent,
  validateCover,
  validatePage,
  validatePagination,
  validateSourceId,
  validateWork,
} from './adapter-contract.mjs';

function guarded(adapter) {
  const descriptor = Object.freeze(validateAdapter(adapter));
  async function invoke(method, input, validate) {
    input.signal?.throwIfAborted();
    try {
      const value = await adapter[method](input);
      input.signal?.throwIfAborted();
      return validate(value);
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      throw safeAdapterError(error);
    }
  }
  return Object.freeze({
    ...descriptor,
    listWorks(input = {}) {
      const parameters = validatePagination(input, { search: true });
      if (parameters.query && !descriptor.capabilities.includes('search'))
        throw new SourceError(400, 'search_not_supported');
      return invoke('listWorks', parameters, (value) => validatePage(value, parameters, 'works'));
    },
    getWork(input) {
      const workId = validateSourceId(input?.workId);
      return invoke('getWork', { workId, signal: input?.signal }, (value) => validateWork(value, workId));
    },
    listReleases(input) {
      const workId = validateSourceId(input?.workId);
      const parameters = { ...validatePagination(input), workId };
      return invoke('listReleases', parameters, (value) => validatePage(value, parameters, 'releases'));
    },
    getContent(input) {
      const workId = validateSourceId(input?.workId);
      const releaseId = validateSourceId(input?.releaseId);
      return invoke('getContent', { workId, releaseId, signal: input?.signal }, validateContent);
    },
    getCover(input) {
      const workId = validateSourceId(input?.workId);
      if (!descriptor.capabilities.includes('cover-read')) throw new SourceError(404, 'not_found');
      return invoke('getCover', { workId, signal: input?.signal }, validateCover);
    },
  });
}

/** Only application-injected trusted code is accepted. No URLs, eval, imports, or package installation. */
export function createAdapterRegistry(adapters) {
  if (!Array.isArray(adapters) || adapters.length > 100) throw new SourceError(500, 'invalid_source_registry');
  const registry = new Map();
  for (const adapter of adapters) {
    const checked = guarded(adapter);
    if (registry.has(checked.id)) throw new SourceError(500, 'duplicate_source_adapter');
    registry.set(checked.id, checked);
  }
  const sources = [...registry.values()]
    .map(({ id, title }) => ({ id, title, available: true }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const scope = cursorScope(['sources', sources.map((source) => source.id)]);
  return Object.freeze({
    listSources(input = {}) {
      const parameters = validatePagination(input);
      parameters.signal?.throwIfAborted();
      return boundedMetadata(paginateItems(sources, parameters, scope));
    },
    get(sourceId) {
      validateSourceId(sourceId);
      const adapter = registry.get(sourceId);
      if (!adapter) throw new SourceError(404, 'not_found');
      return adapter;
    },
  });
}
