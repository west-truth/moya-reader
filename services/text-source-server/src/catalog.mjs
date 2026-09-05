import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const TXT_PROFILE = Object.freeze({
  kind: 'document_series',
  format: 'txt',
  encoding: 'utf-8',
  chapterSplitMode: 'single',
});

export class SourceError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function text(value, maximum = 500) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireValue(condition) {
  if (!condition) throw new SourceError(500, 'invalid_catalog');
}
function uniqueMap(items) {
  const map = new Map();
  for (const item of items) {
    requireValue(record(item) && typeof item.id === 'string' && ID_PATTERN.test(item.id) && !map.has(item.id));
    map.set(item.id, item);
  }
  return map;
}

export function revisionTag(revision, bytes) {
  const digest = createHash('sha256')
    .update(revision === undefined ? bytes : `catalog-revision:${revision}`)
    .digest('hex');
  return `"${digest}"`;
}

export async function readBoundedFile(fileName, maximum, signal) {
  signal?.throwIfAborted();
  const handle = await open(fileName, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new SourceError(413, 'source_size_limit');
    const chunks = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum) throw new SourceError(413, 'source_size_limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

export async function loadCatalog(catalogFile, sourceRoot) {
  let input;
  try {
    input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedFile(catalogFile, MAX_CATALOG_BYTES)),
    );
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(500, 'invalid_catalog');
  }
  requireValue(
    record(input) &&
      text(input.instanceId, 256) &&
      text(input.dataNamespace, 256) &&
      Array.isArray(input.sources) &&
      input.sources.length <= 100,
  );
  const root = await realpath(sourceRoot);
  const sources = uniqueMap(input.sources);
  for (const source of sources.values()) {
    requireValue(text(source.name) && Array.isArray(source.works) && source.works.length <= 5_000);
    source.workMap = uniqueMap(source.works);
    for (const work of source.workMap.values()) {
      requireValue(
        text(work.title) &&
          (work.author === undefined || text(work.author)) &&
          Array.isArray(work.releases) &&
          work.releases.length <= 10_000,
      );
      if (work.description !== undefined) requireValue(text(work.description, 10_000));
      if (work.tags !== undefined)
        requireValue(Array.isArray(work.tags) && work.tags.length <= 50 && work.tags.every((tag) => text(tag, 100)));
      work.releaseMap = uniqueMap(work.releases);
      for (const release of work.releaseMap.values()) {
        requireValue(
          text(release.title) &&
            Number.isFinite(release.order) &&
            (release.revision === undefined || text(release.revision, 256)),
        );
        requireValue((typeof release.file === 'string') !== (typeof release.contentUrl === 'string'));
        if (release.file !== undefined) {
          requireValue(
            text(release.file, 1_024) &&
              !path.isAbsolute(release.file) &&
              !/^[A-Za-z]:/u.test(release.file) &&
              !release.file.split(/[\\/]/u).includes('..') &&
              /\.txt$/iu.test(release.file),
          );
        } else {
          let url;
          try {
            url = new URL(release.contentUrl);
          } catch {
            requireValue(false);
          }
          requireValue(
            text(release.contentUrl, 2_048) && url.protocol === 'https:' && !url.username && !url.password && !url.hash,
          );
        }
      }
    }
  }
  return {
    instanceId: input.instanceId,
    dataNamespace: input.dataNamespace,
    sources,
    async readFile(release, signal) {
      let target;
      try {
        target = await realpath(path.resolve(root, release.file));
      } catch {
        throw new SourceError(404, 'content_unavailable');
      }
      const relative = path.relative(root, target);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new SourceError(403, 'source_path_rejected');
      let bytes;
      try {
        bytes = await readBoundedFile(target, MAX_CONTENT_BYTES, signal);
      } catch (error) {
        if (error instanceof SourceError || signal?.aborted) throw error;
        throw new SourceError(404, 'content_unavailable');
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new SourceError(422, 'invalid_utf8_content');
      }
      return bytes;
    },
  };
}

export function publicWork(work) {
  return {
    id: work.id,
    title: work.title,
    ...(work.author ? { author: work.author } : {}),
    ...(work.description ? { description: work.description } : {}),
    ...(work.tags ? { tags: work.tags } : {}),
  };
}
