import { useEffect, useRef, useState } from 'react';
import type {
  SourceExtensionEntry,
  SourceExtensionInventory,
  SourceExtensionManager,
} from '../../external-sources/extension-management';

function repositoryKey(url: string) {
  return url.replace(/\/(?:index\.min|repo)\.json$/, '').replace(/\/$/, '');
}

export function SourceExtensionManagerPanel({
  manager,
  initialRepository = '',
}: {
  manager: SourceExtensionManager;
  initialRepository?: string;
}) {
  const [inventory, setInventory] = useState<SourceExtensionInventory>();
  const [url, setUrl] = useState(initialRepository);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<{ entry: SourceExtensionEntry; action: 'install' | 'update' | 'uninstall' }>();
  const [remove, setRemove] = useState<string>();
  const pending = useRef<AbortController>();
  const reviewElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (review || remove) reviewElement.current?.focus();
  }, [review, remove]);
  const current = useRef(manager);
  current.current = manager;
  useEffect(() => {
    setUrl(initialRepository);
  }, [initialRepository]);
  useEffect(() => {
    const abort = new AbortController();
    pending.current = abort;
    setInventory(undefined);
    setError('');
    setMessage('');
    setReview(undefined);
    setRemove(undefined);
    setSelected('');
    setPage(0);
    setBusy(true);
    void manager
      .list(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setInventory(value);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError('확장 목록을 불러오지 못했습니다. Suwayomi 연결과 서버 버전을 확인해 주세요.');
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          pending.current = undefined;
          setBusy(false);
        }
      });
    return () => {
      abort.abort();
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [manager]);
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await task(abort.signal);
    } catch (error) {
      if (!abort.signal.aborted && current.current === manager)
        setError(
          error instanceof Error && /[가-힣]/.test(error.message)
            ? error.message
            : '작업을 완료하지 못했습니다. 새로고침으로 서버 상태를 확인해 주세요.',
        );
    } finally {
      if (!abort.signal.aborted && current.current === manager) {
        pending.current = undefined;
        setBusy(false);
      }
    }
  };
  const load = async (signal: AbortSignal, refresh = false) => {
    const value = await (refresh ? manager.refresh(signal) : manager.list(signal));
    if (!signal.aborted && current.current === manager) setInventory(value);
  };
  const rows = (inventory?.extensions ?? []).filter(
    (entry) =>
      (!selected || repositoryKey(entry.repository ?? '') === repositoryKey(selected)) &&
      (filter !== 'installed' || entry.installed) &&
      (filter !== 'updates' || (entry.installed && entry.hasUpdate)) &&
      `${entry.name} ${entry.id} ${entry.lang}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(rows.length / 20) - 1);
  const currentPage = Math.min(page, lastPage);
  const reviewCard = review && (
    <div
      ref={reviewElement}
      tabIndex={-1}
      className="source-extension-review"
      role="group"
      aria-label="Suwayomi 확장 작업 확인"
    >
      <strong>
        {review.entry.name} · {review.entry.version}
      </strong>
      <p className="field-help installed-extension-origin">{review.entry.repository || review.entry.id}</p>
      <p className="field-help">
        {review.action === 'uninstall'
          ? '확장을 제거해도 모야에 다운로드한 작품은 유지됩니다.'
          : '이 저장소의 확장 코드를 Suwayomi 서버에서 실행합니다. 출처를 확인해 주세요.'}
      </p>
      <div className="installed-extension-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async (signal) => {
              await manager.change(review.entry.id, review.action, signal);
              if (signal.aborted) return;
              setReview(undefined);
              setMessage('확장 작업을 완료했습니다. 소스 화면을 새로고침하면 반영됩니다.');
              await load(signal);
            })
          }
        >
          {review.action === 'install' ? '설치' : review.action === 'update' ? '업데이트' : '제거'}
        </button>
        <button type="button" disabled={busy} onClick={() => setReview(undefined)}>
          취소
        </button>
      </div>
    </div>
  );
  return (
    <section className="extension-repository-browser source-extension-manager" aria-label="Suwayomi 확장 관리">
      <p className="field-help">
        연결된 Suwayomi 서버에 설치합니다. 저장소는 여러 개 추가할 수 있으며, 이미지로 제공되는 소설도 사용할 수
        있습니다.
      </p>
      <form
        className="extension-repository-add"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async (signal) => {
            await manager.addRepository(url, signal);
            if (signal.aborted) return;
            setUrl('');
            setMessage('저장소를 추가했습니다. 확장 목록을 확인하고 있습니다.');
            await load(signal, true);
            if (!signal.aborted) setMessage('저장소를 추가했습니다.');
          });
        }}
      >
        <label>
          Suwayomi 저장소 주소
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="https://example.com/index.min.json"
            value={url}
            maxLength={2048}
            required
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !url.trim()}>
          저장소 추가
        </button>
      </form>
      {error && (
        <p role="alert" className="field-help warning">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="field-help">
          {message}
        </p>
      )}
      {busy && (
        <p role="status" className="field-help">
          Suwayomi에서 처리하고 있습니다…
        </p>
      )}
      <div className="installed-extension-actions">
        <button type="button" disabled={busy} onClick={() => void run((signal) => load(signal))}>
          상태 새로고침
        </button>
        <button type="button" disabled={busy} onClick={() => void run((signal) => load(signal, true))}>
          업데이트 확인
        </button>
      </div>
      <label className="extension-repository-select">
        저장소
        <select
          aria-label="Suwayomi 저장소 선택"
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setPage(0);
            setRemove(undefined);
          }}
        >
          <option value="">모든 저장소</option>
          {inventory?.repositories.map((repo) => (
            <option key={repo.url} value={repo.url}>
              {repo.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div>
          <p className="field-help installed-extension-origin">{selected}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRemove(selected);
              setReview(undefined);
            }}
          >
            저장소 제거
          </button>
        </div>
      )}
      {remove && (
        <div
          ref={reviewElement}
          tabIndex={-1}
          className="source-extension-review"
          role="group"
          aria-label="저장소 제거 확인"
        >
          <p>저장소를 제거할까요? 이미 설치한 확장과 다운로드한 작품은 유지됩니다.</p>
          <div className="installed-extension-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  await manager.removeRepository(remove, signal);
                  if (signal.aborted) return;
                  setRemove(undefined);
                  setSelected('');
                  await load(signal);
                })
              }
            >
              제거
            </button>
            <button type="button" disabled={busy} onClick={() => setRemove(undefined)}>
              취소
            </button>
          </div>
        </div>
      )}
      <div className="source-extension-filters">
        <label>
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
        <label>
          표시
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">전체</option>
            <option value="installed">설치됨</option>
            <option value="updates">업데이트 있음</option>
          </select>
        </label>
      </div>
      <ul className="source-extension-list">
        {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((entry) => (
          <li key={entry.id}>
            <div>
              <strong>{entry.name}</strong>
              <small>
                {entry.lang} · {entry.version}
                {entry.installed ? ' · 설치됨' : ''}
                {entry.obsolete ? ' · 배포 중단' : ''}
              </small>
            </div>
            <div className="installed-extension-actions">
              {!entry.installed && (
                <button
                  type="button"
                  disabled={busy || entry.obsolete}
                  onClick={() => {
                    setReview({ entry, action: 'install' });
                    setRemove(undefined);
                  }}
                >
                  설치
                </button>
              )}
              {entry.installed && entry.hasUpdate && (
                <button
                  type="button"
                  disabled={busy || entry.obsolete}
                  onClick={() => {
                    setReview({ entry, action: 'update' });
                    setRemove(undefined);
                  }}
                >
                  업데이트
                </button>
              )}
              {entry.installed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setReview({ entry, action: 'uninstall' });
                    setRemove(undefined);
                  }}
                >
                  제거
                </button>
              )}
            </div>
            {review?.entry.id === entry.id && reviewCard}
          </li>
        ))}
      </ul>
      {inventory && !rows.length && <p className="field-help">표시할 만화 확장이 없습니다.</p>}
      <div className="installed-extension-actions" aria-label="Suwayomi 확장 목록 페이지">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          이전
        </button>
        <span>
          {currentPage + 1} / {lastPage + 1} · {rows.length}개
        </span>
        <button type="button" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>
          다음
        </button>
      </div>
    </section>
  );
}
