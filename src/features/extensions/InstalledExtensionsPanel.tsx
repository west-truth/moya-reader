import './extension-management.css';
import { InstalledSourceContentConnection } from './InstalledSourceContentConnection';
import { InstalledSourcePreferences } from './InstalledSourcePreferences';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FilePlus2, RefreshCw } from 'lucide-react';
import type { InstalledExtensionManager, PackageReview } from '../../extensions/packages/installed-extension-manager';
import { InstalledSourceAuthentication } from './InstalledSourceAuthentication';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { ExtensionRepositoryBrowser } from './ExtensionRepositoryBrowser';
import { SourceExtensionManagerPanel } from './SourceExtensionManagerPanel';
import { ApkExtensionsPanel } from './ApkExtensionsPanel';
import type { SourceExtensionManager } from '../../external-sources/extension-management';

export function InstalledExtensionsPanel({
  manager,
  suwayomi,
}: {
  manager: InstalledExtensionManager;
  suwayomi?: SourceExtensionManager;
}) {
  const [apkRepository, setApkRepository] = useState<string>();
  const [showSuwayomi, setShowSuwayomi] = useState(false);
  const [showApk, setShowApk] = useState(false);
  const [showMangayomi, setShowMangayomi] = useState(false);
  const [mangayomiRepository, setMangayomiRepository] = useState<string>();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const [showRepositories, setShowRepositories] = useState(false);
  const [review, setReview] = useState<{ file: File; plan: PackageReview }>();
  const reviewFocus = useRef<HTMLElement>(null);
  useEffect(() => {
    if (review) reviewFocus.current?.focus({ preventScroll: true });
  }, [review]);
  const [reviewLocation, setReviewLocation] = useState<string>();
  const [acceptedChange, setAcceptedChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await task();
    } catch (error) {
      setError(
        packageOperationMessage(error) ??
          (error instanceof Error && /[가-힣]/.test(error.message)
            ? error.message
            : '작업을 완료하지 못했습니다. 파일과 연결 상태를 확인한 뒤 다시 시도해 주세요.'),
      );
    } finally {
      setBusy(false);
    }
  };
  const needsAcknowledgement = review?.plan.publisherChanged || review?.plan.downgrade;
  const reviewCard = review && (
    <section ref={reviewFocus} tabIndex={-1} className="extension-install-confirmation" aria-label="확장 설치 확인">
      <strong>
        {review.plan.package.manifest.extension.name} · v{review.plan.package.manifest.extension.version}
      </strong>
      <p className="muted">{review.plan.package.manifest.extension.id}</p>
      <p className="field-help">
        {review.plan.package.publisherFingerprint
          ? '게시자 서명 있음 · 알려진 게시자인지 직접 확인해 주세요.'
          : '서명 없는 파일 · 신뢰하는 경로에서 받은 파일인지 확인해 주세요.'}
      </p>
      <details>
        <summary>요청하는 기능과 접근 범위</summary>
        <ul>
          {review.plan.package.manifest.extension.permissions.map((permission) => (
            <li key={permission}>
              {permission === 'external.source.download'
                ? '선택한 작품의 회차 가져오기'
                : permission === 'external.source.list'
                  ? '외부 작품 검색과 목록 조회'
                  : '작품 정보·표지 후보 제안'}
            </li>
          ))}
          {review.plan.package.manifest.requestedAccess.networkOrigins.map((origin) => (
            <li key={origin} className="installed-extension-origin">
              {origin}
            </li>
          ))}
          {review.plan.package.manifest.requestedAccess.storageKiB > 0 && (
            <li>소스 데이터 저장 · 최대 {review.plan.package.manifest.requestedAccess.storageKiB} KiB</li>
          )}
          {review.plan.package.manifest.requestedAccess.webview && (
            <li>사이트 화면 실행 · 확장 전용 브라우저 세션 저장</li>
          )}
          {review.plan.package.manifest.requestedAccess.authentication?.map((auth) => (
            <li key={auth.sourceId}>
              계정 연결 · {auth.label} · {auth.origin}
            </li>
          ))}
          {review.plan.package.manifest.updates && (
            <li className="installed-extension-origin">
              업데이트 저장소 · {review.plan.package.manifest.updates.repository}
            </li>
          )}
          {review.plan.package.manifest.requestedAccess.contentServices?.map((service) => (
            <li key={`content-${service.sourceId}`} className="installed-extension-origin">
              외부 본문 공급자 사용 · {service.origins.join(', ')} · 별도 연결 승인 필요
            </li>
          ))}
        </ul>
      </details>
      {review.plan.publisherChanged && <p className="field-help warning">기존 확장과 게시자 서명이 다릅니다.</p>}
      {review.plan.downgrade && <p className="field-help warning">현재보다 이전 버전으로 변경합니다.</p>}
      {needsAcknowledgement && (
        <label className="reader-settings-toggle">
          <input
            type="checkbox"
            checked={acceptedChange}
            onChange={(event) => setAcceptedChange(event.target.checked)}
          />{' '}
          위 변경 사항을 확인했습니다
        </label>
      )}
      <div className="installed-extension-actions">
        <button
          type="button"
          disabled={busy || (!!needsAcknowledgement && !acceptedChange)}
          onClick={() =>
            void run(async () => {
              await manager.install(review.file, review.plan);
              setReview(undefined);
              setMessage('확장을 설치했습니다. 소스 목록에서 사용할 수 있습니다.');
            })
          }
        >
          {review.plan.operation === 'update' ? '업데이트' : '설치'}
        </button>
        <button type="button" disabled={busy} onClick={() => setReview(undefined)}>
          취소
        </button>
      </div>
    </section>
  );
  return (
    <section className="settings-section-card installed-extension-panel" aria-label="설치형 확장">
      <div className="settings-section-heading">
        <FilePlus2 size={18} aria-hidden="true" />
        <div>
          <h3>설치형 확장</h3>
          <p>
            {manager.target === 'server'
              ? '서버에 설치하면 연결된 기기에서 같은 소스를 사용할 수 있습니다.'
              : '이 기기에 설치합니다. 별도 소스 서버 없이 사용할 수 있습니다.'}
          </p>
        </div>
      </div>
      <div className="installed-extension-actions">
        {manager.mangayomi && (
          <button
            type="button"
            aria-expanded={showMangayomi}
            onClick={() => {
              setShowMangayomi(!showMangayomi);
              setShowApk(false);
              setShowSuwayomi(false);
              setShowRepositories(false);
            }}
          >
            Mangayomi JS 확장
          </button>
        )}
        {manager.apk && (
          <button
            type="button"
            aria-expanded={showApk}
            onClick={() => {
              setShowApk(!showApk);
              setShowMangayomi(false);
              setShowSuwayomi(false);
              setShowRepositories(false);
            }}
          >
            APK 확장
          </button>
        )}
        {suwayomi && (
          <button
            type="button"
            aria-expanded={showSuwayomi}
            onClick={() => {
              setShowSuwayomi(!showSuwayomi);
              setShowApk(false);
              setShowMangayomi(false);
              setShowRepositories(false);
            }}
          >
            Suwayomi 확장
          </button>
        )}
        {manager.listRepositories && (
          <button
            type="button"
            disabled={busy || !snapshot.available}
            aria-expanded={showRepositories}
            onClick={() => {
              setShowRepositories(!showRepositories);
              setShowApk(false);
              setShowMangayomi(false);
              setShowSuwayomi(false);
            }}
          >
            저장소
          </button>
        )}
        <button type="button" disabled={busy || !snapshot.available} onClick={() => input.current?.click()}>
          <FilePlus2 size={16} aria-hidden="true" /> 확장 파일 추가
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label="설치된 확장 새로고침"
          onClick={() => void run(manager.refresh)}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <input
          ref={input}
          type="file"
          accept=".moyaext"
          hidden
          aria-label="확장 패키지 파일"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            setShowApk(false);
            setShowMangayomi(false);
            setShowSuwayomi(false);
            setShowRepositories(false);
            setReview(undefined);
            setReviewLocation(undefined);
            setAcceptedChange(false);
            void run(async () => {
              setReview({ file, plan: await manager.inspect(file) });
            });
          }}
        />
      </div>
      {showSuwayomi && suwayomi && <SourceExtensionManagerPanel manager={suwayomi} initialRepository={apkRepository} />}
      {showApk && manager.apk && (
        <ApkExtensionsPanel manager={manager.apk} initialRepository={apkRepository} target={manager.target} />
      )}
      {showMangayomi && manager.mangayomi && (
        <ApkExtensionsPanel
          manager={manager.mangayomi}
          format="mangayomi-js"
          initialRepository={mangayomiRepository}
          target={manager.target}
        />
      )}
      {snapshot.error && (
        <p className="field-help" role="status">
          {snapshot.error}
        </p>
      )}
      {error && (
        <p className="field-help warning" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="field-help" role="status">
          {message}
        </p>
      )}
      {busy && (
        <p className="field-help" role="status">
          확장 작업을 처리하고 있습니다…
        </p>
      )}
      {!reviewLocation && reviewCard}
      {showRepositories && (
        <ExtensionRepositoryBrowser
          onMangayomiRepository={
            manager.mangayomi
              ? (url) => {
                  setMangayomiRepository(url);
                  setShowMangayomi(true);
                  setShowRepositories(false);
                  setShowApk(false);
                  setShowSuwayomi(false);
                }
              : undefined
          }
          onSuwayomiRepository={
            manager.apk || suwayomi
              ? (url) => {
                  setApkRepository(url);
                  if (manager.apk) setShowApk(true);
                  else setShowSuwayomi(true);
                  setShowRepositories(false);
                }
              : undefined
          }
          manager={manager}
          snapshot={snapshot}
          disabled={busy}
          renderReview={(id) => (reviewLocation === id ? reviewCard : null)}
          onReview={(value) => {
            setReviewLocation(value.plan.package.manifest.extension.id);
            setReview(value);
            setAcceptedChange(false);
            setError(undefined);
          }}
        />
      )}
      <div className="extension-settings-list">
        {snapshot.packages
          .filter((pkg) => pkg.active)
          .map((pkg) => (
            <article key={pkg.id} className="extension-settings-card">
              <div className="extension-settings-card-heading">
                <div>
                  <strong>{pkg.active!.manifest.extension.name}</strong>
                  <p className="muted">v{pkg.active!.manifest.extension.version}</p>
                </div>
                <label className="reader-settings-toggle">
                  <input
                    type="checkbox"
                    checked={pkg.enabled}
                    disabled={busy}
                    aria-label={`${pkg.active!.manifest.extension.name} 사용`}
                    onChange={(event) =>
                      void run(() => manager.change(pkg.id, pkg.revision, event.target.checked ? 'enable' : 'disable'))
                    }
                  />{' '}
                  사용
                </label>
              </div>
              {snapshot.errors.some((error) => error.packageId === pkg.id) && (
                <p className="field-help warning">
                  확장을 실행하지 못했습니다. 새 버전을 설치하거나 이전 버전으로 되돌려 주세요.
                </p>
              )}
              <details>
                <summary>관리</summary>
                <p className="field-help">확장을 제거해도 이미 받은 작품은 남습니다.</p>
                <div className="installed-extension-actions">
                  {pkg.active!.manifest.updates && manager.checkUpdate && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setReview(undefined);
                          setReviewLocation('installed:' + pkg.id);
                          setAcceptedChange(false);
                          const update = await manager.checkUpdate!(pkg.id, pkg.revision);
                          if (update) setReview(update);
                          else setMessage('새 버전이 없습니다.');
                        })
                      }
                    >
                      업데이트 확인
                    </button>
                  )}
                  {pkg.previous && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => manager.change(pkg.id, pkg.revision, 'rollback'))}
                    >
                      이전 버전 복원
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => manager.change(pkg.id, pkg.revision, 'remove'))}
                  >
                    확장 제거
                  </button>
                </div>
              </details>
              {reviewLocation === 'installed:' + pkg.id && reviewCard}
              {pkg.active!.manifest.preferences?.map((preferences) => (
                <InstalledSourcePreferences
                  key={preferences.sourceId}
                  manager={manager}
                  sourceId={preferences.sourceId}
                  disabled={!!busy}
                />
              ))}
              {pkg.active!.manifest.requestedAccess.contentServices?.map((service) => (
                <InstalledSourceContentConnection
                  key={`content:${pkg.revision}:${service.sourceId}`}
                  manager={manager}
                  sourceId={service.sourceId}
                  disabled={busy || !pkg.enabled}
                />
              ))}
              {pkg.active!.manifest.requestedAccess.authentication?.map((auth) => (
                <InstalledSourceAuthentication
                  key={`${pkg.revision}:${auth.sourceId}`}
                  manager={manager}
                  auth={auth}
                  disabled={busy || !pkg.enabled}
                />
              ))}
            </article>
          ))}
      </div>
      {snapshot.available && !snapshot.packages.some((pkg) => pkg.active) && !review && (
        <p className="muted">설치한 확장이 없습니다.</p>
      )}
    </section>
  );
}
