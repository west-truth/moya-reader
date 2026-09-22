import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, HardDrive, RefreshCw } from 'lucide-react';
import type { LibraryStorageUsage } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import { DeviceStorageEstimate, formatStorageBytes } from './DeviceStorageEstimate';
import { DownloadSettingsPanel } from './DownloadSettingsPanel';
import { StorageBookManager, type StorageManagement } from './StorageBookManager';
import './storage-settings.css';

export interface StorageSettingsProps {
  readonly assets?: BookAssetRepository;
  readonly management?: StorageManagement;
  readonly hosted?: boolean;
}

export function StorageSettingsPanel({
  assets,
  management,
  hosted,
  controller,
  openBackup,
  focusDownloads = false,
  onBusyChange,
}: StorageSettingsProps & {
  controller: ExternalSourceController;
  openBackup(): void;
  focusDownloads?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const [usage, setUsage] = useState<LibraryStorageUsage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(focusDownloads);
  const downloads = useRef<HTMLDetailsElement>(null);
  const generation = useRef({ value: 0 }).current;
  const refresh = useCallback(async () => {
    const request = ++generation.value;
    if (!assets?.getStorageUsage) {
      setLoading(false);
      setError('이 환경에서는 작품별 용량을 확인할 수 없습니다.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await assets.getStorageUsage();
      if (request === generation.value) setUsage(result);
    } catch {
      if (request === generation.value) setError('사용량을 불러오지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (request === generation.value) setLoading(false);
    }
  }, [assets, generation]);
  useEffect(() => {
    setUsage(undefined);
    void refresh();
    return () => {
      generation.value++;
    };
  }, [refresh, generation]);
  useEffect(() => {
    if (!focusDownloads) return;
    setDownloadOpen(true);
    const frame = requestAnimationFrame(() => downloads.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [focusDownloads]);
  const retention = controller.downloadRetention;
  const refreshButton = (
    <button
      type="button"
      className="icon-btn"
      aria-label="사용량 새로고침"
      disabled={loading}
      onClick={() => void refresh()}
    >
      <RefreshCw size={18} />
    </button>
  );
  if (managing && usage)
    return (
      <>
        {error && (
          <p role="alert">
            {error} {refreshButton}
          </p>
        )}
        <StorageBookManager
          usage={usage}
          management={management}
          refresh={refresh}
          onBack={() => setManaging(false)}
          onBusyChange={onBusyChange}
        />
      </>
    );
  return (
    <div className="reader-settings-destination-sections storage-settings">
      <section className="settings-section-card">
        <div className="storage-summary-heading">
          <h3>
            <HardDrive size={18} aria-hidden="true" />
            {hosted ? '서버의 보관 파일' : '이 기기의 작품 파일'}
          </h3>
          {refreshButton}
        </div>
        {loading && !usage && <p role="status">사용량 확인 중…</p>}
        {error && <p role="alert">{error}</p>}
        {usage && (
          <>
            <strong className="storage-total">{formatStorageBytes(usage.totalBytes)}</strong>
            <dl className="storage-summary-values">
              <div>
                <dt>책장 · {usage.books.filter((b) => !b.trashed).length}개 작품</dt>
                <dd>{formatStorageBytes(usage.libraryBytes)}</dd>
              </div>
              <div>
                <dt>휴지통 · {usage.books.filter((b) => b.trashed).length}개 작품</dt>
                <dd>{formatStorageBytes(usage.trashBytes)}</dd>
              </div>
            </dl>
            <button type="button" className="ghost-btn" onClick={() => setManaging(true)}>
              작품별 관리
            </button>
          </>
        )}
        <p className="field-help">현재 보관한 원본·회차·이미지 용량입니다. DB·캐시·임시 파일은 제외됩니다.</p>
      </section>
      <section className="settings-section-card">
        <DeviceStorageEstimate />
      </section>
      {retention && (
        <section className="settings-section-card">
          <h3>읽은 다운로드 정리</h3>
          <p className="field-help">원본 파일·즐겨찾기·미독 회차는 보존합니다.</p>
          <div className="storage-book-actions">
            <button
              type="button"
              className="ghost-btn"
              disabled={retention.busy || controller.busy || management?.blocked}
              onClick={() => void retention.inspect()}
            >
              정리 대상 확인
            </button>
            {Boolean(retention.preview?.length) && (
              <button
                type="button"
                className="ghost-btn"
                disabled={retention.busy || controller.busy || management?.blocked || retention.readerActive}
                onClick={async () => {
                  await retention.clean();
                  await refresh();
                }}
              >
                확인 후 정리
              </button>
            )}
          </div>
          {retention.busy && <p role="status">정리 중…</p>}
          {retention.preview && (
            <div role="status">
              {retention.preview.length ? (
                <details>
                  <summary>
                    {retention.preview.length}개 작품 ·{' '}
                    {retention.preview.reduce((sum, p) => sum + p.sections.length, 0)}회 정리 가능
                  </summary>
                  <ul>
                    {retention.preview.map((p) => (
                      <li key={p.bookId}>
                        {p.title} · {p.sections.length}회
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p>지금 정리할 회차가 없습니다.</p>
              )}
            </div>
          )}
          {retention.error && <p role="alert">{retention.error}</p>}
        </section>
      )}
      <section className="settings-section-card">
        <div className="settings-section-heading">
          <ArchiveRestore size={18} aria-hidden="true" />
          <h3>백업과 복원</h3>
        </div>
        <button type="button" className="ghost-btn" onClick={openBackup}>
          백업과 복원 열기
        </button>
      </section>
      <details
        ref={downloads}
        className="storage-download-options"
        open={downloadOpen}
        onToggle={(e) => setDownloadOpen(e.currentTarget.open)}
      >
        <summary>소스 다운로드 · 자동 정리</summary>
        <DownloadSettingsPanel controller={controller} />
      </details>
    </div>
  );
}
