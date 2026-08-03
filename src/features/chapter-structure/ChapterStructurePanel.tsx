import { GitCompareArrows, Merge, Pencil, RotateCcw, Scissors, Split, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChapterSplitMode } from '../../domain/types';
import { Dialog } from '../../shared/ui/Dialog';
import { formatCount } from '../../utils/format';
import type { ChapterStructureController } from './useChapterStructureController';
import type { ChapterStructureChapterView } from '@noveldesk/text-core/chapter-structure';

const EMPTY_CHAPTERS: readonly ChapterStructureChapterView[] = [];

export default function ChapterStructurePanel({ controller }: { controller: ChapterStructureController }) {
  const chapters = controller.editor?.chapters ?? EMPTY_CHAPTERS;
  const [selectedId, setSelectedId] = useState<string>();
  const selected = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedId) ?? chapters[0],
    [chapters, selectedId],
  );
  const [title, setTitle] = useState('');
  const [splitOffset, setSplitOffset] = useState('');
  const [splitTitle, setSplitTitle] = useState('');
  const [mergePolicy, setMergePolicy] = useState<'first' | 'second' | 'custom'>('first');
  const [mergeTitle, setMergeTitle] = useState('');
  const [reparseMode, setReparseMode] = useState<ChapterSplitMode>('mixed');

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setTitle(selected.title);
    setSplitOffset(String(selected.splitCandidates[0]?.sourceOffset ?? ''));
    setSplitTitle('');
    setMergePolicy('first');
    setMergeTitle('');
  }, [selected]);

  const canMerge = Boolean(selected && selected.index < chapters.length);
  const canRollback =
    controller.editor?.latestReceipt?.status === 'active' &&
    controller.editor.latestReceipt.contentRevisionId === controller.editor.baseContentRevisionId;

  return (
    <Dialog
      open={controller.open}
      title="화 구조 편집"
      onClose={controller.closePanel}
      closeDisabled={controller.busy}
      closeLabel="화 구조 편집 닫기"
      className="chapter-structure-dialog"
    >
      {!controller.available ? (
        <div className="empty-panel">
          <Split size={32} />
          <strong>현재 실행 환경에서 화 구조 편집을 사용할 수 없습니다.</strong>
        </div>
      ) : controller.busy && !controller.editor ? (
        <div className="empty-panel" aria-busy="true">
          화 구조를 불러오는 중입니다.
        </div>
      ) : (
        <div className="chapter-structure-layout">
          <section className="chapter-structure-list" aria-label="현재 화 구조">
            <header>
              <strong>{formatCount(chapters.length)}개 화</strong>
              <span>{controller.editor?.sourceProvenance === 'original' ? '원본 source' : '재구성 source'}</span>
            </header>
            <div className="chapter-structure-scroll">
              {chapters.map((chapter) => (
                <button
                  type="button"
                  key={chapter.id}
                  className={chapter.id === selected?.id ? 'active' : ''}
                  onClick={() => {
                    controller.clearPreview();
                    setSelectedId(chapter.id);
                  }}
                >
                  <span>{chapter.index}</span>
                  <strong>{chapter.title}</strong>
                  <small>{formatCount(chapter.paragraphCount)}문단</small>
                </button>
              ))}
            </div>
          </section>

          <section className="chapter-structure-editor" aria-label="선택 화 구조 작업">
            {selected && !controller.preview && (
              <>
                <blockquote className="chapter-source-preview">{selected.sourcePreview}</blockquote>
                <div className="structure-command-block">
                  <label>
                    <span>화 제목</span>
                    <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
                  </label>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={controller.busy || !title.trim() || title.trim() === selected.title}
                    onClick={() => void controller.previewCommand({ kind: 'rename', chapterId: selected.id, title })}
                  >
                    <Pencil size={16} /> 제목 변경 미리보기
                  </button>
                </div>

                <div className="structure-command-block">
                  <label>
                    <span>나눌 문단</span>
                    <select value={splitOffset} onChange={(event) => setSplitOffset(event.target.value)}>
                      {selected.splitCandidates.length === 0 && <option value="">나눌 수 있는 경계 없음</option>}
                      {selected.splitCandidates.map((candidate) => (
                        <option key={candidate.paragraphId} value={candidate.sourceOffset}>
                          {candidate.paragraphIndex}문단 · {candidate.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>새 화 제목</span>
                    <input
                      value={splitTitle}
                      onChange={(event) => setSplitTitle(event.target.value)}
                      placeholder={`${selected.title} (2)`}
                      maxLength={160}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={controller.busy || !splitOffset}
                    onClick={() =>
                      void controller.previewCommand({
                        kind: 'split',
                        chapterId: selected.id,
                        sourceOffset: Number(splitOffset),
                        title: splitTitle.trim() || undefined,
                      })
                    }
                  >
                    <Scissors size={16} /> 경계 추가 미리보기
                  </button>
                </div>

                <div className="structure-command-block">
                  <label>
                    <span>합친 화 제목</span>
                    <select
                      value={mergePolicy}
                      onChange={(event) => setMergePolicy(event.target.value as typeof mergePolicy)}
                    >
                      <option value="first">현재 화 제목</option>
                      <option value="second">다음 화 제목</option>
                      <option value="custom">직접 입력</option>
                    </select>
                  </label>
                  {mergePolicy === 'custom' && (
                    <input
                      value={mergeTitle}
                      onChange={(event) => setMergeTitle(event.target.value)}
                      aria-label="합친 화 제목 직접 입력"
                      maxLength={160}
                    />
                  )}
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={controller.busy || !canMerge || (mergePolicy === 'custom' && !mergeTitle.trim())}
                    onClick={() =>
                      void controller.previewCommand({
                        kind: 'merge_next',
                        chapterId: selected.id,
                        titlePolicy: mergePolicy,
                        title: mergePolicy === 'custom' ? mergeTitle : undefined,
                      })
                    }
                  >
                    <Merge size={16} /> 다음 화와 합치기 미리보기
                  </button>
                </div>

                <div className="structure-command-block">
                  <label>
                    <span>재분석 규칙</span>
                    <select
                      value={reparseMode}
                      onChange={(event) => setReparseMode(event.target.value as ChapterSplitMode)}
                    >
                      <option value="auto">자동</option>
                      <option value="mixed">혼합 규칙</option>
                      <option value="single">한 화로 유지</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={controller.busy}
                    onClick={() =>
                      void controller.previewCommand({
                        kind: 'reparse_range',
                        startOffset: selected.rawStartOffset,
                        splitMode: reparseMode,
                      })
                    }
                  >
                    <WandSparkles size={16} /> 이 지점부터 재분석
                  </button>
                </div>
              </>
            )}

            {controller.preview && (
              <div className="chapter-structure-preview">
                <header>
                  <GitCompareArrows size={20} />
                  <span>
                    <strong>변경 미리보기</strong>
                    <small>
                      {controller.preview.before.length}화 → {controller.preview.after.length}화
                    </small>
                  </span>
                </header>
                <dl>
                  <div>
                    <dt>유지 문단</dt>
                    <dd>{formatCount(controller.preview.impact.preservedParagraphs)}</dd>
                  </div>
                  <div>
                    <dt>새 문단</dt>
                    <dd>{formatCount(controller.preview.impact.addedParagraphs)}</dd>
                  </div>
                  <div>
                    <dt>검토 주석</dt>
                    <dd>{formatCount(controller.preview.impact.readerAnnotationsAtRisk)}</dd>
                  </div>
                  <div>
                    <dt>검토 보정</dt>
                    <dd>{formatCount(controller.preview.impact.correctionsForReview)}</dd>
                  </div>
                </dl>
                <div className="structure-preview-columns">
                  <div>
                    <strong>기존 구조</strong>
                    <div className="structure-preview-titles">
                      {controller.preview.before.map((chapter) => (
                        <span key={chapter.id}>
                          {chapter.index}. {chapter.title}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <strong>변경 구조</strong>
                    <div className="structure-preview-titles">
                      {controller.preview.after.map((chapter) => (
                        <span key={chapter.id}>
                          {chapter.index}. {chapter.title}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                {controller.preview.warnings.map((warning) => (
                  <p className="field-help warning" key={warning}>
                    {warning}
                  </p>
                ))}
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={controller.clearPreview}
                    disabled={controller.busy}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => void controller.applyPreview()}
                    disabled={controller.busy}
                  >
                    변경 적용
                  </button>
                </div>
              </div>
            )}

            {!controller.preview && (
              <footer className="chapter-structure-footer">
                <span>검토 대기 {formatCount(controller.editor?.reviewItemCount ?? 0)}개</span>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={!canRollback || controller.busy}
                  onClick={() => void controller.rollbackLatest()}
                >
                  <RotateCcw size={16} /> 직전 변경 되돌리기
                </button>
              </footer>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
