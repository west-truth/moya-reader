import type { PackageInstallStore } from './package-install-store';
import type { PackageExecutionPort } from './package-runtime-catalog';
import { repositoryUrl, validateRepositoryIndex, type RepositoryRecord } from './repository-contract';

/** Saved repositories and their cached indexes do not change installed package generations. */
export class PackageRepositories {
  constructor(
    private readonly store: PackageInstallStore,
    private readonly execution: PackageExecutionPort,
  ) {}
  private records() {
    if (!this.store.listRepositories || !this.store.saveRepository) throw new Error('package_repository_unavailable');
    return this.store.listRepositories();
  }
  async list() {
    return (await this.records()).filter((item) => item.index);
  }
  async refresh(input: string, signal = new AbortController().signal) {
    const url = repositoryUrl(input);
    const all = await this.records();
    const previous = all.find((item) => item.url === url);
    if (!previous?.index && all.filter((item) => item.index).length >= 16) throw new Error('package_repository_limit');
    if (!this.execution.listRepository) throw new Error('package_repository_unavailable');
    const index = validateRepositoryIndex(await this.execution.listRepository(url, signal), url);
    signal.throwIfAborted();
    const record: RepositoryRecord = {
      url,
      revision: (previous?.revision ?? 0) + 1,
      index,
      checkedAt: new Date().toISOString(),
    };
    if (!(await this.store.saveRepository!(record, previous?.revision ?? 0)))
      throw new Error('package_repository_conflict');
    return record;
  }
  async remove(input: string, revision: number) {
    const url = repositoryUrl(input);
    await this.records();
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !(await this.store.saveRepository!({ url, revision: revision + 1 }, revision))
    )
      throw new Error('package_repository_conflict');
  }
  async download(input: string, id: string, sha256: string, signal = new AbortController().signal) {
    const url = repositoryUrl(input);
    const record = (await this.records()).find((item) => item.url === url && item.index);
    const entry = record?.index?.packages.find((item) => item.id === id && item.sha256 === sha256);
    if (!record || !entry) throw new Error('package_repository_conflict');
    if (!this.execution.downloadRepository) throw new Error('package_repository_unavailable');
    const archive = await this.execution.downloadRepository(url, entry, signal);
    signal.throwIfAborted();
    if ((await this.records()).find((item) => item.url === url)?.revision !== record.revision)
      throw new Error('package_repository_conflict');
    return archive;
  }
}
