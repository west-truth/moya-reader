import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createSourceBroker } from '@moya/extension-runtime/source-broker';
import {
  parseMangaApkIndex,
  mangaApkRepositoryUrl,
  mangaApkDownloadUrl,
} from '../../../../packages/extension-contracts/apk-repository.js';
import { ApkInstallations } from '../../../../services/apk-worker/installations.mjs';
import { ApkSourceCatalog } from '../../../../services/apk-worker/catalog.mjs';
import { createJavaApkTools } from '../../../../services/apk-worker/java-tools.mjs';
import type { ApkRepositoryRecord } from '../../../../src/extensions/packages/apk-extension-manager.js';

export class ApkExtensionHost {
  private repositories: ApkRepositoryRecord[] = [];
  private epoch = 0;
  private saving: Promise<void> = Promise.resolve();
  private constructor(
    readonly store: ApkInstallations,
    readonly catalog: ApkSourceCatalog,
  ) {}
  static async open(java: string, build: string, root: string) {
    const tools = await createJavaApkTools(java, build);
    const store = await new ApkInstallations(root, tools).open();
    const catalog = new ApkSourceCatalog(store, tools);
    const host = new ApkExtensionHost(store, catalog);
    try {
      const data = await readFile(join(root, 'repositories.json'));
      if (data.length > 16 * 1024 * 1024) throw new Error('apk_repository_limit');
      const rows: unknown = JSON.parse(data.toString('utf8'));
      if (!Array.isArray(rows) || rows.length > 16) throw new Error('apk_repository_invalid');
      host.repositories = rows.map((row) => ({
        url: mangaApkRepositoryUrl(row.url),
        updatedAt: Number(row.updatedAt),
        entries: parseMangaApkIndex(
          row.entries.map((entry: { nsfw: boolean }) => ({ ...entry, nsfw: entry.nsfw ? 1 : 0 })),
        ).entries,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await catalog.refresh();
    return host;
  }
  snapshot() {
    return { available: true, ...this.store.snapshot(), repositories: this.repositories };
  }
  private async download(url: string, signal: AbortSignal) {
    const broker = createSourceBroker({ origins: [new URL(url).origin], allowDownloads: true });
    try {
      // Binary transport also supports indexes larger than the guest text-response limit.
      const asset = (await broker.methods['http.request']({ url, response: 'asset' }, signal)) as { handle: string };
      return broker.takeAsset(asset.handle).bytes;
    } finally {
      broker.dispose();
    }
  }
  async refreshRepository(value: string, signal: AbortSignal) {
    const url = mangaApkRepositoryUrl(value);
    const epoch = this.epoch;
    if (this.repositories.length >= 16 && !this.repositories.some((row) => row.url === url))
      throw new Error('apk_repository_limit');
    const bytes = await this.download(url, signal);
    const index = parseMangaApkIndex(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    signal.throwIfAborted();
    if (epoch !== this.epoch) throw new Error('apk_repository_conflict');
    await this.saveRepositories(
      [...this.repositories.filter((row) => row.url !== url), { url, entries: index.entries, updatedAt: Date.now() }],
      epoch,
    );
  }
  async removeRepository(value: string) {
    const url = mangaApkRepositoryUrl(value);
    await this.saveRepositories(
      this.repositories.filter((row) => row.url !== url),
      this.epoch,
    );
  }
  private saveRepositories(next: ApkRepositoryRecord[], expected: number) {
    const task = this.saving.then(async () => {
      if (this.epoch !== expected) throw new Error('apk_repository_conflict');
      const bytes = JSON.stringify(next);
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('apk_repository_limit');
      await mkdir(this.store.root, { recursive: true });
      const file = join(this.store.root, `repositories-${randomUUID()}.tmp`);
      await writeFile(file, bytes, { mode: 0o600 });
      await rename(file, join(this.store.root, 'repositories.json'));
      this.repositories = next;
      this.epoch++;
    });
    this.saving = task.catch(() => {});
    return task;
  }
  inspectFile(bytes: Uint8Array, name: string, _sourceIndex: number, signal: AbortSignal) {
    if (!/\.apk$/i.test(name)) throw new Error('compatibility_file_invalid');
    return this.store.inspect(bytes, undefined, signal);
  }
  async inspect(value: string, pkg: string, code: number, signal: AbortSignal) {
    const url = mangaApkRepositoryUrl(value);
    const epoch = this.epoch;
    const entry = this.repositories
      .find((row) => row.url === url)
      ?.entries.find((row) => row.pkg === pkg && row.code === code);
    if (!entry) throw new Error('apk_repository_conflict');
    const bytes = await this.download(mangaApkDownloadUrl(url, entry), signal);
    signal.throwIfAborted();
    if (epoch !== this.epoch) throw new Error('apk_repository_conflict');
    return this.store.inspect(bytes, entry, signal);
  }
  async install(id: string, revision: number, signal: AbortSignal) {
    await this.store.install(id, revision, signal);
    await this.catalog.refresh();
  }
  discard(id: string) {
    this.store.discard(id);
  }
  async change(pkg: string, revision: number, action: 'enable' | 'disable' | 'remove') {
    if (action === 'remove') await this.store.remove(pkg, revision);
    else await this.store.setEnabled(pkg, action === 'enable', revision);
    await this.catalog.refresh();
  }
  close() {
    this.catalog.close();
  }
  preferences(pkg: string) {
    return this.catalog.preferences(pkg);
  }
  async savePreferences(pkg: string, revision: number, values: unknown, privateOrigins: unknown) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Buffer.byteLength(JSON.stringify(values)) > 48 * 1024 ||
      Object.keys(values).length > 128 ||
      !Array.isArray(privateOrigins) ||
      privateOrigins.length ||
      Object.entries(values).some(
        ([key, value]) =>
          key.length > 512 || !(typeof value === 'boolean' || (typeof value === 'string' && value.length <= 4096)),
      )
    )
      throw new Error('compatibility_preferences_invalid');
    try {
      await this.store.updatePreferences(pkg, revision, async () => {
        await this.catalog.preferences(pkg, values as Record<string, unknown>);
      });
    } finally {
      await this.catalog.refresh();
    }
  }
}
export function apkOwnerDirectory(dataDir: string, owner: string) {
  return join(dataDir, 'apk-extensions', createHash('sha256').update(owner).digest('hex'));
}
