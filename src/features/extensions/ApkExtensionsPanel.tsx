import { useEffect, useRef, useState } from 'react';
import { CompatibilityPreferencesPanel } from './CompatibilityPreferencesPanel';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import type {
  ApkExtensionManager,
  ApkManagerSnapshot,
  ApkInstallReview,
} from '../../extensions/packages/apk-extension-manager';

const messages: Record<string, string> = {
  compatibility_repository_mismatch:
    '선택한 실행기와 저장소 형식이 다릅니다. APK 또는 Mangayomi 확장 관리를 확인해 주세요.',
  compatibility_repository_invalid: '저장소의 확장 정보를 읽을 수 없습니다.',
  compatibility_file_invalid: '지원하는 확장 파일인지 확인해 주세요. JS는 1MB, APK는 32MB까지 설치할 수 있습니다.',
  compatibility_filter_unsupported: '이 확장의 필터 형식을 아직 지원하지 않습니다.',
  compatibility_feature_unsupported: '이 확장이 요구하는 실행 기능을 아직 지원하지 않습니다.',
  apk_publisher_changed: '설치한 확장과 서명이 다릅니다. 업데이트를 중단했습니다.',
  apk_version_not_newer: '이미 같은 버전이나 더 새로운 버전을 사용 중입니다.',
  apk_verification_failed: '확장의 서명이나 파일을 검증하지 못했습니다.',
  apk_android_feature_unsupported: '이 확장에 필요한 Android 기능을 아직 지원하지 않습니다.',
  apk_install_conflict: '설치 상태가 변경됐습니다. 목록을 새로고침해 주세요.',
  apk_repository_conflict: '저장소 목록이 변경됐습니다. 다시 선택해 주세요.',
  apk_worker_unavailable: '확장 실행기를 시작하지 못했습니다. 실행기 설치 상태를 확인해 주세요.',
  apk_review_expired: '설치 준비 시간이 지났습니다. 확장을 다시 선택해 주세요.',
};
export function ApkExtensionsPanel({
  manager,
  initialRepository,
  target = 'server',
  format = 'apk',
}: {
  manager: ApkExtensionManager;
  initialRepository?: string;
  target?: 'server' | 'device';
  format?: 'apk' | 'mangayomi-js';
}) {
  const label = format === 'apk' ? 'APK' : 'Mangayomi JS';
  const [optionsPackage, setOptionsPackage] = useState<string>();
  const [snapshot, setSnapshot] = useState<ApkManagerSnapshot>();
  const [url, setUrl] = useState(initialRepository ?? '');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [localFile, setLocalFile] = useState<File>();
  const [review, setReview] = useState<ApkInstallReview>();
  const reviewFocus = useRef<HTMLElement>(null);
  useEffect(() => {
    if (review) reviewFocus.current?.focus({ preventScroll: true });
  }, [review]);
  const [reviewPackage, setReviewPackage] = useState<string>();
  const [trusted, setTrusted] = useState(false);
  const operation = useRef<AbortController>();
  const heldReview = useRef<ApkInstallReview>();
  const [inspecting, setInspecting] = useState(false);
  const discard = (value: ApkInstallReview | undefined) => {
    if (value) void manager.discardReview?.(value.id).catch(() => {});
  };
  const dismissReview = () => {
    discard(heldReview.current);
    heldReview.current = undefined;
    setReview(undefined);
    setReviewPackage(undefined);
    setTrusted(false);
  };
  useEffect(
    () => () => {
      operation.current?.abort();
      operation.current = undefined;
      const previous = heldReview.current;
      heldReview.current = undefined;
      if (previous) void manager.discardReview?.(previous.id).catch(() => {});
    },
    [manager],
  );
  useEffect(() => {
    setUrl(initialRepository ?? '');
  }, [initialRepository]);
  useEffect(() => {
    let active = true;
    void manager
      .list()
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setSelected(value.repositories[0]?.url ?? '');
        }
      })
      .catch(() => {
        if (active) setError('확장 기능을 확인하지 못했습니다. 앱과 연결 상태를 확인해 주세요.');
      });
    return () => {
      active = false;
    };
  }, [manager]);
  const run = async (task: (signal: AbortSignal) => Promise<void>, inspect = false) => {
    if (operation.current) return;
    const abort = new AbortController();
    operation.current = abort;
    setInspecting(inspect);
    setBusy(true);
    setError(undefined);
    try {
      await task(abort.signal);
      if (!inspect && !abort.signal.aborted) {
        const next = await manager.list();
        if (!abort.signal.aborted) setSnapshot(next);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      setError(
        messages[error instanceof Error ? error.message : ''] ??
          packageOperationMessage(error) ??
          (error instanceof Error && /[가-힣]/.test(error.message)
            ? error.message
            : '작업을 완료하지 못했습니다. 저장소와 연결 상태를 확인해 주세요.'),
      );
    } finally {
      if (operation.current === abort) {
        operation.current = undefined;
        setBusy(false);
        setInspecting(false);
      }
    }
  };
  const repository = snapshot?.repositories.find((row) => row.url === selected);
  const rows = installedOnly
    ? (snapshot?.packages ?? []).map((pkg) => ({
        id: pkg.pkg,
        name: pkg.sources.map((s) => s.name).join(' · '),
        version: pkg.version,
        code: pkg.code,
        installed: pkg,
        unsupported: false,
      }))
    : (repository?.entries ?? []).map((entry) => ({
        id: entry.pkg,
        name: entry.name,
        version: entry.version,
        code: entry.code,
        installed: snapshot?.packages.find((pkg) => pkg.pkg === entry.pkg),
        unsupported: entry.format === 'mangayomi-dart',
      }));
  const filtered = rows.filter((row) =>
    `${row.name} ${row.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(filtered.length / 20) - 1);
  const currentPage = Math.min(page, lastPage);
  const operationStatus = (
    <>
      {busy && <p role="status">확장 작업을 처리하고 있습니다…</p>}
      {inspecting && (
        <button
          type="button"
          onClick={() => {
            operation.current?.abort();
            operation.current = undefined;
            setBusy(false);
            setInspecting(false);
            dismissReview();
          }}
        >
          준비 취소
        </button>
      )}
    </>
  );
  const reviewCard = review && (
    <section
      ref={reviewFocus}
      tabIndex={-1}
      className="extension-install-confirmation"
      aria-label={`${label} 설치 확인`}
    >
      {localFile && (review.fileSources?.length ?? 0) > 1 && (
        <label className="compatibility-preference-field">
          <span>설치할 소스</span>
          <select
            aria-label="파일의 소스 선택"
            value={review.sourceIndex ?? 0}
            disabled={busy}
            onChange={(event) => {
              const index = Number(event.target.value);
              void run(async (signal) => {
                dismissReview();
                const next = await manager.inspectFile!(localFile, signal, index);
                if (signal.aborted) {
                  discard(next);
                  return;
                }
                heldReview.current = next;
                setReview(next);
                setTrusted(false);
              }, true);
            }}
          >
            {review.fileSources?.map((entry, index) => (
              <option key={index} value={index}>
                {entry.name} · {entry.lang}
              </option>
            ))}
          </select>
        </label>
      )}
      <strong className="installed-extension-origin">
        {(reviewPackage ? rows.find((row) => row.id === reviewPackage)?.name : localFile?.name) ?? review.pkg} · v
        {review.version}
      </strong>
      <p className="field-help">
        {label} 코드는 {target === 'server' ? '서버' : '이 기기'}에서 실행됩니다. 신뢰하는 배포처의 확장만 설치하세요.
      </p>
      {review.format === 'mangayomi-js' && (
        <details className="installed-extension-origin">
          <summary>출처와 파일 정보</summary>
          출처: {review.origin}
          <br />
          서명 없는 JavaScript · SHA-256: {review.digest}
        </details>
      )}
      <label className="checkbox-field">
        <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
        신뢰하는 확장입니다
      </label>
      <div className="installed-extension-actions">
        <button
          type="button"
          disabled={busy || !trusted}
          onClick={() =>
            void run(async (signal) => {
              await manager.install(review, signal);
              heldReview.current = undefined;
              setReview(undefined);
              setTrusted(false);
            })
          }
        >
          {busy ? '설치 중…' : '설치'}
        </button>
        <button type="button" disabled={busy} onClick={dismissReview}>
          취소
        </button>
      </div>
    </section>
  );
  return (
    <section
      className="extension-repository-browser source-extension-manager apk-extension-manager"
      aria-label={`${label} 확장 관리`}
    >
      <h4>{label} 확장</h4>
      <p className="field-help">
        {format === 'apk'
          ? 'Mihon·Tachiyomi·Aniyomi의 만화 확장을 설치합니다. 이미지 페이지를 제공하는 소설도 사용할 수 있습니다.'
          : 'Mangayomi JavaScript 확장을 실행합니다. Dart 확장은 지원하지 않습니다. 인증 서버 등 원본 확장의 옵션은 설치 후 설정할 수 있습니다.'}
      </p>
      <p className="field-help">
        파일 형식은 자동으로 확인합니다. 설치되어도 사이트 인증이나 지원하지 않는 기능 때문에 일부 동작이 제한될 수
        있습니다.
      </p>
      {error && (
        <p className="field-help warning" role="alert">
          {error}
        </p>
      )}
      {snapshot?.available === false && (
        <p role="status">
          {label} 실행기가 포함되어 있지 않습니다. 실행기를 포함한 {target === 'server' ? '서버' : '앱'} 버전이
          필요합니다.
        </p>
      )}
      {snapshot?.available && (
        <>
          {manager.inspectFile && (
            <label className="compatibility-preference-field">
              <span>파일에서 설치</span>
              <input
                type="file"
                accept={format === 'apk' ? '.apk' : '.js'}
                disabled={busy}
                aria-label={`${label} 확장 파일`}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (!file) return;
                  setLocalFile(file);
                  void run(async (signal) => {
                    dismissReview();
                    const next = await manager.inspectFile!(file, signal);
                    if (signal.aborted) {
                      discard(next);
                      return;
                    }
                    heldReview.current = next;
                    setReview(next);
                    setTrusted(false);
                  }, true);
                }}
              />
            </label>
          )}
          {!reviewPackage && operationStatus}
          {!reviewPackage && reviewCard}
          <form
            className="extension-repository-add"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await manager.refreshRepository(url);
                const value = await manager.list();
                setSelected(value.repositories.find((r) => r.url === url)?.url ?? value.repositories.at(-1)?.url ?? '');
                setInstalledOnly(false);
                setPage(0);
              });
            }}
          >
            <input
              aria-label={`${label} 저장소 주소`}
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…/index.min.json"
              required
              disabled={busy}
            />
            <button type="submit" disabled={busy || !url.trim()}>
              저장소 추가
            </button>
          </form>
          <div className="installed-extension-actions">
            <button
              type="button"
              aria-pressed={!installedOnly}
              onClick={() => {
                setInstalledOnly(false);
                setPage(0);
              }}
            >
              저장소
            </button>
            <button
              type="button"
              aria-pressed={installedOnly}
              onClick={() => {
                setInstalledOnly(true);
                setPage(0);
              }}
            >
              설치됨 {snapshot.packages.length}
            </button>
          </div>
          {!installedOnly && (
            <div className="extension-repository-add">
              <select
                aria-label={`${label} 저장소 선택`}
                value={selected}
                disabled={busy}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setPage(0);
                }}
              >
                {!snapshot.repositories.length && <option value="">등록한 저장소 없음</option>}
                {snapshot.repositories.map((row) => (
                  <option key={row.url} value={row.url}>
                    {new URL(row.url).hostname + new URL(row.url).pathname.replace('/index.min.json', '')}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !selected}
                onClick={() => void run(() => manager.refreshRepository(selected))}
              >
                새로고침
              </button>
              <button
                type="button"
                disabled={busy || !selected}
                onClick={() =>
                  void run(async () => {
                    await manager.removeRepository(selected);
                    setSelected('');
                  })
                }
              >
                저장소 삭제
              </button>
            </div>
          )}
          <input
            aria-label={`${label} 확장 검색`}
            placeholder="확장 검색"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          <div className="installed-extension-list">
            {filtered.slice(currentPage * 20, currentPage * 20 + 20).map((row) => (
              <article className="extension-settings-card" key={row.id}>
                <strong>{row.name}</strong>
                <span className="muted">v{row.version}</span>
                {row.unsupported && <p className="field-help">Mangayomi Dart · 실행기 미지원</p>}
                <div className="installed-extension-actions">
                  {!installedOnly && !(reviewPackage === row.id && review) && (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        row.unsupported ||
                        (format === 'apk' && !!row.installed && row.installed.code >= row.code)
                      }
                      onClick={() =>
                        void run(async (signal) => {
                          dismissReview();
                          setReviewPackage(row.id);
                          const next = await manager.inspectRepository(selected, row.id, row.code, signal);
                          if (signal.aborted) {
                            discard(next);
                            return;
                          }
                          heldReview.current = next;
                          setReview(next);
                          setTrusted(false);
                        }, true)
                      }
                    >
                      {row.installed
                        ? format !== 'apk' || row.installed.code < row.code
                          ? '업데이트'
                          : '설치됨'
                        : '설치'}
                    </button>
                  )}
                  {row.installed && (
                    <>
                      {manager.preferences && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-expanded={optionsPackage === row.id}
                          onClick={() => setOptionsPackage(optionsPackage === row.id ? undefined : row.id)}
                        >
                          설정
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            manager.change(
                              row.id,
                              snapshot.revision,
                              row.installed!.enabled === false ? 'enable' : 'disable',
                            ),
                          )
                        }
                      >
                        {row.installed.enabled === false ? '켜기' : '끄기'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => manager.change(row.id, snapshot.revision, 'remove'))}
                      >
                        확장 제거
                      </button>
                    </>
                  )}
                </div>
                {reviewPackage === row.id && (
                  <>
                    {operationStatus}
                    {reviewCard}
                  </>
                )}
                {optionsPackage === row.id && row.installed && (
                  <CompatibilityPreferencesPanel
                    manager={manager}
                    pkg={row.id}
                    onSaved={() => void run(async () => {})}
                  />
                )}
              </article>
            ))}
          </div>
          {!filtered.length && <p className="muted">표시할 확장이 없습니다.</p>}
          {lastPage > 0 && (
            <div className="installed-extension-actions" aria-label={`${label} 목록 페이지`}>
              <button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
                이전
              </button>
              <span>
                {currentPage + 1} / {lastPage + 1}
              </span>
              <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
                다음
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
