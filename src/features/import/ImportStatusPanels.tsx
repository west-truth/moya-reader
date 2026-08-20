import type { ImportFeatureController } from './useImportController';
import { formatCount } from '../../utils/format';
import { formatImportBytes, importProgressPercent } from './import-formatting';

function classNames(...values: Array<string | false>): string {
  return values.filter(Boolean).join(' ');
}

export function ImportPreviewPanel({ controller }: { controller: ImportFeatureController }) {
  const preview = controller.preview;
  if (!preview) return null;
  const previewPercent =
    preview.totalBytes === undefined ? 0 : importProgressPercent(preview.bytesRead ?? 0, preview.totalBytes);

  return (
    <div className={classNames('import-preview-card', preview.status)}>
      <div className="setting-line">
        <h3>{preview.status === 'loading' ? '미리보기 계산 중' : '화 분리 미리보기'}</h3>
        <span>
          {preview.result
            ? `${formatCount(preview.result.totalChapters)}화`
            : preview.status === 'failed'
              ? '실패'
              : '대기'}
        </span>
      </div>
      {preview.message && <p className="muted">{preview.message}</p>}
      {preview.status === 'loading' && preview.totalBytes !== undefined && (
        <>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="화 분리 미리보기 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={previewPercent}
          >
            <span style={{ width: `${previewPercent}%` }} />
          </div>
          <p className="field-help">
            {formatImportBytes(preview.bytesRead ?? 0)} / {formatImportBytes(preview.totalBytes)}
          </p>
        </>
      )}
      {preview.result && (
        <>
          <p className="field-help">
            {preview.result.sourceEncoding.toUpperCase()} · {formatCount(preview.result.totalCharacters)}자 ·{' '}
            {formatCount(preview.result.totalParagraphs)}문단
          </p>
          <div className="import-preview-list">
            {preview.result.chapters.slice(0, 8).map((chapter) => (
              <div key={`${chapter.index}:${chapter.title}`} className="import-preview-row">
                <span>{chapter.index}</span>
                <strong>{chapter.title}</strong>
                <em>{formatCount(chapter.paragraphCount)}문단</em>
              </div>
            ))}
            {preview.result.totalChapters > 8 && (
              <p className="field-help">외 {formatCount(preview.result.totalChapters - 8)}개 화가 더 있습니다.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function ImportProgressPanel({ controller }: { controller: ImportFeatureController }) {
  const { batch, progress } = controller;
  if (!progress && !batch) return null;
  const percent = progress ? importProgressPercent(progress.bytesRead, progress.totalBytes) : 0;

  return (
    <div className="import-progress">
      <div className="setting-line">
        <h3>
          {progress?.status === 'ready'
            ? '가져오기 완료'
            : progress?.status === 'failed'
              ? '가져오기 실패'
              : progress?.status === 'cancelling'
                ? '취소하는 중'
                : '가져오는 중'}
        </h3>
        <span>{progress ? `${percent}%` : '-'}</span>
      </div>
      {batch && (
        <div className="import-batch-summary">
          <strong>{batch.currentFileName ?? '대기 중'}</strong>
          <span>
            {formatCount(batch.current)} / {formatCount(batch.total)} 파일 · 완료 {formatCount(batch.completed)}
            {batch.failed > 0 ? ` · 실패 ${formatCount(batch.failed)}` : ''}
            {batch.skipped > 0 ? ` · 건너뜀 ${formatCount(batch.skipped)}` : ''}
          </span>
        </div>
      )}
      {progress && (
        <>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="책 가져오기 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">{progress.message}</p>
        </>
      )}
      <div className="import-progress-stats">
        {progress && (
          <span>
            {formatImportBytes(progress.bytesRead)} / {formatImportBytes(progress.totalBytes)}
          </span>
        )}
        {progress && <span>{formatCount(progress.chaptersDetected)}개 화</span>}
        {progress && <span>{formatCount(progress.paragraphsWritten)}개 문단</span>}
      </div>
      {controller.busy && (
        <button className="ghost-btn wide" type="button" onClick={controller.cancelImport}>
          취소
        </button>
      )}
    </div>
  );
}
