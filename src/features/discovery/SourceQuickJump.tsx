import { useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { Dialog } from '../../shared/ui/Dialog';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { ExternalSourceListInput } from '../../external-sources/contracts';

export function SourceQuickJump({
  sources,
  close,
  open,
}: {
  sources: readonly ExternalSourceView[];
  close(): void;
  open(source: string, input: ExternalSourceListInput): void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const matches = sources.filter((source) =>
    source.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <Dialog
      open
      title="소스 빠른 이동"
      onClose={close}
      initialFocusRef={search}
      className="discovery-quick-jump"
      closeLabel="빠른 이동 닫기"
    >
      <label className="discovery-search">
        <Search size={18} aria-hidden="true" />
        <input
          ref={search}
          type="search"
          aria-label="이동할 소스 검색"
          placeholder="소스 이름으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="discovery-quick-jump-list">
        {matches.map((source) => (
          <button
            type="button"
            className="ghost-btn"
            key={source.id}
            disabled={source.connection.state !== 'connected'}
            onClick={() => {
              close();
              open(source.id, source.kind === 'cloud_file' ? {} : { browseMode: 'popular' });
            }}
          >
            <span>
              {source.title}
              {source.connection.state !== 'connected' && <small>소스 설정에서 연결해 주세요</small>}
            </span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        ))}
        {!matches.length && (
          <p>{sources.length ? '일치하는 소스가 없습니다.' : '콘텐츠 소스 설정에서 소스를 추가해 주세요.'}</p>
        )}
      </div>
    </Dialog>
  );
}
