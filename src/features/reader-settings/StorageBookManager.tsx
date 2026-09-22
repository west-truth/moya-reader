import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { LibraryStorageUsage } from '../../domain/types';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import { formatStorageBytes } from './DeviceStorageEstimate';

export interface StorageManagement {
  readonly catalog?: LibraryCatalogRepository;
  readonly blocked: boolean;
  onChanged(): Promise<void>;
}

export function StorageBookManager({
  usage,
  management,
  refresh,
  onBack,
  onBusyChange,
}: {
  usage: LibraryStorageUsage;
  management?: StorageManagement;
  refresh(): Promise<void>;
  onBack(): void;
  onBusyChange?(busy: boolean): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    const content = heading.current?.closest('.reader-settings-content');
    if (content) content.scrollTop = 0;
  }, []);
  const [trash, setTrash] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('size');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const latest = useRef(management);
  latest.current = management;
  const books = usage.books
    .filter((b) => b.trashed === trash && b.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) =>
      sort === 'size' ? b.bytes - a.bytes || a.title.localeCompare(b.title) : a.title.localeCompare(b.title),
    );
  const targets = books.filter((b) => selected.has(b.id));
  const disabled = busy || !management?.catalog || management.blocked;

  async function mutate(action: 'moveToTrash' | 'restore' | 'purge') {
    const catalog = latest.current?.catalog;
    if (lock.current || latest.current?.blocked || !catalog || !targets.length) return;
    const label = action === 'purge' ? '영구 삭제' : action === 'restore' ? '복원' : '휴지통 이동';
    const titles = targets
      .slice(0, 3)
      .map((b) => b.title)
      .join(', ');
    if (
      !window.confirm(
        `${titles}${targets.length > 3 ? ' 외' : ''}\n선택한 ${targets.length}개 작품을 ${label}할까요?${action === 'purge' ? '\n원본과 독서 기록이 삭제되며 되돌릴 수 없습니다.' : action === 'moveToTrash' ? '\n공간을 비우려면 휴지통에서 영구 삭제해야 합니다.' : ''}`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setMessage('');
    let completed = 0;
    try {
      for (const book of targets) {
        if (latest.current?.blocked || latest.current?.catalog !== catalog) break;
        try {
          await catalog[action](book.id, book.metadataRevision);
          completed++;
        } catch {
          // A changed revision or failed request remains untouched; refresh before retry.
        }
      }
      setSelected(new Set());
      const remaining = targets.length - completed;
      setMessage(
        `${completed}개 ${label} 완료${remaining ? ` · ${remaining}개 미처리. 목록을 확인하고 다시 선택해 주세요.` : ''}${action === 'purge' && completed ? ' 저장공간 반영에는 시간이 걸릴 수 있습니다.' : ''}`,
      );
      // Refresh on partial success, too; never leave already-deleted entries selected.
      await management?.onChanged();
      await refresh();
    } catch {
      setMessage(`${completed}개 ${label} 완료. 목록을 새로고침해 주세요.`);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="storage-book-manager" aria-busy={busy}>
      <button type="button" className="ghost-btn" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} /> 사용량 요약
      </button>
      <div className="storage-summary-heading">
        <h3 ref={heading} tabIndex={-1}>
          작품별 관리
        </h3>
        <button
          type="button"
          className="icon-btn"
          aria-label="작품 용량 새로고침"
          disabled={busy}
          onClick={() => {
            setSelected(new Set());
            void refresh();
          }}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="storage-book-controls">
        <label>
          <span className="sr-only">작품 위치</span>
          <select
            value={trash ? 'trash' : 'library'}
            disabled={busy}
            onChange={(e) => {
              setTrash(e.target.value === 'trash');
              setSelected(new Set());
              setLimit(50);
              setMessage('');
            }}
          >
            <option value="library">책장</option>
            <option value="trash">휴지통</option>
          </select>
        </label>
        <label>
          <span className="sr-only">작품 검색</span>
          <input
            type="search"
            placeholder="작품 검색"
            value={query}
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(new Set());
              setLimit(50);
            }}
          />
        </label>
        <label>
          <span className="sr-only">정렬</span>
          <select value={sort} disabled={busy} onChange={(e) => setSort(e.target.value)}>
            <option value="size">용량 큰 순</option>
            <option value="name">이름순</option>
          </select>
        </label>
      </div>
      <p className="muted">{books.length}개 작품 · 공유 파일은 작품마다 표시됩니다.</p>
      {management?.blocked && <p role="status">독서·다운로드·가져오기를 마친 뒤 정리할 수 있습니다.</p>}
      {busy ? <p role="status">처리 중…</p> : message && <p role="status">{message}</p>}
      <div className="storage-book-actions">
        <span>
          {targets.length}개 선택 · {formatStorageBytes(targets.reduce((sum, b) => sum + b.bytes, 0))}
        </span>
        <button
          type="button"
          className="ghost-btn"
          disabled={disabled || !targets.length}
          onClick={() => void mutate(trash ? 'restore' : 'moveToTrash')}
        >
          {trash ? '복원' : '휴지통 이동'}
        </button>
        {trash && (
          <button
            type="button"
            className="ghost-btn"
            disabled={disabled || !targets.length}
            onClick={() => void mutate('purge')}
          >
            영구 삭제
          </button>
        )}
      </div>
      <ul className="storage-book-list">
        {books.slice(0, limit).map((book) => (
          <li key={book.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(book.id)}
                disabled={disabled}
                onChange={(e) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (e.target.checked) next.add(book.id);
                    else next.delete(book.id);
                    return next;
                  })
                }
              />
              <span>{book.title}</span>
              <strong>{formatStorageBytes(book.bytes)}</strong>
            </label>
          </li>
        ))}
      </ul>
      {!books.length && <p>해당 작품이 없습니다.</p>}
      {books.length > limit && (
        <button type="button" className="ghost-btn" onClick={() => setLimit((n) => n + 50)}>
          더 보기
        </button>
      )}
    </div>
  );
}
