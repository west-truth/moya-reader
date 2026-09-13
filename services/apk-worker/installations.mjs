import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const signerKey = (value) => [...value].sort().join(':');
// Updates keep their settings; a new installation never inherits a removed publisher's credentials.
export const apkStateDirectory = (root, record) =>
  join(root, 'state', sha(record.stateId ? `${record.pkg}:${record.stateId}` : record.pkg));
/** Host-owned APK inventory. Reader/library data never live here; switching versions is one atomic inventory write. */
export class ApkInstallations {
  #state = { version: 1, revision: 0, packages: [] };
  #plans = new Map();
  #chain = Promise.resolve();
  constructor(root, tools) {
    this.root = root;
    this.tools = tools;
  }
  async open() {
    await mkdir(this.root, { recursive: true });
    try {
      const bytes = await readFile(join(this.root, 'inventory.json'));
      if (bytes.length > 4 * 1024 * 1024) throw new Error('apk_inventory_invalid');
      const state = JSON.parse(bytes.toString('utf8'));
      if (
        state.version !== 1 ||
        !Number.isSafeInteger(state.revision) ||
        !Array.isArray(state.packages) ||
        state.packages.length > 256 ||
        new Set(state.packages.map((p) => p.pkg)).size !== state.packages.length ||
        state.packages.some((p) => !validRecord(p))
      )
        throw new Error('apk_inventory_invalid');
      this.#state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  #exclusive(task) {
    const result = this.#chain.then(task);
    this.#chain = result.catch(() => {});
    return result;
  }
  async inspect(bytes, advertised, signal = new AbortController().signal) {
    signal.throwIfAborted();
    for (const [id, plan] of this.#plans) if (plan.expires < Date.now()) this.#plans.delete(id);
    if (bytes.length < 4 || bytes.length > 32 * 1024 * 1024) throw new Error('apk_size_limit');
    if (this.#plans.size >= 4) throw new Error('apk_review_limit');
    const digest = sha(bytes);
    const folder = join(this.root, 'archives', digest);
    await mkdir(folder, { recursive: true });
    const archive = join(folder, 'extension.apk');
    await writeFile(archive, bytes, { flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (sha(await readFile(archive)) !== digest) throw new Error('apk_archive_integrity');
    const metadata = await this.tools.inspect(archive, signal);
    if (
      !validMetadata(metadata) ||
      (advertised !== undefined &&
        (metadata.pkg !== advertised.pkg ||
          metadata.code !== advertised.code ||
          metadata.version !== advertised.version))
    )
      throw new Error('apk_index_mismatch');
    signal.throwIfAborted();
    const installed = this.#state.packages.find((p) => p.pkg === metadata.pkg);
    if (installed && signerKey(installed.signers) !== signerKey(metadata.signers))
      throw new Error('apk_publisher_changed');
    if (installed && metadata.code <= installed.code) throw new Error('apk_version_not_newer');
    const plan = {
      id: randomUUID(),
      revision: this.#state.revision,
      digest,
      metadata,
      expires: Date.now() + 15 * 60 * 1000,
    };
    this.#plans.set(plan.id, plan);
    return structuredClone({ id: plan.id, revision: plan.revision, digest, ...metadata });
  }
  discard(id) {
    this.#plans.delete(id);
  }
  install(id, expectedRevision, signal = new AbortController().signal) {
    return this.#exclusive(async () => {
      const plan = this.#plans.get(id);
      if (!plan || plan.expires < Date.now()) {
        this.#plans.delete(id);
        throw new Error('apk_review_expired');
      }
      if (plan.revision !== expectedRevision || this.#state.revision !== expectedRevision)
        throw new Error('apk_install_conflict');
      const previous = this.#state.packages.find((p) => p.pkg === plan.metadata.pkg);
      if (!previous && this.#state.packages.length >= 256) throw new Error('apk_install_limit');
      signal.throwIfAborted();
      const folder = join(this.root, 'archives', plan.digest);
      const archive = join(folder, 'extension.apk');
      if (sha(await readFile(archive)) !== plan.digest) throw new Error('apk_archive_integrity');
      await this.tools.convert(archive, join(folder, 'source.jar'), signal);
      const stateId = previous ? previous.stateId : randomUUID();
      const stateDirectory = apkStateDirectory(this.root, { ...plan.metadata, stateId });
      await mkdir(stateDirectory, { recursive: true });
      const sources = await this.tools.describe(join(folder, 'source.jar'), plan.metadata, stateDirectory, signal);
      if (
        !Array.isArray(sources) ||
        !sources.length ||
        sources.length > 1000 ||
        new Set(sources.map((s) => s.id)).size !== sources.length ||
        sources.some((s) => !validSource(s))
      )
        throw new Error('apk_sources_invalid');
      signal.throwIfAborted();
      const record = {
        ...plan.metadata,
        enabled: true,
        activation: randomUUID(),
        ...(stateId ? { stateId } : {}),
        digest: plan.digest,
        sources,
        ...(previous ? { previousDigest: previous.digest } : {}),
      };
      const next = {
        version: 1,
        revision: this.#state.revision + 1,
        packages: [...this.#state.packages.filter((p) => p.pkg !== record.pkg), record],
      };
      await this.#save(next);
      this.#plans.delete(id);
      this.tools.changed?.(record.pkg);
      return this.snapshot();
    });
  }
  remove(pkg, revision) {
    return this.#exclusive(async () => {
      if (revision !== this.#state.revision) throw new Error('apk_install_conflict');
      if (!this.#state.packages.some((p) => p.pkg === pkg)) throw new Error('apk_not_installed');
      await this.#save({
        ...this.#state,
        revision: revision + 1,
        packages: this.#state.packages.filter((p) => p.pkg !== pkg),
      });
      this.tools.changed?.(pkg);
    });
  }
  setEnabled(pkg, enabled, revision) {
    return this.#exclusive(async () => {
      if (revision !== this.#state.revision) throw new Error('apk_install_conflict');
      if (!this.#state.packages.some((p) => p.pkg === pkg)) throw new Error('apk_not_installed');
      await this.#save({
        ...this.#state,
        revision: revision + 1,
        packages: this.#state.packages.map((p) =>
          p.pkg === pkg ? { ...p, enabled: !!enabled, activation: randomUUID() } : p,
        ),
      });
      this.tools.changed?.(pkg);
    });
  }
  updatePreferences(pkg, revision, save) {
    return this.#exclusive(async () => {
      const record = this.#state.packages.find((p) => p.pkg === pkg);
      if (!record || revision !== this.#state.revision) throw new Error('apk_install_conflict');
      // Fence in-flight results before saving. Even a rejected preference callback invalidates the
      // old worker; an inventory write failure must never happen after credentials were committed.
      await this.#save({
        ...this.#state,
        revision: revision + 1,
        packages: this.#state.packages.map((p) => (p.pkg === pkg ? { ...p, activation: randomUUID() } : p)),
      });
      try {
        await save(this.#state.packages.find((p) => p.pkg === pkg));
      } finally {
        this.tools.changed?.(pkg);
      }
    });
  }
  async #save(next) {
    const staged = join(this.root, `inventory-${randomUUID()}.tmp`);
    await writeFile(staged, JSON.stringify(next), { mode: 0o600 });
    await rename(staged, join(this.root, 'inventory.json'));
    this.#state = next;
  }
}
function validMetadata(p) {
  return (
    p &&
    typeof p.pkg === 'string' &&
    /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(p.pkg) &&
    p.pkg.length <= 256 &&
    typeof p.entry === 'string' &&
    p.entry.startsWith(p.pkg + '.') &&
    /^[A-Za-z_$][A-Za-z0-9_$.]+$/.test(p.entry) &&
    Number.isSafeInteger(p.code) &&
    p.code > 0 &&
    typeof p.version === 'string' &&
    p.version.length <= 64 &&
    Array.isArray(p.signers) &&
    p.signers.length > 0 &&
    p.signers.length <= 16 &&
    p.signers.every((s) => /^[a-f0-9]{64}$/.test(s))
  );
}
function validSource(s) {
  return (
    s &&
    typeof s.id === 'string' &&
    /^[1-9]\d{0,18}$/.test(s.id) &&
    BigInt(s.id) <= 9223372036854775807n &&
    typeof s.name === 'string' &&
    s.name.length > 0 &&
    s.name.length <= 512 &&
    typeof s.lang === 'string' &&
    s.lang.length <= 32
  );
}
function validRecord(p) {
  return (
    validMetadata(p) &&
    (p.stateId === undefined || /^[a-f0-9-]{36}$/.test(p.stateId)) &&
    /^[a-f0-9]{64}$/.test(p.digest) &&
    Array.isArray(p.sources) &&
    p.sources.length <= 1000 &&
    p.sources.every(validSource)
  );
}
