import {
  AlertTriangle,
  Check,
  FileArchive,
  FileText,
  FolderOpen,
  Link2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Dialog } from '../../shared/ui/Dialog';
import { formatBytes, formatCount } from '../../utils/format';
import { LIBRARY_FOLDER_FORMATS, type LibraryFolderCandidateStatus } from '../../library-folders/contracts';
import type { LibraryFolderController } from './useLibraryFolderController';

const FORMAT_LABELS = {
  text: 'TXT / Markdown',
  epub: 'EPUB',
  pdf: 'PDF',
  zip: 'ZIP / CBZ',
  rar: 'RAR / CBR',
  '7z': '7z / CB7',
} as const;

function statusLabel(status: LibraryFolderCandidateStatus): string {
  switch (status) {
    case 'new':
      return '새 책';
    case 'changed':
      return '원본 변경';
    case 'update-existing':
      return '기존 책에 연결';
    case 'unchanged':
      return '최신';
    case 'missing':
      return '원본 없음';
    case 'failed':
      return '확인 실패';
    case 'below-minimum':
      return '최소 용량 미만';
    case 'above-maximum':
      return '최대 용량 초과';
    default:
      return '지원하지 않음';
  }
}

function statusTone(status: LibraryFolderCandidateStatus): string {
  if (status === 'new') return 'new';
  if (status === 'changed' || status === 'update-existing') return 'changed';
  if (status === 'missing' || status === 'failed') return 'missing';
  if (status === 'unchanged') return 'current';
  return 'muted';
}

function isActionable(status: LibraryFolderCandidateStatus): boolean {
  return status === 'new' || status === 'changed' || status === 'update-existing';
}

function megabytes(value: number | undefined): string {
  return value === undefined ? '' : String(Math.round((value / (1024 * 1024)) * 100) / 100);
}

export interface LibraryFolderPanelProps {
  readonly controller: LibraryFolderController;
}

