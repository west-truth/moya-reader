import { AlertTriangle, FileText, List, Trash2, Upload } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useId, useRef } from 'react';
import type { ChapterSplitMode, EncodingMode } from '../../domain/types';
import { Dialog } from '../../shared/ui/Dialog';
import { formatCount, formatDateTime } from '../../utils/format';
import { formatImportBytes, formatImportChapterSplitMode } from './import-formatting';
import { ImportPreviewPanel, ImportProgressPanel } from './ImportStatusPanels';
import { LOCAL_IMPORT_TARGET_BYTES, type ImportFeatureController } from './useImportController';

export interface ImportDialogProps {
  controller: ImportFeatureController;
}

export function ImportDialog({ controller }: ImportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const encodingId = useId();
  const chapterSplitId = useId();
  const hasTextSelection =
    controller.pendingFiles.length === 0 ||
    controller.pendingFiles.some((file) => /\.(txt|md|markdown)$/i.test(file.name));
  const hasArchiveSelection = controller.pendingFiles.some((file) => /\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(file.name));
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) controller.selectFiles(files);
  };
  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    if (files.length) controller.selectFiles(files);
  };

  return (
    <Dialog
      open={controller.isOpen}
      title="책 가져오기"
      onClose={controller.close}
      closeLabel="가져오기 닫기"
      className="import-dialog"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,.epub,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,text/plain,application/epub+zip,application/pdf,application/zip,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-7z-compressed"
        multiple
        hidden
        onChange={onFileChange}
      />
      <button
        className={`drop-zone${controller.busy ? ' is-disabled' : ''}`}
        type="button"
        onClick={() => {
          if (controller.usesPlatformPicker) void controller.pickFiles();
          else fileInputRef.current?.click();
        }}
        onDrop={controller.busy ? undefined : onDrop}
        onDragOver={(event) => event.preventDefault()}
        disabled={controller.busy}
        data-dialog-initial-focus
      >
        <Upload size={36} />
        <strong className="drop-zone-title">
          {controller.pendingFiles.length ? '선택한 파일 변경' : '텍스트, EPUB, PDF 또는 만화 압축 파일 선택'}
        </strong>
        <span>
          {controller.pendingFiles.length
            ? '다른 파일을 고르면 현재 선택 목록을 교체합니다.'
            : '여러 파일을 한 번에 선택하거나 여기에 끌어오세요.'}
        </span>
        <span className="drop-zone-hint">
          텍스트 {formatImportBytes(LOCAL_IMPORT_TARGET_BYTES)} 이하 권장 · PDF/ZIP은 파일 크기에 따라 시간이 걸릴 수
          있습니다.
        </span>
      </button>

      {controller.pendingFiles.length > 0 && (
        <section className="import-selection-panel">
          <div className="setting-line">
            <h3>선택한 파일</h3>
            <span>{formatCount(controller.pendingFiles.length)}개</span>
          </div>
          <div className="import-file-list">
            {controller.pendingFiles.slice(0, 4).map((file) => (
              <div key={`${file.name}:${file.size}:${file.lastModified}`} className="import-file-row">
                <FileText size={15} />
                <strong>{file.name}</strong>
                <span>{formatImportBytes(file.size)}</span>
              </div>
            ))}
            {controller.pendingFiles.length > 4 && (
              <p className="field-help">
                외 {formatCount(controller.pendingFiles.length - 4)}개 파일은 같은 설정으로 순차 가져오기합니다.
              </p>
            )}
          </div>
          {hasArchiveSelection && controller.supportsArchivePassword && (
            <label className="import-archive-password">
              <span>압축 파일 암호</span>
              <input
                type="password"
                value={controller.archivePassword}
                onChange={(event) => controller.setArchivePassword(event.target.value)}
                autoComplete="new-password"
                placeholder="암호가 있을 때만 입력"
                disabled={controller.busy}
              />
              <small>가져오는 동안 worker에만 전달되며 저장·동기화·백업하지 않습니다.</small>
            </label>
          )}
          {hasArchiveSelection && !controller.supportsArchivePassword && (
            <p className="field-help">서버 가져오기는 현재 암호 없는 압축 파일만 지원합니다.</p>
          )}
          {controller.duplicateBusy && <p className="field-help">기존 서재와 중복 여부를 확인하고 있습니다.</p>}
          {controller.seriesError && (
            <div className="import-series-error" role="alert">
              <AlertTriangle size={16} />
              <span>{controller.seriesError}</span>
            </div>
          )}
          {controller.seriesInspection && (
            <section className="import-series-panel" aria-label="연재 작품 가져오기 계획">
              <div className="import-series-heading">
                <div>
                  <strong>연재 작품으로 가져오기</strong>
                  <span>
                    {controller.seriesInspection.sourceKind === 'nested_package'
                      ? '바깥 압축파일 안의 회차를 찾았습니다.'
                      : '선택한 압축파일을 한 작품의 회차로 묶습니다.'}
                  </span>
                </div>
                <em>{controller.seriesInspection.workTitle}</em>
              </div>
              {!controller.seriesTargetLocked && controller.seriesInspection.candidateNovels.length > 0 && (
                <label className="import-series-target">
                  <span>가져올 위치</span>
                  <select
                    value={controller.seriesTargetNovelId ?? ''}
                    disabled={controller.seriesBusy || controller.busy}
                    onChange={(event) => void controller.setSeriesTargetNovel(event.target.value || undefined)}
                  >
                    <option value="">새 작품으로 추가</option>
                    {controller.seriesInspection.candidateNovels.map((novel) => (
                      <option key={novel.id} value={novel.id}>
                        기존 “{novel.title}”에 회차 추가
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {controller.seriesTargetLocked && controller.seriesPlan?.targetNovel && (
                <p className="import-series-target-locked">
                  기존 “{controller.seriesPlan.targetNovel.title}”에 새 회차만 추가합니다.
                </p>
              )}
              {controller.seriesPlan && (
                <>
                  <div className="import-series-summary">
                    <span className="is-add">새 회차 {controller.seriesPlan.addCount}개</span>
                    <span>중복 {controller.seriesPlan.duplicateCount}개</span>
                    <span className={controller.seriesPlan.conflictCount ? 'is-conflict' : undefined}>
                      충돌 {controller.seriesPlan.conflictCount}개
                    </span>
                  </div>
                  <div className="import-series-release-list">
                    {controller.seriesPlan.releases.slice(0, 8).map((release) => (
                      <div key={`${release.id}:${release.originalName}`} data-state={release.disposition}>
                        <span>{release.parsed.releaseTitle}</span>
                        <small>{release.pageCount}페이지</small>
                        <em>
                          {release.disposition === 'add'
                            ? '추가'
                            : release.disposition === 'duplicate'
                              ? '중복 제외'
                              : '기존 회차 보존'}
                        </em>
                      </div>
                    ))}
                    {controller.seriesPlan.releases.length > 8 && (
                      <p>외 {controller.seriesPlan.releases.length - 8}개 회차</p>
                    )}
                  </div>
                  {controller.seriesPlan.conflictCount > 0 && (
                    <p className="import-series-conflict-note">
                      같은 회차 번호지만 내용이 다른 항목은 자동 교체하지 않고 기존 회차를 보존합니다.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          {controller.documentSeriesInspection && (
            <section className="import-series-panel" aria-label="문서 회차 병합 계획">
              <div className="import-series-heading">
                <div>
                  <strong>로컬 작품에 회차로 가져오기</strong>
                  <span>선택한 원본은 그대로 보존하고 새 회차만 작품에 추가합니다.</span>
                </div>
                <em>{controller.documentSeriesInspection.workTitle}</em>
              </div>
              {!controller.seriesTargetLocked && controller.documentSeriesInspection.candidateNovels.length > 0 && (
                <label className="import-series-target">
                  <span>가져올 위치</span>
                  <select
                    value={controller.seriesTargetNovelId ?? ''}
                    disabled={controller.seriesBusy || controller.busy}
                    onChange={(event) => void controller.setSeriesTargetNovel(event.target.value || undefined)}
                  >
                    <option value="">새 작품으로 추가</option>
                    {controller.documentSeriesInspection.candidateNovels.map((novel) => (
                      <option key={novel.id} value={novel.id}>
                        기존 “{novel.title}”에 회차 추가
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {controller.seriesTargetLocked && controller.documentSeriesPlan?.targetNovel && (
                <p className="import-series-target-locked">
                  기존 “{controller.documentSeriesPlan.targetNovel.title}”에 새 회차만 추가합니다.
                </p>
              )}
              {controller.documentSeriesPlan && (
                <>
                  <div className="import-series-summary">
                    <span className="is-add">새 회차 {controller.documentSeriesPlan.addCount}개</span>
                    <span>중복 {controller.documentSeriesPlan.duplicateCount}개</span>
                    <span className={controller.documentSeriesPlan.conflictCount ? 'is-conflict' : undefined}>
                      충돌 {controller.documentSeriesPlan.conflictCount}개
                    </span>
                  </div>
                  <div className="import-series-release-list">
                    {controller.documentSeriesPlan.chapters.slice(0, 12).map((chapter) => (
                      <div key={chapter.id} data-state={chapter.disposition}>
                        <span>{chapter.title}</span>
                        <small>{formatCount(chapter.paragraphCount)}문단</small>
                        <em>
                          {chapter.disposition === 'add'
                            ? '추가'
                            : chapter.disposition === 'duplicate'
                              ? '중복 제외'
                              : '기존 회차 보존'}
                        </em>
                      </div>
                    ))}
                    {controller.documentSeriesPlan.chapters.length > 12 && (
                      <p>외 {controller.documentSeriesPlan.chapters.length - 12}개 회차</p>
                    )}
                  </div>
                  {controller.documentSeriesPlan.conflictCount > 0 && (
                    <p className="import-series-conflict-note">
                      제목은 같지만 본문이 다른 회차는 자동 교체하지 않고 기존 회차를 보존합니다.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          {controller.duplicateConflicts.length > 0 && (
            <div className="import-duplicate-list" aria-label="가져오기 중복 처리">
              {controller.duplicateConflicts.map((conflict) => (
                <div className="import-duplicate-row" key={conflict.fileKey}>
                  <AlertTriangle size={17} aria-hidden="true" />
                  <div>
                    <strong>{conflict.fileName}</strong>
                    <span>
                      {conflict.kind === 'same_source'
                        ? `같은 원본의 “${conflict.existingBook.title}”이 이미 있습니다.`
                        : conflict.sourceHash
                          ? `같은 파일명의 “${conflict.existingBook.title}”이 있지만 내용은 다릅니다.`
                          : `같은 파일명의 “${conflict.existingBook.title}”이 이미 있습니다.`}
                    </span>
                  </div>
                  <select
                    value={conflict.policy}
                    aria-label={`${conflict.fileName} 중복 처리`}
                    onChange={(event) =>
                      controller.setDuplicatePolicy(conflict.fileKey, event.target.value as typeof conflict.policy)
                    }
                  >
                    {conflict.kind === 'same_source' ? (
                      <>
                        <option value="open_existing">기존 책 열기</option>
                        <option value="skip">건너뛰기</option>
                        <option value="copy">별도 복사본</option>
                      </>
                    ) : (
                      <>
                        <option value="new">새 책으로 추가</option>
                        <option value="replace">기존 책 교체</option>
                        <option value="skip">건너뛰기</option>
                      </>
                    )}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="import-action-row">
            <button
              className="ghost-btn"
              type="button"
              onClick={() => void controller.previewPendingImport()}
              disabled={
                controller.busy ||
                controller.preview?.status === 'loading' ||
                /\.(epub|pdf|zip|cbz|rar|cbr|7z|cb7)$/i.test(controller.pendingFiles[0]?.name ?? '')
              }
            >
              <List size={16} /> 분리 미리보기
            </button>
            <button
              className="primary-btn"
              type="button"
              onClick={() => void controller.startPendingImport()}
              disabled={
                controller.busy ||
                controller.duplicateBusy ||
                controller.seriesBusy ||
                Boolean(controller.seriesInspection && !controller.seriesPlan) ||
                Boolean(controller.documentSeriesInspection && !controller.documentSeriesPlan)
              }
            >
              <Upload size={16} />{' '}
              {controller.seriesPlan?.targetNovel || controller.documentSeriesPlan?.targetNovel
                ? '새 회차 추가'
                : controller.seriesPlan || controller.documentSeriesPlan
                  ? '연재 작품 가져오기'
                  : '가져오기 시작'}
            </button>
          </div>
          <ImportPreviewPanel controller={controller} />
        </section>
      )}

      <ImportProgressPanel controller={controller} />

      {controller.uploadSessions.length > 0 && (
        <section className="upload-session-panel">
          <div className="setting-line">
            <h3>중단된 서버 업로드</h3>
            <span>{formatCount(controller.uploadSessions.length)}개</span>
          </div>
          <p className="field-help">
            같은 파일을 다시 선택하면 남은 chunk 업로드 또는 대기 중인 서버 가져오기를 이어서 확인합니다.
          </p>
          <div className="upload-session-list">
            {controller.uploadSessions.map((session) => (
              <div key={session.key} className="upload-session-row">
                <div>
                  <strong>{session.fileName}</strong>
                  <span>
                    {formatImportBytes(session.sizeBytes)} · {session.encoding.toUpperCase()} ·{' '}
                    {formatImportChapterSplitMode(session.chapterSplitMode)} · {formatDateTime(session.updatedAt)}
                  </span>
                </div>
                <button
                  className="mini-icon-btn"
                  type="button"
                  onClick={() => void controller.forgetUploadSession(session.key)}
                  disabled={controller.busy}
                  aria-label={`${session.fileName} 업로드 기록 삭제`}
                  title="업로드 기록 삭제"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasTextSelection && (
        <>
          <label className="field-label" htmlFor={encodingId}>
            텍스트 인코딩
          </label>
          <select
            id={encodingId}
            value={controller.encoding}
            disabled={controller.busy}
            onChange={(event) => controller.setEncoding(event.target.value as EncodingMode)}
          >
            <option value="auto">자동 감지</option>
            <option value="utf-8">UTF-8</option>
            <option value="euc-kr">CP949 / EUC-KR</option>
          </select>
          <label className="field-label" htmlFor={chapterSplitId}>
            텍스트 화 분리 방식
          </label>
          <select
            id={chapterSplitId}
            value={controller.chapterSplitMode}
            disabled={controller.busy}
            onChange={(event) => controller.setChapterSplitMode(event.target.value as ChapterSplitMode)}
          >
            <option value="auto">자동 감지</option>
            <option value="mixed">혼합 표식 강화</option>
            <option value="single">분리하지 않음</option>
          </select>
          <p className="field-help">
            중간부터 회차 표식이 바뀐 텍스트는 혼합 표식 강화, 제목만 있는 파일은 분리하지 않음을 사용하세요.
          </p>
        </>
      )}
    </Dialog>
  );
}

export default ImportDialog;
