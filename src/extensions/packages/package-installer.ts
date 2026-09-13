import { MoyaPackageError, verifyMoyaExtension, type VerifiedMoyaPackage } from './package-archive';
import type { InstalledPackageRecord, InstalledPackageVersion, PackageInstallStore } from './package-install-store';

export interface PackageInstallPlan {
  readonly package: VerifiedMoyaPackage;
  readonly expectedRevision: number;
  readonly operation: 'install' | 'update' | 'unchanged';
  readonly publisherChanged: boolean;
  readonly expandedAccess: boolean;
  readonly downgrade: boolean;
}

export function comparePackageVersions(left: string, right: string): number {
  const [leftBase, ...leftSuffix] = left.split('-');
  const [rightBase, ...rightSuffix] = right.split('-');
  const a = leftBase.split('.').map(Number);
  const b = rightBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  const pa = leftSuffix.join('-');
  const pb = rightSuffix.join('-');
  if (pa === pb) return 0;
  if (!pa || !pb) return !pa ? 1 : -1;
  const aa = pa.split('.');
  const bb = pb.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue;
    if (aa[i] === undefined || bb[i] === undefined) return aa[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(aa[i]);
    const bn = /^\d+$/.test(bb[i]);
    if (an && bn) return BigInt(aa[i]) < BigInt(bb[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

function accessExpanded(previous: InstalledPackageVersion | undefined, next: VerifiedMoyaPackage): boolean {
  if (!previous) return true;
  return (
    next.manifest.extension.permissions.some(
      (permission) => !previous.manifest.extension.permissions.includes(permission),
    ) ||
    next.manifest.requestedAccess.networkOrigins.some(
      (origin) => !previous.manifest.requestedAccess.networkOrigins.includes(origin),
    ) ||
    next.manifest.requestedAccess.storageKiB > previous.manifest.requestedAccess.storageKiB ||
    (!!next.manifest.requestedAccess.webview && !previous.manifest.requestedAccess.webview) ||
    JSON.stringify(next.manifest.requestedAccess.authentication ?? []) !==
      JSON.stringify(previous.manifest.requestedAccess.authentication ?? []) ||
    JSON.stringify(next.manifest.requestedAccess.contentServices ?? []) !==
      JSON.stringify(previous.manifest.requestedAccess.contentServices ?? [])
  );
}

export class PackageInstaller {
  constructor(
    private readonly store: PackageInstallStore,
    private readonly prepare: (pkg: VerifiedMoyaPackage, signal?: AbortSignal) => Promise<void>,
  ) {}

  async inspect(archive: Blob, signal?: AbortSignal): Promise<PackageInstallPlan> {
    const pkg = await verifyMoyaExtension(archive, signal);
    const existing = await this.store.read(pkg.manifest.extension.id);
    const active = existing?.active;
    const same = active?.digest === pkg.digest;
    if (active && !same && active.manifest.extension.version === pkg.manifest.extension.version)
      throw new MoyaPackageError('package_version_conflict');
    return {
      package: pkg,
      expectedRevision: existing?.revision ?? 0,
      operation: same ? 'unchanged' : active ? 'update' : 'install',
      publisherChanged: Boolean(existing && existing.publisherPin !== (pkg.publisherFingerprint ?? 'unsigned')),
      expandedAccess: accessExpanded(active, pkg),
      downgrade: Boolean(
        active && comparePackageVersions(pkg.manifest.extension.version, active.manifest.extension.version) < 0,
      ),
    };
  }

  async install(
    plan: PackageInstallPlan,
    approval: { digest: string; publisherChange?: boolean; downgrade?: boolean },
    signal?: AbortSignal,
  ): Promise<InstalledPackageRecord> {
    // Recheck the immutable archive and current revision after review; never trust a caller-mutated plan/manifest.
    const fresh = await this.inspect(plan.package.archive, signal);
    if (approval.digest !== fresh.package.digest || plan.package.digest !== fresh.package.digest)
      throw new MoyaPackageError('package_approval_mismatch');
    if (plan.expectedRevision !== fresh.expectedRevision) throw new MoyaPackageError('package_install_conflict');
    if (fresh.publisherChanged && !approval.publisherChange)
      throw new MoyaPackageError('publisher_change_requires_review');
    if (fresh.downgrade && !approval.downgrade) throw new MoyaPackageError('package_downgrade_requires_review');
    const pkg = fresh.package;
    const previous = await this.store.read(pkg.manifest.extension.id);
    if ((previous?.revision ?? 0) !== fresh.expectedRevision) throw new MoyaPackageError('package_install_conflict');
    if (fresh.operation === 'unchanged') return previous!;
    await this.prepare(pkg, signal);
    signal?.throwIfAborted();
    const active: InstalledPackageVersion = {
      digest: pkg.digest,
      manifest: pkg.manifest,
      archive: pkg.archive,
      publisherFingerprint: pkg.publisherFingerprint,
      settings: previous?.active?.settings ?? {},
    };
    const record: InstalledPackageRecord = {
      credentialEpoch:
        previous?.active && !fresh.publisherChanged && previous.credentialEpoch
          ? previous.credentialEpoch
          : crypto.randomUUID(),
      id: pkg.manifest.extension.id,
      revision: fresh.expectedRevision + 1,
      publisherPin: pkg.publisherFingerprint ?? 'unsigned',
      enabled: previous?.active ? previous.enabled : true,
      active,
      previous: previous?.active,
      updatedAt: new Date().toISOString(),
    };
    if (!(await this.store.compareAndSwap(record.id, fresh.expectedRevision, record)))
      throw new MoyaPackageError('package_install_conflict');
    return record;
  }

  async setEnabled(id: string, revision: number, enabled: boolean): Promise<void> {
    const current = await this.current(id, revision);
    if (enabled) {
      const verified = await verifyMoyaExtension(current.active!.archive);
      if (verified.digest !== current.active!.digest) throw new MoyaPackageError('invalid_package_integrity');
      await this.prepare(verified);
    }
    await this.commit(current, { ...current, enabled });
  }

  async rollback(id: string, revision: number, signal?: AbortSignal): Promise<void> {
    const current = await this.current(id, revision);
    if (!current.previous) throw new MoyaPackageError('package_rollback_unavailable');
    const verified = await verifyMoyaExtension(current.previous.archive, signal);
    if (verified.digest !== current.previous.digest) throw new MoyaPackageError('invalid_package_integrity');
    await this.prepare(verified, signal);
    signal?.throwIfAborted();
    await this.commit(current, {
      ...current,
      credentialEpoch:
        current.publisherPin === (current.previous.publisherFingerprint ?? 'unsigned')
          ? current.credentialEpoch
          : crypto.randomUUID(),
      publisherPin: current.previous.publisherFingerprint ?? 'unsigned',
      active: current.previous,
      previous: current.active,
    });
  }

  async remove(id: string, revision: number): Promise<void> {
    const current = await this.current(id, revision);
    // A tombstone fences any earlier in-flight install. No Library/source links or downloaded books are deleted.
    await this.commit(current, {
      id,
      revision,
      enabled: false,
      publisherPin: current.publisherPin,
      updatedAt: current.updatedAt,
    });
  }

  private async current(id: string, revision: number): Promise<InstalledPackageRecord> {
    const current = await this.store.read(id);
    if (!current?.active || current.revision !== revision) throw new MoyaPackageError('package_install_conflict');
    return current;
  }

  private async commit(current: InstalledPackageRecord, value: InstalledPackageRecord): Promise<void> {
    if (
      !(await this.store.compareAndSwap(current.id, current.revision, {
        ...value,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }))
    )
      throw new MoyaPackageError('package_install_conflict');
  }
}
