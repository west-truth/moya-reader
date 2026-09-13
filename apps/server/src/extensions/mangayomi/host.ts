import {
  SOURCE_BROWSER_MODE_KEY,
  sourceBrowserMode,
  sourceBrowserModeField,
  type SourceBrowserMode,
} from '../source-browser-mode.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ApkSourceCatalog } from '../../../../../services/apk-worker/catalog.mjs';
import type { ApkRecord } from '../../../../../services/apk-worker/installations.mjs';
import {
  compatibilityRepositoryUrl,
  parseMangayomiIndex,
  type MangayomiEntry,
} from '../../../../../packages/extension-contracts/compatibility-repository.js';
import type { SourceCredentialVault } from '../source-credential-vault.js';
import { compatibilityHttp } from './http.js';
import { invokeMangayomi, type PreferenceValues } from './runtime.js';
import { sourceWebViewHost } from '../source-webview.js';
import { sourceBrowserHttp } from '../source-browser-cookies.js';
import { preferenceSchema, validatePreferenceChanges } from './preferences.js';
import { OUTBOUND_PROXY_KEY, parseOutboundProxy } from '../outbound-proxy.js';
import type { CompatibilityPreference } from '../../../../../src/extensions/packages/compatibility-preferences.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const packageId = (url: string, id: string) => `org.moya.mangayomi.r${hash(url).slice(0, 24)}.s${id}`;
const code = (entry: MangayomiEntry) => parseInt(hash(entry.version + entry.sourceCodeUrl).slice(0, 12), 16) + 1;
interface RecordEntry extends ApkRecord {
  metadata: MangayomiEntry;
  activation: string;
  preferenceEpoch: string;
  fields: CompatibilityPreference[];
  repository: string;
}
interface Inventory {
  version: 1;
  revision: number;
  packages: RecordEntry[];
  repositories: { url: string; updatedAt: number; entries: MangayomiEntry[] }[];
}
interface StoredOptions {
  browserMode?: SourceBrowserMode;
  outboundProxy?: string;
  values: PreferenceValues;
  privateOrigins: string[];
}
const scope = (record: RecordEntry) => JSON.stringify([record.pkg, 'mangayomi-options', record.preferenceEpoch]);

