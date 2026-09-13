import { useEffect, useState, type ReactNode } from 'react';
import type {
  InstalledExtensionManager,
  InstalledExtensionsSnapshot,
  PackageReview,
} from '../../extensions/packages/installed-extension-manager';
import type { RepositoryRecord } from '../../extensions/packages/repository-contract';
import { comparePackageVersions } from '../../extensions/packages/package-installer';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';

export function ExtensionRepositoryBrowser({
  manager,
  snapshot,
  disabled,
  onReview,
  renderReview,
  onSuwayomiRepository,
  onMangayomiRepository,
}: {
  manager: InstalledExtensionManager;
  snapshot: InstalledExtensionsSnapshot;
  disabled: boolean;
  renderReview?(id: string): ReactNode;
  onReview(value: { file: File; plan: PackageReview }): void;
  onSuwayomiRepository?(url: string): void;
  onMangayomiRepository?(url: string): void;
}) {
  const [repositories, setRepositories] = useState<readonly RepositoryRecord[]>([]);
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [apkRepository, setApkRepository] = useState<string>();
  const [mangayomiRepository, setMangayomiRepository] = useState<string>();
  useEffect(() => {
    let active = true;
    void manager.listRepositories!()
      .then((items) => {
        if (active) {
          setRepositories(items);
          setSelected(items[0]?.url ?? '');
        }
      })
      .catch(() => {
        if (active) setError('저장소를 읽지 못했습니다. 서버 또는 앱 버전을 확인해 주세요.');
      });
    return () => {
      active = false;
    };
  }, [manager]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } catch (error) {
      setError(
        packageOperationMessage(error) ??
          '저장소를 불러오지 못했습니다. 주소와 연결을 확인해 주세요. 저장된 목록은 유지됩니다.',
      );
    } finally {
      setBusy(false);
    }
  };
  const record = repositories.find((item) => item.url === selected);
  const entries = (record?.index?.packages ?? [])
    .map((entry) => {
      const installed = snapshot.packages.find((pkg) => pkg.id === entry.id)?.active;
      return {
        entry,
        installed,
        newer: !!installed && comparePackageVersions(entry.version, installed.manifest.extension.version) > 0,
      };
    })
    .filter(
      ({ entry, newer }) =>
        (!updatesOnly || newer) &&
        `${entry.name ?? ''} ${entry.id} ${entry.description ?? ''}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    );
  const lastPage = Math.max(0, Math.ceil(entries.length / 20) - 1);
  const currentPage = Math.min(page, lastPage);
  const locked = busy || disabled;
  return (
    <section className="extension-repository-browser" aria-label="확장 저장소">
      <p className="field-help">
        확장 저장소의 JSON 주소를 추가하세요. APK·Mangayomi 저장소는 파일 형식에 맞는 확장 관리로 안내합니다.
      </p>
      <form
        className="extension-repository-add"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setApkRepository(undefined);
            setMangayomiRepository(undefined);
            let saved: RepositoryRecord;
            try {
              saved = await manager.refreshRepository!(url);
            } catch (error) {
              if (
                error instanceof Error &&
                (error.message === 'package_repository_mangayomi' ||
                  error.message === packageOperationMessage(new Error('package_repository_mangayomi')))
              )
                setMangayomiRepository(url);
              if (
                error instanceof Error &&
                (error.message === 'package_repository_suwayomi' ||
                  error.message === packageOperationMessage(new Error('package_repository_suwayomi')))
              )
                setApkRepository(url);
              throw error;
            }
            setRepositories(await manager.listRepositories!());
            setSelected(saved.url);
            setUrl('');
            setPage(0);
          });
        }}
      >
        <label>
          저장소 주소
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="https://example.com/extensions/index.json"
            value={url}
            maxLength={2048}
            required
            disabled={locked}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <button type="submit" disabled={locked || !url.trim()}>
          저장소 추가
        </button>
      </form>
      {error && (
        <p role="alert" className="field-help warning">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="field-help">
          저장소 작업을 처리하고 있습니다…
        </p>
      )}
      {apkRepository &&
        (onSuwayomiRepository ? (
          <button type="button" disabled={locked} onClick={() => onSuwayomiRepository(apkRepository)}>
            APK 저장소 관리 열기
          </button>
        ) : (
          <p className="field-help">설정의 소스 탭에서 Suwayomi 서버를 먼저 연결해 주세요.</p>
        ))}
      {mangayomiRepository &&
        (onMangayomiRepository ? (
          <button type="button" disabled={locked} onClick={() => onMangayomiRepository(mangayomiRepository)}>
            Mangayomi 저장소 관리 열기
          </button>
        ) : (
          <p className="field-help">Mangayomi 실행기를 포함한 서버 또는 앱 버전이 필요합니다.</p>
        ))}
      {!!repositories.length && (
        <>
          <label className="extension-repository-select">
            저장소
            <select
              aria-label="확장 저장소 선택"
              disabled={locked}
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setPage(0);
              }}
            >
              {repositories.map((item) => (
                <option key={item.url} value={item.url}>
                  {item.index?.name || item.url}
                </option>
              ))}
            </select>
          </label>
          {record && (
            <>
              <p className="field-help installed-extension-origin">{record.url}</p>
              <div className="installed-extension-actions">
                <button
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void run(async () => {
                      await manager.refreshRepository!(record.url);
                      setRepositories(await manager.listRepositories!());
                    })
                  }
                >
                  목록·업데이트 확인
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void run(async () => {
                      await manager.removeRepository!(record.url, record.revision);
                      const items = await manager.listRepositories!();
                      setRepositories(items);
                      setSelected(items[0]?.url ?? '');
                      setPage(0);
                    })
                  }
                >
                  저장소 삭제
                </button>
              </div>
              <p className="field-help">저장소를 삭제해도 설치한 확장과 받은 작품은 유지됩니다.</p>
            </>
          )}
          <label className="extension-repository-select">
            확장 검색
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="reader-settings-toggle">
            <input
              type="checkbox"
              checked={updatesOnly}
              onChange={(event) => {
                setUpdatesOnly(event.target.checked);
                setPage(0);
              }}
            />
            업데이트만 표시
          </label>
          <div className="extension-settings-list">
            {entries.slice(currentPage * 20, (currentPage + 1) * 20).map(({ entry, installed, newer }) => (
              <article key={entry.id} className="extension-settings-card">
                <strong>{entry.name || entry.id}</strong>
                <p className="field-help installed-extension-origin">
                  {entry.id} · v{entry.version}
                  {installed ? ` · 설치됨 v${installed.manifest.extension.version}` : ''}
                </p>
                {entry.description && <p className="field-help">{entry.description}</p>}
                {!renderReview?.(entry.id) && (
                  <button
                    type="button"
                    disabled={locked || (!!installed && !newer)}
                    onClick={() =>
                      void run(async () => {
                        onReview(await manager.selectRepositoryPackage!(record!.url, entry.id, entry.sha256));
                      })
                    }
                  >
                    {newer ? '업데이트' : installed ? '설치됨' : '설치'}
                  </button>
                )}
                {renderReview?.(entry.id)}
              </article>
            ))}
          </div>
          {!entries.length && <p className="field-help">표시할 확장이 없습니다.</p>}
          {lastPage > 0 && (
            <nav className="installed-extension-actions" aria-label="확장 목록 페이지">
              <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                이전
              </button>
              <span>
                {currentPage + 1} / {lastPage + 1}
              </span>
              <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
                다음
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