export default function LibraryFolderPanel({ controller }: LibraryFolderPanelProps) {
  const folder = controller.activeFolder;
  const actionable = controller.candidates.filter((candidate) => isActionable(candidate.status));
  const selectedCount = actionable.filter((candidate) => candidate.selected).length;

  return (
    <Dialog
      open={controller.open}
      title="폴더 가져오기"
      className="library-folder-dialog"
      closeLabel="폴더 가져오기 닫기"
      closeDisabled={controller.busy}
      onClose={controller.close}
    >
      <div className="library-folder-layout">
        <aside className="library-folder-sidebar" aria-label="연결한 폴더">
          <div className="library-folder-sidebar-title">
            <strong>연결한 폴더</strong>
            <button
              type="button"
              className="icon-btn"
              aria-label="가져올 폴더 추가"
              title="가져올 폴더 추가"
              disabled={!controller.available || controller.busy}
              onClick={() => void controller.pickFolder()}
            >
              <FolderOpen size={17} />
            </button>
          </div>
          {controller.folders.length > 0 ? (
            <nav>
              {controller.folders.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={item.id === folder?.id ? 'active' : ''}
                  onClick={() => void controller.selectFolder(item.id)}
                  aria-pressed={item.id === folder?.id}
                >
                  <FolderOpen size={16} />
                  <span>
                    <strong>{item.displayName}</strong>
                    <small>{item.autoSync ? '자동 확인' : '수동 확인'}</small>
                  </span>
                  {item.lastError && <AlertTriangle size={14} aria-label="확인 필요" />}
                </button>
              ))}
            </nav>
          ) : (
            <p>아직 연결한 폴더가 없습니다.</p>
          )}
        </aside>

        <section className="library-folder-main">
          {!controller.available && controller.folders.length === 0 ? (
            <div className="library-folder-empty">
              <FolderOpen size={34} />
              <h3>이 환경에서는 지속적인 폴더 연결을 지원하지 않습니다.</h3>
              <p>일반 파일 가져오기는 그대로 사용할 수 있습니다.</p>
            </div>
          ) : !folder ? (
            <div className="library-folder-empty">
              <FolderOpen size={38} />
              <h3>소설이 있는 폴더를 연결하세요.</h3>
              <p>지원 형식과 용량 범위를 확인한 뒤 선택한 파일만 한 번에 가져옵니다.</p>
              <button className="primary-btn" type="button" onClick={() => void controller.pickFolder()}>
                <FolderOpen size={17} /> 폴더 선택
              </button>
            </div>
          ) : (
            <>
              <div className="library-folder-toolbar">
                <div>
                  <strong>{folder.displayName}</strong>
                  <span>
                    {folder.lastScanAt ? `마지막 확인 ${new Date(folder.lastScanAt).toLocaleString()}` : '확인 전'}
                  </span>
                </div>
                <div>
                  <button
                    className="ghost-btn"
                    type="button"
                    disabled={controller.busy || controller.scanning}
                    onClick={() => void controller.scanActiveFolder()}
                  >
                    <RefreshCw size={16} className={controller.scanning ? 'spin' : undefined} /> 다시 확인
                  </button>
                  <button
                    className="icon-btn danger"
                    type="button"
                    aria-label="폴더 연결 해제"
                    title="폴더 연결 해제"
                    disabled={controller.busy}
                    onClick={() => {
                      if (window.confirm('폴더 연결만 해제합니다. 이미 가져온 책은 삭제되지 않습니다.')) {
                        void controller.removeActiveFolder();
                      }
                    }}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>

              <div className="library-folder-filters">
                <fieldset>
                  <legend>형식</legend>
                  {LIBRARY_FOLDER_FORMATS.map((format) => (
                    <label key={format}>
                      <input
                        type="checkbox"
                        checked={folder.filter.formats.includes(format)}
                        disabled={controller.busy}
                        onChange={(event) => {
                          const formats = event.target.checked
                            ? [...folder.filter.formats, format]
                            : folder.filter.formats.filter((item) => item !== format);
                          void controller.updateFilter({ formats });
                        }}
                      />
                      {FORMAT_LABELS[format]}
                    </label>
                  ))}
                </fieldset>
                <div className="library-folder-size-filter">
                  <span>파일 용량 (MB)</span>
                  <label>
                    <span>최소</span>
                    <input
                      key={`${folder.id}-min-${folder.filter.minBytes}`}
                      type="number"
                      min="0"
                      step="0.1"
                      defaultValue={megabytes(folder.filter.minBytes)}
                      placeholder="제한 없음"
                      disabled={controller.busy}
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        void controller.updateFilter({
                          minBytes:
                            event.target.value && Number.isFinite(value) ? Math.max(0, value) * 1024 * 1024 : undefined,
                        });
                      }}
                    />
                  </label>
                  <label>
                    <span>최대</span>
                    <input
                      key={`${folder.id}-max-${folder.filter.maxBytes}`}
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={megabytes(folder.filter.maxBytes)}
                      placeholder="제한 없음"
                      disabled={controller.busy}
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        void controller.updateFilter({
                          maxBytes:
                            event.target.value && Number.isFinite(value) ? Math.max(0, value) * 1024 * 1024 : undefined,
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="library-folder-switches">
                  <label>
                    <input
                      type="checkbox"
                      checked={folder.filter.recursive}
                      disabled={controller.busy}
                      onChange={(event) => void controller.updateFilter({ recursive: event.target.checked })}
                    />
                    하위 폴더 포함
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={folder.autoSync}
                      disabled={controller.busy}
                      onChange={(event) => void controller.setAutoSync(event.target.checked)}
                    />
                    변경 자동 반영
                  </label>
                </div>
              </div>

              {folder.lastError && <p className="library-folder-error">{folder.lastError}</p>}

              <div className="library-folder-list-head">
                <label>
                  <input
                    type="checkbox"
                    checked={actionable.length > 0 && selectedCount === actionable.length}
                    disabled={actionable.length === 0 || controller.busy}
                    onChange={(event) => controller.selectAllActionable(event.target.checked)}
                  />
                  <strong>{formatCount(controller.candidates.length)}개 파일</strong>
                </label>
                <span>{selectedCount ? `${formatCount(selectedCount)}개 선택` : '가져올 변경 없음'}</span>
              </div>

              <div className="library-folder-file-list" aria-label="폴더 파일 미리보기">
                {controller.scanning && controller.candidates.length === 0 ? (
                  <div className="library-folder-list-empty" role="status">
                    <RefreshCw size={22} className="spin" /> 폴더를 확인하고 있습니다.
                  </div>
                ) : controller.candidates.length === 0 ? (
                  <div className="library-folder-list-empty">선택한 조건에 표시할 파일이 없습니다.</div>
                ) : (
                  controller.candidates.map((candidate) => (
                    <label className="library-folder-file-row" key={candidate.id}>
                      <input
                        type="checkbox"
                        checked={candidate.selected}
                        disabled={!isActionable(candidate.status) || controller.busy}
                        onChange={() => controller.toggleCandidate(candidate.id)}
                      />
                      <span className="library-folder-file-icon" aria-hidden="true">
                        {candidate.format === 'text' || candidate.format === 'epub' || candidate.format === 'pdf' ? (
                          <FileText size={18} />
                        ) : (
                          <FileArchive size={18} />
                        )}
                      </span>
                      <span className="library-folder-file-name">
                        <strong>{candidate.fileName}</strong>
                        <small>{candidate.relativePath}</small>
                        {candidate.existingBookTitle && <em>연결 대상: {candidate.existingBookTitle}</em>}
                        {candidate.readError && <em>{candidate.readError}</em>}
                      </span>
                      <span className="library-folder-file-size">{formatBytes(candidate.byteLength)}</span>
                      <span className={`library-folder-status ${statusTone(candidate.status)}`}>
                        {candidate.status === 'unchanged' && <Check size={13} />}
                        {candidate.status === 'update-existing' && <Link2 size={13} />}
                        {statusLabel(candidate.status)}
                      </span>
                    </label>
                  ))
                )}
              </div>

              {controller.progress && (
                <div className="library-folder-progress" role="status" aria-live="polite">
                  <span>
                    {controller.progress.fileName ?? '폴더 가져오기'} · {controller.progress.current}/
                    {controller.progress.total}
                  </span>
                  <progress
                    max={Math.max(1, controller.progress.total)}
                    value={controller.progress.completed + controller.progress.linkedExisting}
                  />
                  {controller.progress.detail?.message && <small>{controller.progress.detail.message}</small>}
                </div>
              )}

              <div className="library-folder-actions">
                <p>
                  삭제된 원본은 책장에서 지우지 않고 <strong>원본 없음</strong>으로만 표시합니다.
                </p>
                {controller.busy ? (
                  <button className="ghost-btn danger" type="button" onClick={controller.cancel}>
                    중단
                  </button>
                ) : (
                  <button
                    className="primary-btn"
                    type="button"
                    disabled={selectedCount === 0 || controller.scanning}
                    onClick={() => void controller.importSelected()}
                  >
                    <Upload size={16} /> 선택한 {formatCount(selectedCount)}개 가져오기
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
