import type { InstalledExtensionManager, PackageReview } from '../../extensions/packages/installed-extension-manager';
import type { SourceExtensionManager } from '../../external-sources/extension-management';

export interface Review {
  title: string;
  details: readonly string[];
  install(signal: AbortSignal): Promise<unknown>;
  discard?(): void;
}
export interface Update {
  id: string;
  packageKey?: string;
  title: string;
  subtitle?: string;
  prepare(signal: AbortSignal): Promise<Review>;
}

/** Shared discovery for automatic notices and the explicit install-review screen. */
export async function findExtensionUpdates(
  manager: InstalledExtensionManager,
  suwayomi: SourceExtensionManager | undefined,
  signal: AbortSignal,
) {
  const moyaReview = (update: { file: File; plan: PackageReview }): Review => ({
    title: `${update.plan.package.manifest.extension.name} · v${update.plan.package.manifest.extension.version}`,
    details: [
      update.plan.publisherChanged
        ? '게시자가 변경되었습니다.'
        : update.plan.package.publisherFingerprint
          ? `게시자: ${update.plan.package.publisherFingerprint}`
          : '서명 없는 패키지',
      ...(update.plan.downgrade ? ['이전 버전으로 변경합니다.'] : []),
      `SHA-256: ${update.plan.package.digest}`,
      ...update.plan.package.manifest.extension.permissions.map((permission) =>
        permission === 'external.source.download'
          ? '선택한 작품의 회차 가져오기'
          : permission === 'external.source.list'
            ? '외부 작품 검색과 목록 조회'
            : '작품 정보·표지 후보 제안',
      ),
      ...update.plan.package.manifest.requestedAccess.networkOrigins.map((origin) => `접속할 사이트: ${origin}`),
      `소스 데이터 저장: 최대 ${update.plan.package.manifest.requestedAccess.storageKiB} KiB`,
      ...(update.plan.package.manifest.requestedAccess.webview ? ['확장 전용 브라우저 세션 사용'] : []),
      ...(update.plan.package.manifest.requestedAccess.authentication ?? []).map(
        (auth) => `계정 연결: ${auth.label} · ${auth.origin}`,
      ),
      ...(update.plan.package.manifest.requestedAccess.contentServices ?? []).map(
        (service) => `외부 본문 공급자: ${service.origins.join(', ')} · 별도 승인 필요`,
      ),
    ],
    install: (signal) => manager.install(update.file, update.plan, signal),
  });
  const found: Update[] = [],
    failures: string[] = [];
  for (const pkg of manager.getSnapshot().packages) {
    if (!pkg.active?.manifest.updates || !manager.checkUpdate) continue;
    try {
      const update = await manager.checkUpdate(pkg.id, pkg.revision, signal);
      if (update)
        found.push({
          id: `moya:${pkg.id}`,
          title: `Moya · ${pkg.active.manifest.extension.name}: ${pkg.active.manifest.extension.version} → ${update.plan.package.manifest.extension.version}`,
          prepare: async (nextSignal) => {
            const current = manager.getSnapshot().packages.find((p) => p.id === pkg.id);
            if (!current) throw new Error('package_install_conflict');
            const next = await manager.checkUpdate!(pkg.id, current.revision, nextSignal);
            if (!next) throw new Error('새 업데이트가 없습니다. 목록을 다시 확인해 주세요.');
            return moyaReview(next);
          },
        });
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${pkg.active.manifest.extension.name}: 업데이트 확인 실패`);
    }
  }
  for (const [format, compatibility] of [
    ['Mangayomi', manager.mangayomi],
    ['APK', manager.apk],
  ] as const) {
    if (!compatibility) continue;
    try {
      let inventory = await compatibility.list(signal);
      if (!inventory.packages.length) continue;
      for (const repository of inventory.repositories) {
        try {
          await compatibility.refreshRepository(repository.url, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          failures.push(`${format}: ${repository.url} 갱신 실패 (이전 목록 유지)`);
        }
      }
      inventory = await compatibility.list(signal);
      for (const pkg of inventory.packages) {
        const candidates = inventory.repositories.flatMap((repo) =>
          repo.entries
            .filter(
              (entry) =>
                entry.pkg === pkg.pkg &&
                entry.format !== 'mangayomi-dart' &&
                (format === 'APK'
                  ? entry.code > pkg.code
                  : entry.code !== pkg.code && entry.version.localeCompare(pkg.version, 'en', { numeric: true }) >= 0),
            )
            .map((entry) => ({ entry, url: repo.url })),
        );
        for (const candidate of candidates)
          found.push({
            id: `${format}:${candidate.url}:${pkg.pkg}`,
            packageKey: `${format}:${pkg.pkg}`,
            title: candidate.entry.name,
            subtitle: `${format} · ${pkg.version} → ${candidate.entry.version} · ${new URL(candidate.url).hostname}`,
            prepare: async (nextSignal) => {
              const plan = await compatibility.inspectRepository(
                candidate.url,
                pkg.pkg,
                candidate.entry.code,
                nextSignal,
              );
              const discard = () => {
                void compatibility.discardReview?.(plan.id).catch(() => undefined);
              };
              if (nextSignal.aborted) {
                discard();
                nextSignal.throwIfAborted();
              }
              return {
                title: `${candidate.entry.name} · v${plan.version}`,
                details: [
                  candidate.url,
                  `SHA-256: ${plan.digest}`,
                  ...(plan.signers.length
                    ? plan.signers.map((signer) => `서명: ${signer}`)
                    : ['서명 없는 JavaScript · 신뢰하는 저장소인지 확인해 주세요.']),
                  '이 소스의 코드를 업데이트합니다. 기존 사용 설정은 유지됩니다.',
                ],
                install: (installSignal) => compatibility.install(plan, installSignal),
                discard,
              };
            },
          });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${format}: 설치 목록 확인 실패`);
    }
  }
  if (suwayomi) {
    try {
      const inventory = await suwayomi.refresh(signal);
      for (const pkg of inventory.extensions.filter((entry) => entry.installed && entry.hasUpdate))
        found.push({
          id: `suwayomi:${pkg.id}`,
          title: `Suwayomi · ${pkg.name} · ${pkg.version}`,
          prepare: async () => ({
            title: `${pkg.name} 업데이트`,
            details: [
              pkg.repository ?? '연결한 Suwayomi 서버',
              '설치 및 서명 검증은 연결한 Suwayomi 서버가 수행합니다.',
            ],
            install: (installSignal) => suwayomi.change(pkg.id, 'update', installSignal),
          }),
        });
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push('Suwayomi: 업데이트 확인 실패');
    }
  }
  signal.throwIfAborted();
  return { updates: found, failures };
}