/** Original JS stays host-private and is executed only after review in the bounded compatibility realm. */
export class MangayomiExtensionHost {
  readonly catalog: ApkSourceCatalog;
  private state: Inventory = { version: 1, revision: 0, packages: [], repositories: [] };
  private plans = new Map<
    string,
    { revision: number; digest: string; metadata: MangayomiEntry; repository: string; source: string; expires: number }
  >();
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly root: string,
    private vault: SourceCredentialVault,
    private transport = compatibilityHttp,
  ) {
    const store = {
      root,
      snapshot: () => structuredClone(this.state),
      setEnabled: (pkg: string, enabled: boolean, revision: number) =>
        this.change(pkg, revision, enabled ? 'enable' : 'disable'),
    };
    this.catalog = new ApkSourceCatalog(
      store,
      {
        worker: (_archive, metadata) => {
          let closed = false,
            busy = 0;
          const lifetime = new AbortController();
          return {
            get busy() {
              return busy > 0;
            },
            close() {
              closed = true;
              lifetime.abort();
            },
            request: async (method, params, signal = new AbortController().signal) => {
              if (closed) throw new Error('package_generation_changed');
              busy++;
              try {
                return await this.request(
                  metadata.pkg,
                  method,
                  params ?? {},
                  AbortSignal.any([signal, lifetime.signal]),
                );
              } finally {
                busy--;
              }
            },
          };
        },
      },
      {
        namespace: 'moya.mangayomi',
        sourceFile: 'source.js',
        description: 'Mangayomi JavaScript 이미지 소스',
        pageConcurrency: 3,
      },
    );
  }
  static async open(root: string, vault: SourceCredentialVault, transport = compatibilityHttp) {
    const host = new MangayomiExtensionHost(root, vault, transport);
    await mkdir(root, { recursive: true });
    try {
      const bytes = await readFile(join(root, 'inventory.json'));
      if (bytes.length > 8 * 1024 * 1024) throw new Error('compatibility_inventory_invalid');
      const state = JSON.parse(bytes.toString('utf8'));
      if (
        state.version !== 1 ||
        !Number.isSafeInteger(state.revision) ||
        !Array.isArray(state.packages) ||
        state.packages.length > 256 ||
        !Array.isArray(state.repositories) ||
        state.repositories.length > 16 ||
        state.packages.some(
          (p: RecordEntry) =>
            !/^org\.moya\.mangayomi\.r[a-f0-9]{24}\.s\d{1,19}$/.test(p.pkg) || !/^[a-f0-9]{64}$/.test(p.digest),
        )
      )
        throw new Error('compatibility_inventory_invalid');
      host.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await host.catalog.refresh();
    return host;
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.catch(() => {});
    return result;
  }
  private async save(next: Inventory) {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('compatibility_inventory_limit');
    const file = join(this.root, `inventory-${randomUUID()}.tmp`);
    await writeFile(file, bytes, { mode: 0o600 });
    await rename(file, join(this.root, 'inventory.json'));
    this.state = next;
  }
  snapshot() {
    return {
      available: true,
      version: 1 as const,
      revision: this.state.revision,
      packages: this.state.packages.map(
        ({
          fields: _fields,
          metadata: _metadata,
          preferenceEpoch: _preferenceEpoch,
          repository: _repository,
          ...record
        }) => record,
      ),
      repositories: this.state.repositories.map((repo) => ({
        ...repo,
        entries: repo.entries.map((entry) => ({
          pkg: packageId(repo.url, entry.id),
          name: entry.name,
          apk: entry.sourceCodeUrl,
          version: entry.version,
          code: code(entry),
          lang: entry.lang,
          nsfw: entry.isNsfw,
          sources: [{ id: entry.id, name: entry.name, lang: entry.lang }],
          excludedSources: 0,
          format: entry.format,
          appMinVerReq: entry.appMinVerReq,
          hasCloudflare: entry.hasCloudflare,
        })),
      })),
    };
  }
  async refreshRepository(value: string, signal: AbortSignal) {
    const url = compatibilityRepositoryUrl(value),
      revision = this.state.revision;
    const response = await this.transport({ url }, signal, [], 4 * 1024 * 1024);
    if (response.statusCode !== 200) throw new Error('source_http_failed');
    const entries = parseMangayomiIndex(JSON.parse(response.bytes.toString('utf8')));
    await this.exclusive(async () => {
      if (revision !== this.state.revision) throw new Error('apk_repository_conflict');
      const repositories = [
        ...this.state.repositories.filter((r) => r.url !== url),
        { url, entries, updatedAt: Date.now() },
      ];
      if (repositories.length > 16) throw new Error('apk_repository_limit');
      await this.save({ ...this.state, revision: revision + 1, repositories });
    });
  }
  async removeRepository(value: string) {
    const url = compatibilityRepositoryUrl(value);
    await this.exclusive(() =>
      this.save({
        ...this.state,
        revision: this.state.revision + 1,
        repositories: this.state.repositories.filter((r) => r.url !== url),
      }),
    );
  }
  async inspectFile(bytes: Uint8Array, name: string, sourceIndex: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!/\.js$/i.test(name) || !bytes.length || bytes.length > 1024 * 1024)
      throw new Error('compatibility_file_invalid');
    for (const [id, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 4) throw new Error('apk_review_limit');
    const revision = this.state.revision;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const repository = 'https://local-file.invalid/index.json';
    const placeholder: MangayomiEntry = {
      id: '1',
      name,
      lang: 'all',
      version: '0',
      baseUrl: 'https://local-file.invalid',
      sourceCodeUrl: 'https://local-file.invalid/source.js',
      format: 'mangayomi-js',
      isNsfw: false,
      hasCloudflare: false,
    };
    const { result } = await invokeMangayomi({ entry: placeholder, source, action: 'metadata', signal });
    if (!Array.isArray(result) || !result.length || result.length > 256 || sourceIndex >= result.length)
      throw new Error('compatibility_file_invalid');
    const entries = parseMangayomiIndex(
      result.map((row) => ({
        ...row,
        id: String(BigInt('0x' + hash(JSON.stringify([row.baseUrl, row.name, row.lang])).slice(0, 15))),
        sourceCodeUrl: 'https://local-file.invalid/' + encodeURIComponent(String(row.pkgPath ?? name)),
        sourceCodeLanguage: 1,
      })),
    );
    const metadata = entries[sourceIndex];
    const pkg = packageId(repository, metadata.id),
      digest = hash(bytes);
    const previous = this.state.packages.find((record) => record.pkg === pkg);
    if (
      previous &&
      (previous.digest === digest || metadata.version.localeCompare(previous.version, 'en', { numeric: true }) < 0)
    )
      throw new Error('apk_version_not_newer');
    signal.throwIfAborted();
    if (revision !== this.state.revision) throw new Error('apk_install_conflict');
    const id = randomUUID();
    this.plans.set(id, { revision, digest, metadata, repository, source, expires: Date.now() + 900000 });
    return {
      id,
      revision,
      digest,
      pkg,
      version: metadata.version,
      signers: [],
      format: 'mangayomi-js' as const,
      origin: 'Local file',
      sourceIndex,
      fileSources: entries.map((entry) => ({ name: entry.name, lang: entry.lang })),
    };
  }
  async inspect(value: string, pkg: string, versionCode: number, signal: AbortSignal) {
    signal.throwIfAborted();
    for (const [id, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 4) throw new Error('apk_review_limit');
    const url = compatibilityRepositoryUrl(value),
      revision = this.state.revision;
    const entry = this.state.repositories
      .find((r) => r.url === url)
      ?.entries.find((e) => packageId(url, e.id) === pkg && code(e) === versionCode);
    if (!entry) throw new Error('apk_repository_conflict');
    if (entry.format !== 'mangayomi-js') throw new Error('compatibility_feature_unsupported');
    const old = this.state.packages.find((p) => p.pkg === pkg);
    if (old && entry.version.localeCompare(old.version, 'en', { numeric: true }) < 0)
      throw new Error('apk_version_not_newer');
    if (old && new URL(old.metadata.sourceCodeUrl).origin !== new URL(entry.sourceCodeUrl).origin)
      throw new Error('apk_publisher_changed');
    const response = await this.transport({ url: entry.sourceCodeUrl }, signal, [], 1024 * 1024);
    signal.throwIfAborted();
    if (response.statusCode !== 200) throw new Error('source_http_failed');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
      digest = hash(response.bytes);
    if (!/class\s+DefaultExtension\s+extends\s+MProvider\b/.test(source))
      throw new Error('compatibility_feature_unsupported');
    if (revision !== this.state.revision) throw new Error('apk_repository_conflict');
    if (old?.digest === digest) throw new Error('apk_version_not_newer');
    const id = randomUUID();
    this.plans.set(id, { revision, digest, metadata: entry, repository: url, source, expires: Date.now() + 900000 });
    return {
      id,
      revision,
      digest,
      pkg,
      version: entry.version,
      signers: [],
      format: 'mangayomi-js',
      origin: new URL(entry.sourceCodeUrl).origin,
    };
  }
  async install(id: string, revision: number, signal: AbortSignal) {
    await this.exclusive(async () => {
      const plan = this.plans.get(id);
      if (!plan || plan.expires < Date.now()) throw new Error('apk_review_expired');
      if (revision !== this.state.revision || plan.revision !== revision) throw new Error('apk_install_conflict');
      const pkg = packageId(plan.repository, plan.metadata.id),
        previous = this.state.packages.find((p) => p.pkg === pkg);
      if (!previous && this.state.packages.length >= 256) throw new Error('compatibility_inventory_limit');
      const { result } = await invokeMangayomi({
        entry: plan.metadata,
        source: plan.source,
        action: 'preferences',
        signal,
      });
      const fields = preferenceSchema(result);
      const directory = join(this.root, 'archives', plan.digest);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'source.js'), plan.source, { mode: 0o600 });
      signal.throwIfAborted();
      const record: RecordEntry = {
        pkg,
        entry: plan.metadata.sourceCodeUrl,
        code: code(plan.metadata),
        version: plan.metadata.version,
        signers: [],
        digest: plan.digest,
        enabled: true,
        activation: randomUUID(),
        sources: [{ id: plan.metadata.id, name: plan.metadata.name, lang: plan.metadata.lang }],
        metadata: plan.metadata,
        fields,
        repository: plan.repository,
        preferenceEpoch: previous?.preferenceEpoch ?? randomUUID(),
      };
      await this.save({
        ...this.state,
        revision: revision + 1,
        packages: [...this.state.packages.filter((p) => p.pkg !== pkg), record],
      });
      this.plans.delete(id);
    });
    await this.catalog.refresh();
  }
  discard(id: string) {
    this.plans.delete(id);
  }
  async change(pkg: string, revision: number, action: 'enable' | 'disable' | 'remove') {
    await this.exclusive(async () => {
      if (revision !== this.state.revision) throw new Error('apk_install_conflict');
      if (!this.state.packages.some((p) => p.pkg === pkg)) throw new Error('apk_not_installed');
      await this.save({
        ...this.state,
        revision: revision + 1,
        packages:
          action === 'remove'
            ? this.state.packages.filter((p) => p.pkg !== pkg)
            : this.state.packages.map((p) =>
                p.pkg === pkg ? { ...p, enabled: action === 'enable', activation: randomUUID() } : p,
              ),
      });
      if (action === 'remove') this.vault.retain?.(pkg, undefined);
    });
    await this.catalog.refresh();
  }
  private options(record: RecordEntry): StoredOptions {
    const stored = this.vault.read(scope(record));
    return stored ? JSON.parse(stored.secret) : { values: {}, privateOrigins: [] };
  }
  preferences(pkg: string) {
    const record = this.state.packages.find((p) => p.pkg === pkg);
    if (!record) throw new Error('apk_not_installed');
    const options = this.options(record);
    return {
      revision: this.state.revision,
      privateOrigins: options.privateOrigins,
      fields: [
        sourceBrowserModeField(options.browserMode),
        {
          key: OUTBOUND_PROXY_KEY,
          title: '요청에 사용할 프록시 (선택)',
          kind: 'text' as const,
          secret: false,
          value: options.outboundProxy ?? '',
          summary:
            '비워두면 기존 연결을 사용합니다. HTTP·HTTPS·SOCKS5 주소를 입력하세요. 서버 실행 시 주소는 서버 기준이며, 운영체제의 VPN 경로와 DNS 설정은 유지됩니다.',
        },
        ...record.fields
          .filter((field) => field.key !== OUTBOUND_PROXY_KEY && field.key !== SOURCE_BROWSER_MODE_KEY)
          .map((field) => {
            const value = options.values[field.key] ?? field.value;
            return field.secret ? { ...field, value: undefined, configured: !!value } : { ...field, value };
          }),
      ],
    };
  }
  async savePreferences(pkg: string, revision: number, changes: unknown, privateOrigins: unknown) {
    validatePreferenceChanges(changes);
    if (
      !Array.isArray(privateOrigins) ||
      privateOrigins.length > 16 ||
      privateOrigins.some(
        (origin) =>
          typeof origin !== 'string' ||
          origin.length > 2048 ||
          new URL(origin).origin !== origin ||
          !/^https?:/.test(origin),
      )
    )
      throw new Error('compatibility_preferences_invalid');
    await this.exclusive(async () => {
      const record = this.state.packages.find((p) => p.pkg === pkg);
      if (!record || revision !== this.state.revision) throw new Error('apk_install_conflict');
      if (
        Object.entries(changes).some(([key, value]) => {
          if (key === SOURCE_BROWSER_MODE_KEY) {
            sourceBrowserMode(value);
            return false;
          }
          if (key === OUTBOUND_PROXY_KEY) {
            parseOutboundProxy(value);
            return false;
          }
          const field = record.fields.find((f) => f.key === key);
          return (
            !field ||
            (value !== null &&
              (field.kind === 'boolean'
                ? typeof value !== 'boolean'
                : field.kind === 'select'
                  ? !field.choices?.some((c) => c.value === value)
                  : typeof value !== 'string'))
          );
        })
      )
        throw new Error('compatibility_preferences_invalid');
      const options = this.options(record);
      for (const [key, value] of Object.entries(changes)) {
        if (key === SOURCE_BROWSER_MODE_KEY) {
          options.browserMode = sourceBrowserMode(value);
          continue;
        }
        if (key === OUTBOUND_PROXY_KEY) {
          options.outboundProxy = parseOutboundProxy(value);
          continue;
        }
        if (value === null) delete options.values[key];
        else options.values[key] = value;
      }
      validatePreferenceChanges(options.values);
      options.privateOrigins = privateOrigins;
      const next = { ...record, preferenceEpoch: randomUUID(), activation: randomUUID() };
      this.vault.write(scope(next), { secret: JSON.stringify(options) });
      await this.save({
        ...this.state,
        revision: revision + 1,
        packages: this.state.packages.map((p) => (p.pkg === pkg ? next : p)),
      });
      this.vault.retain?.(pkg, next.preferenceEpoch);
    });
    await this.catalog.refresh();
  }
  private async request(
    pkg: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const record = this.state.packages.find((p) => p.pkg === pkg && p.enabled);
    if (!record) throw new Error('package_source_unavailable');
    const options = this.options(record);
    const source = await readFile(join(this.root, 'archives', record.digest, 'source.js'), 'utf8');
    const browserScope = {
      key: JSON.stringify([record.pkg, 'browser', record.preferenceEpoch]),
      vault: this.vault,
      privateOrigins: options.privateOrigins,
      outboundProxy: options.outboundProxy,
      browserMode: options.browserMode,
    };
    if (hash(source) !== record.digest) throw new Error('package_repository_integrity');
    if (method === 'image' || method === 'cover') {
      const headers =
        method === 'image' && params.headers && typeof params.headers === 'object'
          ? params.headers
          : (
              await invokeMangayomi({
                entry: record.metadata,
                source,
                action: 'headers',
                params: { url: params.imageUrl ?? params.url },
                preferences: options.values,
                signal,
              })
            ).result;
      const response = await sourceBrowserHttp(
        { url: String(params.imageUrl ?? params.url), headers: headers as Record<string, string> },
        signal,
        browserScope,
        20 * 1024 * 1024,
        this.transport,
        true,
      );
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new Error(
          response.statusCode === 401 || response.statusCode === 403 ? 'source_auth_required' : 'source_http_failed',
        );
      const bytes = response.bytes;
      const type =
        bytes[0] === 255 && bytes[1] === 216
          ? 'image/jpeg'
          : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? 'image/png'
            : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
              ? 'image/gif'
              : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
                ? 'image/webp'
                : undefined;
      if (!type) throw new Error('invalid_source_assets');
      return { contentType: type, base64: bytes.toString('base64') };
    }
    const output = await invokeMangayomi(
      {
        entry: record.metadata,
        source,
        action: method,
        params,
        preferences: options.values,
        privateOrigins: options.privateOrigins,
        webview: (request, requestSignal) =>
          sourceWebViewHost.evaluate(
            request,
            {
              key: JSON.stringify([record.pkg, 'browser', record.preferenceEpoch]),
              vault: this.vault,
              privateOrigins: options.privateOrigins,
              outboundProxy: options.outboundProxy,
              browserMode: options.browserMode,
            },
            requestSignal,
          ),
        signal,
      },
      (input, requestSignal, _origins, maximum) =>
        sourceBrowserHttp(input, requestSignal, browserScope, maximum ?? 768 * 1024, this.transport, true),
    );
    validatePreferenceChanges(output.changes);
    if (Object.keys(output.changes).length)
      await this.exclusive(async () => {
        const active = this.state.packages.find((p) => p.pkg === pkg);
        if (active?.activation !== record.activation) throw new Error('package_generation_changed');
        const updated = this.options(active);
        for (const [key, value] of Object.entries(output.changes)) {
          if (value === null) delete updated.values[key];
          else updated.values[key] = value;
        }
        validatePreferenceChanges(updated.values);
        this.vault.write(scope(active), { secret: JSON.stringify(updated) });
      });
    const result = output.result as Record<string, unknown>;
    const work = (row: Record<string, unknown>) => ({
      url: row.link ?? row.url,
      title: row.name ?? row.title,
      cover: row.imageUrl,
      author: row.author,
      description: row.description,
      genre: Array.isArray(row.genre) ? row.genre.join(',') : undefined,
    });
    if (method === 'list') {
      if (!result || !Array.isArray(result.list)) throw new Error('invalid_source_result');
      return { items: result.list.map(work), hasNextPage: result.hasNextPage === true, browse: result.browse };
    }
    if (method === 'detail') return work({ ...result, link: params.workUrl });
    if (method === 'chapters') {
      const rows = result.chapters ?? result.episodes;
      if (!Array.isArray(rows)) throw new Error('invalid_source_result');
      return rows.map((row) => ({
        url: row.url,
        title: row.name,
        number: Number(row.chapterNumber ?? row.number ?? -1),
      }));
    }
    if (method === 'pages') {
      if (!Array.isArray(output.result)) throw new Error('invalid_source_result');
      return output.result.map((row, index) => ({
        index,
        url: '',
        imageUrl: typeof row === 'string' ? row : row.url,
        headers: typeof row === 'string' ? undefined : row.headers,
      }));
    }
    throw new Error('compatibility_feature_unsupported');
  }
  close() {
    this.catalog.close();
  }
}
