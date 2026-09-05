import { SourceError, TXT_PROFILE, publicWork, revisionTag } from './catalog.mjs';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  cursorScope,
  paginateItems,
  validatePagination,
  validateSourceId,
} from './adapter-contract.mjs';

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// Keep existing catalog input compatible while publishing metadata the Moya broker can consume.
// This only bounds display fields; catalog objects, IDs, revisions and source bytes stay untouched.
function displayText(value, maximum) {
  if (value.length <= maximum) return value;
  const result = value.trim().slice(0, maximum);
  const last = result.charCodeAt(result.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result;
}
function displayWork(work) {
  const result = publicWork(work);
  result.title = displayText(result.title, MAX_LABEL_LENGTH);
  if (result.author !== undefined) result.author = displayText(result.author, MAX_LABEL_LENGTH);
  if (result.description !== undefined) result.description = displayText(result.description, MAX_DESCRIPTION_LENGTH);
  return result;
}

/** Wraps loadCatalog's checked metadata and file reader without reading any body during listing. */
export function createStaticCatalogAdapter(catalog, source, contentProvider) {
  if (catalog.sources.get(source.id) !== source) throw new SourceError(500, 'invalid_source_adapter');
  const works = [...source.workMap.values()].sort(byId).map(displayWork);
  const worksScope = cursorScope([source.id, 'works', works.map((work) => work.id)]);
  const releasePages = new Map();
  for (const work of source.workMap.values()) {
    const items = [...work.releaseMap.values()]
      .sort((left, right) => left.order - right.order || byId(left, right))
      .map((release) => ({
        id: release.id,
        title: displayText(release.title, MAX_LABEL_LENGTH),
        sourceOrder: release.order,
        ...(release.revision === undefined ? {} : { revision: revisionTag(release.revision) }),
      }));
    releasePages.set(work.id, {
      items,
      scope: cursorScope([source.id, 'releases', work.id, items.map((item) => item.id)]),
    });
  }
  const getWork = (workId) => {
    validateSourceId(workId);
    const work = source.workMap.get(workId);
    if (!work) throw new SourceError(404, 'not_found');
    return work;
  };
  return {
    apiVersion: 1,
    id: source.id,
    title: displayText(source.name, MAX_LABEL_LENGTH),
    capabilities: ['search', 'txt-content'],
    async listWorks(input = {}) {
      const parameters = validatePagination(input, { search: true });
      parameters.signal?.throwIfAborted();
      const query = (parameters.query ?? '').toLowerCase();
      const matched = query
        ? works.filter((work) => {
            const original = source.workMap.get(work.id);
            return `${original.title}\n${original.author ?? ''}`.toLowerCase().includes(query);
          })
        : works;
      return paginateItems(matched, parameters, cursorScope([worksScope, query]));
    },
    async getWork({ workId, signal }) {
      signal?.throwIfAborted();
      return { ...displayWork(getWork(workId)), seriesProfile: TXT_PROFILE };
    },
    async listReleases(input) {
      const parameters = validatePagination(input);
      parameters.signal?.throwIfAborted();
      getWork(input.workId);
      const page = releasePages.get(input.workId);
      return paginateItems(page.items, parameters, page.scope);
    },
    async getContent({ workId, releaseId, signal }) {
      signal?.throwIfAborted();
      validateSourceId(releaseId);
      const release = getWork(workId).releaseMap.get(releaseId);
      if (!release) throw new SourceError(404, 'not_found');
      if (release.file === undefined && !contentProvider) throw new SourceError(503, 'content_provider_not_configured');
      const bytes =
        release.file !== undefined
          ? await catalog.readFile(release, signal)
          : await contentProvider(release.contentUrl, signal);
      signal?.throwIfAborted();
      return { bytes, revision: revisionTag(release.revision, bytes) };
    },
  };
}
