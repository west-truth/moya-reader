import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { joinTask } from './shared-task.mjs';
import { downloadPagesOrdered } from './ordered-page-downloads.mjs';
import { apkStateDirectory } from './installations.mjs';
import {
  MAX_SOURCE_IMAGES,
  MAX_SOURCE_CONTENT_BYTES,
  MAX_SOURCE_ASSET_BYTES,
} from '../../packages/extension-runtime/content-limits.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 20000) => typeof value === 'string' && value.length > 0 && value.length <= max;
const validUrl = (value) => string(value, 8192) && !Array.from(value).some((char) => char.charCodeAt(0) < 32);
const id = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceId = (pkg, remote, namespace = 'moya.apk') => `${namespace}.${hash(pkg).slice(0, 24)}.${remote}`;
const TTL = 10 * 60 * 1000;
const generation = (record) => `${record.digest}:${record.activation ?? 'legacy'}`;

/** Converts APK output to the shared Moya source contract; all remote URLs stay in host-owned reference files. */
export class ApkSourceCatalog {
  #listeners = new Set();
  #workers = new Map();
  #sources = [];
  #pending = new Map();
  constructor(
    store,
    tools,
    {
      maxWorkers = 2,
      namespace = 'moya.apk',
      sourceFile = 'source.jar',
      description = '설치한 APK의 만화 페이지 소스',
      pageConcurrency = 1,
    } = {},
  ) {
    this.store = store;
    this.tools = tools;
    this.maxWorkers = maxWorkers;
    this.namespace = namespace;
    this.sourceFile = sourceFile;
    this.description = description;
    this.pageConcurrency = pageConcurrency;
  }
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSources = () => this.#sources;
  getSource = (id) => this.#sources.find((source) => source.descriptor.id === id);
  async refresh() {
    const records = this.store.snapshot().packages;
    for (const [pkg, worker] of this.#workers) {
      if (
        !records.some(
          (record) => record.pkg === pkg && record.enabled !== false && generation(record) === worker.generation,
        )
      ) {
        worker.process.close();
        this.#workers.delete(pkg);
      }
    }
    this.#sources = records
      .filter((record) => record.enabled !== false)
      .flatMap((record) =>
        record.sources.map((source) => ({
          packageId: record.pkg,
          generation: generation(record),
          descriptor: {
            schemaVersion: 2,
            id: sourceId(record.pkg, source.id, this.namespace),
            title: source.name,
            description: this.description,
            kind: 'catalog',
            capabilities: [
              'browse',
              'search',
              'work-details',
              'release-list',
              'cover-read',
              'file-download',
              'release-download',
              'image-content',
            ],
            runtimes: ['self-host-gateway', 'tauri-native'],
            seriesProfile: { kind: 'image_series', archiveFormat: 'cbz' },
          },
        })),
      );
    for (const listener of this.#listeners) listener();
  }
  async disable(id) {
    const source = this.getSource(id);
    if (!source) return;
    await this.store.setEnabled(source.packageId, false, this.store.snapshot().revision);
    await this.refresh();
  }
  async preferences(pkg, values, signal = new AbortController().signal) {
    const snapshot = this.store.snapshot();
    const record = snapshot.packages.find((p) => p.pkg === pkg);
    if (!record) throw new Error('apk_not_installed');
    const result = await this.#worker(record).request(
      values === undefined ? 'preferences' : 'preferences-save',
      values === undefined ? {} : { values },
      signal,
    );
    const current = this.store.snapshot();
    if (current.revision !== snapshot.revision) throw new Error('apk_install_conflict');
    return { ...result, revision: snapshot.revision, privateOrigins: [], networkPolicy: 'direct' };
  }
  #worker(record) {
    let active = this.#workers.get(record.pkg);
    if (active?.generation === generation(record)) return active.process;
    if (active) {
      active.process.close();
      this.#workers.delete(record.pkg);
    }
    if (this.#workers.size >= this.maxWorkers) {
      const idle = [...this.#workers].find(([, item]) => !item.process.busy);
      if (!idle) throw new Error('apk_worker_busy');
      idle[1].process.close();
      this.#workers.delete(idle[0]);
    }
    const process = this.tools.worker(
      join(this.store.root, 'archives', record.digest, this.sourceFile),
      record,
      apkStateDirectory(this.store.root, record),
    );
    this.#workers.set(record.pkg, { generation: generation(record), process });
    return process;
  }
  async #read(path) {
    try {
      const bytes = await readFile(path);
      if (bytes.length > 32 * 1024 * 1024) throw new Error('apk_reference_limit');
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async #save(path, value) {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw new Error('apk_reference_limit');
    const temp = path + '.' + randomUUID() + '.tmp';
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
  }
  async invoke(contributionId, method, input, signal) {
    signal.throwIfAborted();
    const source = this.getSource(contributionId);
    const record =
      source && this.store.snapshot().packages.find((p) => p.pkg === source.packageId && p.enabled !== false);
    if (!source || !record || generation(record) !== source.generation) throw new Error('package_source_unavailable');
    const remoteId = record.sources.find((s) => sourceId(record.pkg, s.id, this.namespace) === contributionId)?.id;
    const current = (requestSignal = signal) => {
      requestSignal.throwIfAborted();
      const active = this.store.snapshot().packages.find((p) => p.pkg === record.pkg);
      if (!active || active.enabled === false || generation(active) !== source.generation)
        throw new Error('package_generation_changed');
    };
    const request = async (method, params = {}, requestSignal = signal) => {
      current(requestSignal);
      const result = await this.#worker(record).request(method, { ...params, sourceId: remoteId }, requestSignal);
      current(requestSignal);
      return result;
    };
    const directory = join(this.store.root, 'references', hash(contributionId));
    await mkdir(directory, { recursive: true });
    const workPath = (key) => join(directory, `${key}.json`);
    const toWork = (raw) => {
      if (!object(raw) || !validUrl(raw.url) || !string(raw.title, 4096)) throw new Error('apk_work_invalid');
      return {
        id: hash(raw.url),
        title: raw.title,
        ...(string(raw.author, 4096) ? { author: raw.author } : {}),
        ...(string(raw.description) ? { description: raw.description } : {}),
        ...(string(raw.genre)
          ? {
              tags: raw.genre
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
                .slice(0, 64),
            }
          : {}),
        hasCover: validUrl(raw.cover),
      };
    };
    const assets = new Map();
    const asset = (raw) => {
      if (
        !object(raw) ||
        !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(raw.contentType) ||
        !string(raw.base64, 28 * 1024 * 1024) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64)
      )
        throw new Error('apk_image_invalid');
      const bytes = Buffer.from(raw.base64, 'base64');
      if (!bytes.length || bytes.length > MAX_SOURCE_ASSET_BYTES) throw new Error('source_body_limit');
      const digest = hash(bytes);
      const handle = randomUUID();
      const blob = new Blob([bytes], { type: raw.contentType });
      assets.set(handle, blob);
      return { handle, byteLength: bytes.length, sha256: digest, contentType: raw.contentType };
    };
    let result;
    if (method === 'source.listWorks') {
      const browsing = JSON.stringify([
        input.query ?? '',
        input.browseMode ?? (input.query || input.filters?.length ? 'search' : 'popular'),
        input.filters ?? [],
      ]);
      if (typeof input.cursor === 'string' && input.cursor.startsWith('cached:')) {
        const match = /^cached:([a-f0-9]{64}):(\d+)$/.exec(input.cursor);
        if (!match) throw new Error('invalid_source_cursor');
        const cached = await this.#read(join(directory, `page-${match[1]}.json`));
        const offset = Number(match[2]);
        if (
          !cached ||
          cached.generation !== generation(record) ||
          cached.browsing !== browsing ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset >= cached.items.length
        )
          throw new Error('invalid_source_cursor');
        current();
        return {
          result: {
            items: cached.items.slice(offset, offset + 500),
            browse: cached.browse,
            ...(offset + 500 < cached.items.length
              ? { nextCursor: `cached:${match[1]}:${offset + 500}` }
              : cached.next
                ? { nextCursor: cached.next }
                : {}),
          },
          assets,
        };
      }
      const page = input.cursor === undefined ? 1 : Number(input.cursor);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 100000 ||
        (input.query !== undefined && typeof input.query !== 'string')
      )
        throw new Error('invalid_source_invocation');
      const response = await request('list', {
        page,
        query: input.query ?? '',
        mode: input.browseMode ?? (input.query || input.filters?.length ? 'search' : 'popular'),
        filters: input.filters ?? [],
      });
      if (!object(response) || !Array.isArray(response.items) || response.items.length > 5000)
        throw new Error('apk_page_invalid');
      const items = [];
      for (const raw of response.items) {
        const work = toWork(raw);
        current();
        await this.#save(workPath(work.id), { raw, listedAt: Date.now(), generation: generation(record) });
        items.push(work);
      }
      // Source API limits pages to 500. Keep large legacy results available through a host snapshot cursor.
      if (items.length > 500) {
        const key = hash(JSON.stringify([generation(record), browsing, page]));
        await this.#save(join(directory, `page-${key}.json`), {
          items,
          generation: generation(record),
          browsing,
          browse: response.browse,
          next: response.hasNextPage ? String(page + 1) : undefined,
        });
        result = { browse: response.browse, items: items.slice(0, 500), nextCursor: `cached:${key}:500` };
      } else
        result = { items, browse: response.browse, ...(response.hasNextPage ? { nextCursor: String(page + 1) } : {}) };
    } else {
      if (!id(input.workId)) throw new Error('invalid_source_work');
      const saved = await this.#read(workPath(input.workId));
      if (!saved?.raw || hash(saved.raw.url) !== input.workId) throw new Error('source_work_unavailable');
      if (method === 'source.getWork' || method === 'source.getCover') {
        const fresh = (value, time = value?.fetchedAt) =>
          value?.generation === generation(record) && Number.isFinite(time) && time + TTL > Date.now();
        const detailPath = join(directory, `${input.workId}-detail.json`);
        // Separate files avoid list/detail read-modify-write races. Old combined records remain readable.
        let detail = (await this.#read(detailPath)) ?? (saved.fetchedAt > 0 ? saved : undefined);
        const listedCover = fresh(saved, saved.listedAt) && validUrl(saved.raw.cover);
        if (!(method === 'source.getCover' && listedCover) && !fresh(detail)) {
          detail = await joinTask(
            this.#pending,
            `detail:${contributionId}:${generation(record)}:${input.workId}`,
            signal,
            async (sharedSignal) => {
              const cached = await this.#read(detailPath);
              if (fresh(cached)) return cached;
              const raw = await request('detail', { workUrl: saved.raw.url, title: saved.raw.title }, sharedSignal);
              if (!object(raw)) throw new Error('apk_work_invalid');
              const value = {
                raw: {
                  ...saved.raw,
                  ...(saved.generation !== generation(record) ? { cover: undefined } : {}),
                  ...raw,
                  url: saved.raw.url,
                },
                fetchedAt: Date.now(),
                generation: generation(record),
              };
              toWork(value.raw);
              current(sharedSignal);
              await this.#save(detailPath, value);
              return value;
            },
          );
          current();
        }
        const raw = fresh(detail) ? { ...saved.raw, ...detail.raw, url: saved.raw.url } : saved.raw;
        // A refreshed listing can publish a new cover without invalidating unrelated detail fields.
        if (listedCover && (!validUrl(raw.cover) || !fresh(detail) || saved.listedAt >= detail.fetchedAt))
          raw.cover = saved.raw.cover;
        result =
          method === 'source.getWork'
            ? toWork(raw)
            : validUrl(raw.cover)
              ? asset(await request('cover', { url: raw.cover }))
              : null;
      } else if (method === 'source.listReleases' || method === 'source.getContent') {
        const cachePath = join(directory, `${input.workId}-chapters.json`);
        let cache = await this.#read(cachePath);
        if (!cache || cache.generation !== generation(record) || cache.fetchedAt + TTL <= Date.now()) {
          const key = `${contributionId}:${generation(record)}:${input.workId}`;
          cache = await joinTask(this.#pending, key, signal, async (sharedSignal) => {
            const rows = await request('chapters', { workUrl: saved.raw.url, title: saved.raw.title }, sharedSignal);
            if (
              !Array.isArray(rows) ||
              rows.length > 100000 ||
              rows.some((r) => !object(r) || !validUrl(r.url) || !string(r.title, 4096))
            )
              throw new Error('apk_chapters_invalid');
            const value = { rows: [...rows].reverse(), fetchedAt: Date.now(), generation: generation(record) };
            await this.#save(cachePath, value);
            return value;
          });
          current();
        }
        if (method === 'source.listReleases') {
          const offset = input.cursor === undefined ? 0 : Number(input.cursor);
          if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_source_cursor');
          result = {
            items: cache.rows.slice(offset, offset + 500).map((row, index) => ({
              id: hash(row.url),
              title: row.title,
              order: offset + index,
              ...(Number.isFinite(row.number) && row.number >= 0 ? { number: row.number } : {}),
            })),
            ...(offset + 500 < cache.rows.length ? { nextCursor: String(offset + 500) } : {}),
          };
        } else {
          const chapter = cache.rows.find((row) => hash(row.url) === input.releaseId);
          if (!chapter) throw new Error('source_release_unavailable');
          const pages = await request('pages', { chapterUrl: chapter.url, title: chapter.title });
          if (!Array.isArray(pages) || !pages.length || pages.length > MAX_SOURCE_IMAGES)
            throw new Error('apk_page_limit');
          let total = 0;
          const refs = await downloadPagesOrdered(pages, this.pageConcurrency, signal, async (page, pageSignal) => {
            const ref = asset(await request('image', page, pageSignal));
            total += ref.byteLength;
            if (total > MAX_SOURCE_CONTENT_BYTES) throw new Error('source_body_limit');
            return ref;
          });
          result = { kind: 'images', assets: refs };
        }
      } else throw new Error('invalid_source_invocation');
    }
    current();
    return { result, assets };
  }
  close() {
    for (const worker of this.#workers.values()) worker.process.close();
    this.#workers.clear();
    this.#listeners.clear();
  }
}
