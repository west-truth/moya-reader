import { ArchiveRestore, DatabaseBackup, FileArchive, Upload } from 'lucide-react';
import { useRef } from 'react';
import { Dialog } from '../../shared/ui/Dialog';
import { formatBytes, formatCount } from '../../utils/format';
import type { BackupConflictResolution } from '../../repositories/backup-repository';
import type { BackupFeatureController } from './useBackupController';

const resolutionOptions: Array<{ value: BackupConflictResolution; label: string }> = [
  { value: 'skip', label: '기존 책 유지' },
  { value: 'replace', label: '백업으로 교체' },
  { value: 'copy', label: '복사본으로 추가' },
];

export default function BackupPanel({ controller }: { controller: BackupFeatureController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inspection = controller.inspection;
  return (
    <Dialog
      open={controller.open}
      title="백업 및 복원"
      onClose={controller.closePanel}
      closeDisabled={controller.busy}
      closeLabel="백업 패널 닫기"
      className="backup-dialog"
    >
      {!controller.available ? (
        <div className="empty-panel backup-unavailable">
          <DatabaseBackup size={34} />
          <strong>현재 실행 환경에서 전체 백업을 사용할 수 없습니다.</strong>
          <span>로컬 서재에서 백업을 만들거나 서버 관리 기능을 확인하세요.</span>
        </div>
      ) : (
        <>
          <section className="backup-action-block">
            <div>
              <DatabaseBackup size={22} />
              <span>
                <strong>전체 백업 만들기</strong>
                <small>책, 원본, 읽던 위치, 주석과 사용자 설정을 ZIP 하나로 저장합니다.</small>
              </span>
            </div>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void controller.exportBackup()}
              disabled={controller.busy}
              data-dialog-initial-focus
            >
              <DatabaseBackup size={17} /> 백업 만들기
            </button>
          </section>

          <section className="backup-action-block">
            <div>
              <ArchiveRestore size={22} />
              <span>
                <strong>백업 복원</strong>
                <small>파일을 먼저 검사한 뒤 충돌 처리 방식을 선택합니다.</small>
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void controller.inspectFile(file);
              }}
            />
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                if (controller.usesPlatformPicker) void controller.pickBackupFile();
                else inputRef.current?.click();
              }}
              disabled={controller.busy}
            >
              <Upload size={17} /> 백업 파일 선택
            </button>
          </section>

          {inspection && (
            <section className="backup-inspection">
              <div className="backup-file-summary">
                <FileArchive size={20} />
                <span>
                  <strong>{formatCount(inspection.manifest.books.length)}권</strong>
                  <small>
                    {formatBytes(inspection.archiveByteLength)} · 압축 해제{' '}
                    {formatBytes(inspection.totalUncompressedBytes)}
                  </small>
                </span>
              </div>
              {inspection.conflicts.length > 0 && (
                <div className="backup-conflicts">
                  <label>
                    <span>기본 충돌 처리</span>
                    <select
                      value={controller.defaultResolution}
                      onChange={(event) =>
                        controller.setDefaultResolution(event.target.value as BackupConflictResolution)
                      }
                    >
                      {resolutionOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {inspection.conflicts.map((conflict) => (
                    <label key={conflict.bookId}>
                      <span title={conflict.title}>{conflict.title}</span>
                      <select
                        value={controller.conflictResolutions[conflict.bookId] ?? controller.defaultResolution}
                        onChange={(event) =>
                          controller.setConflictResolution(
                            conflict.bookId,
                            event.target.value as BackupConflictResolution,
                          )
                        }
                      >
                        {resolutionOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              {inspection.warnings.map((warning) => (
                <p className="field-help warning" key={warning}>
                  {warning}
                </p>
              ))}
              <button
                type="button"
                className="primary-btn backup-restore-button"
                onClick={() => void controller.restoreBackup()}
                disabled={controller.busy}
              >
                <ArchiveRestore size={17} /> 검사한 백업 복원
              </button>
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
