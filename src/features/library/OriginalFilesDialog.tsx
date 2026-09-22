import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { OriginalFileEntry } from '@noveldesk/contracts';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { Dialog } from '../../shared/ui/Dialog';
import './original-files.css';

function fileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function OriginalFilesDialog({
  book,
  repository,
  onClose,
  onLegacyExport,
}: {
  book: { id: string; title: string };
  repository: BookAssetRepository;
  onClose(): void;
  onLegacyExport(): void;
}) {
  const [files, setFiles] = useState<readonly OriginalFileEntry[] | null>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string>();
  const [requested, setRequested] = useState('');
  const [reload, setReload] = useState(0);
  const [visible, setVisible] = useState(30);
  const generation = useRef(0);
  useEffect(() => {
    const run = ++generation.current;
    const abort = new AbortController();
    setFiles(undefined);
    setError('');
    setPending(undefined);
    setRequested('');
    setVisible(30);
    void repository.listOriginalFiles!(book.id, abort.signal).then(
      (result) => {
        if (generation.current === run) setFiles(result);
      },
      () => {
        if (generation.current === run) setError('원본 목록을 불러오지 못했습니다. 다시 시도해 주세요.');
      },
    );
    return () => {
      generation.current = run + 1;
      abort.abort();
    };
  }, [repository, book.id, reload]);

  async function download(file: OriginalFileEntry) {
    const run = generation.current;
    setPending(file.id);
    setError('');
    try {
      const url = await repository.createOriginalFileDownload!(book.id, file.id);
      if (generation.current !== run) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.append(link);
      link.click();
      link.remove();
      // Completion/cancellation belongs to the browser download manager.
      setRequested('다운로드를 요청했습니다. 진행 상황은 브라우저에서 확인하세요.');
    } catch {
      if (generation.current === run) setError('다운로드를 시작하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (generation.current === run) setPending(undefined);
    }
  }

  return (
    <Dialog open title="원본 다운로드" onClose={onClose} className="original-files-dialog">
      <p className="original-files-title">{book.title}</p>
      <p className="muted">파일별로 저장합니다. 읽기 기록은 포함되지 않습니다.</p>
      {files === undefined && !error && <p role="status">원본 목록을 불러오는 중…</p>}
      {error && (
        <div className="original-files-error" role="alert">
          <span>{error}</span>
          {files === undefined && (
            <button className="ghost-btn" type="button" onClick={() => setReload((n) => n + 1)}>
              <RefreshCw size={16} aria-hidden="true" /> 다시 시도
            </button>
          )}
        </div>
      )}
      {files === null && (
        <button className="ghost-btn" type="button" onClick={onLegacyExport}>
          원본 파일 저장
        </button>
      )}
      {files && (
        <>
          <ul className="original-files-list">
            {files.slice(0, visible).map((file) => (
              <li key={file.id}>
                <div>
                  <span className="original-files-name">{file.fileName}</span>
                  <small className="muted">{fileSize(file.byteLength)}</small>
                </div>
                <button
                  className="icon-btn"
                  type="button"
                  disabled={pending !== undefined}
                  aria-label={`${file.fileName} 다운로드`}
                  aria-busy={pending === file.id}
                  onClick={() => void download(file)}
                >
                  <Download size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {files.length > visible && (
            <button className="ghost-btn" type="button" onClick={() => setVisible((n) => n + 30)}>
              더 보기
            </button>
          )}
          {!files.length && <p>보관된 원본 파일이 없습니다.</p>}
        </>
      )}
      {requested && (
        <p className="muted" role="status">
          {requested}
        </p>
      )}
    </Dialog>
  );
}
