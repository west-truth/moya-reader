import { ArrowLeft, Pencil, RotateCcw, Search, Split, Undo2, WandSparkles } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ChapterSplitMode } from '../../domain/types';
import { Dialog } from '../../shared/ui/Dialog';
import { formatCount } from '../../utils/format';
import {
  buildBoundaryAdditionCommands,
  buildBoundaryRemovalCommands,
  type BoundaryAdditionDraft,
} from './chapter-structure-view-model';
import ChapterStructurePreview from './ChapterStructurePreview';
import type { ChapterStructureController } from './useChapterStructureController';
import type {
  ChapterSplitCandidate,
  ChapterStructureChapterView,
  ChapterStructureCommand,
} from '@noveldesk/text-core/chapter-structure';

const EMPTY_CHAPTERS: readonly ChapterStructureChapterView[] = [];

function candidateKey(chapterId: string, sourceOffset: number): string {
  return `${chapterId}:${sourceOffset}`;
}

function candidateDraft(chapterId: string, candidate: ChapterSplitCandidate): BoundaryAdditionDraft {
  return {
    chapterId,
    sourceOffset: candidate.sourceOffset,
    title: candidate.headingTitle || candidate.label,
  };
}

export default function ChapterStructurePanel({ controller }: { controller: ChapterStructureController }) {
  const chapters = controller.editor?.chapters ?? EMPTY_CHAPTERS;
  const [selectedId, setSelectedId] = useState<string>();
  const selected = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedId) ?? chapters[0],
    [chapters, selectedId],
  );
  const [query, setQuery] = useState('');
  const [mobilePane, setMobilePane] = useState<'list' | 'editor'>('list');
  const [showAllParagraphs, setShowAllParagraphs] = useState(false);
  const [removedBoundaries, setRemovedBoundaries] = useState<Set<string>>(() => new Set());
  const [addedBoundaries, setAddedBoundaries] = useState<Map<string, BoundaryAdditionDraft>>(() => new Map());
  const [focusedFamily, setFocusedFamily] = useState<string>();
  const [title, setTitle] = useState('');
  const [reparseMode, setReparseMode] = useState<ChapterSplitMode>('mixed');

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setTitle(selected.title);
    setShowAllParagraphs(false);
    setFocusedFamily(undefined);
  }, [selected]);

  useEffect(() => {
    setRemovedBoundaries(new Set());
    setAddedBoundaries(new Map());
  }, [controller.editor?.baseContentRevisionId]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredChapters = useMemo(() => {
    if (!normalizedQuery) return chapters;
    return chapters.filter(
      (chapter) =>
        chapter.title.toLocaleLowerCase().includes(normalizedQuery) || String(chapter.index) === normalizedQuery,
    );
  }, [chapters, normalizedQuery]);

  const headingCandidates = useMemo(
    () => selected?.splitCandidates.filter((candidate) => candidate.headingFamily) ?? [],
    [selected],
  );
  const visibleCandidates = showAllParagraphs ? (selected?.splitCandidates ?? []) : headingCandidates;
  const focusedFamilyCandidates = useMemo(
    () => headingCandidates.filter((candidate) => candidate.headingFamily === focusedFamily),
    [focusedFamily, headingCandidates],
  );
  const canRollback =
    controller.editor?.latestReceipt?.status === 'active' &&
    controller.editor.latestReceipt.contentRevisionId === controller.editor.baseContentRevisionId;

  const removalCommands = useMemo(
    () => buildBoundaryRemovalCommands(chapters, removedBoundaries),
    [chapters, removedBoundaries],
  );
  const additionCommands = useMemo(
    () => buildBoundaryAdditionCommands(chapters, [...addedBoundaries.values()]),
    [addedBoundaries, chapters],
  );
  const draftCommands = additionCommands.length > 0 ? additionCommands : removalCommands;

  const clearDraft = () => {
    setRemovedBoundaries(new Set());
    setAddedBoundaries(new Map());
    setFocusedFamily(undefined);
  };

  const previewCommands = (commands: readonly ChapterStructureCommand[]) => {
    if (commands.length === 0) return;
    void controller.previewCommands(commands);
  };

  const toggleBoundaryRemoval = (chapterId: string) => {
    setAddedBoundaries(new Map());
    setFocusedFamily(undefined);
    setRemovedBoundaries((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  };

  const toggleBoundaryAddition = (candidate: ChapterSplitCandidate) => {
    if (!selected) return;
    setRemovedBoundaries(new Set());
    setFocusedFamily(candidate.headingFamily);
    setAddedBoundaries((current) => {
      const next = new Map(current);
      const key = candidateKey(selected.id, candidate.sourceOffset);
      if (next.has(key)) next.delete(key);
      else next.set(key, candidateDraft(selected.id, candidate));
      return next;
    });
  };

  const toggleFocusedFamily = () => {
    if (!selected || !focusedFamily || focusedFamilyCandidates.length === 0) return;
    setRemovedBoundaries(new Set());
    setAddedBoundaries((current) => {
      const next = new Map(current);
      const keys = focusedFamilyCandidates.map((candidate) => candidateKey(selected.id, candidate.sourceOffset));
      const allSelected = keys.every((key) => next.has(key));
      for (const candidate of focusedFamilyCandidates) {
        const key = candidateKey(selected.id, candidate.sourceOffset);
        if (allSelected) next.delete(key);
        else next.set(key, candidateDraft(selected.id, candidate));
      }
      return next;
    });
  };

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
        <div className={`chapter-structure-layout mobile-${mobilePane}${controller.preview ? ' is-previewing' : ''}`}>
          <section className="chapter-structure-list" aria-label="현재 화 구조">
            <header>
              <strong>현재 구조</strong>
              <span>
                {formatCount(chapters.length)}화 ·{' '}
                {controller.editor?.sourceProvenance === 'original' ? '원본' : '복원본'}
              </span>
            </header>

            <label className="chapter-structure-search">
              <Search size={15} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="화 번호 또는 제목"
                aria-label="화 번호 또는 제목 검색"
              />
              {normalizedQuery && <small>{filteredChapters.length}개</small>}
            </label>

            <div className="chapter-structure-scroll">
              {filteredChapters.map((chapter, index) => {
                const nextChapter = filteredChapters[index + 1];
                const hasActualNext = nextChapter?.index === chapter.index + 1;
                const removing = removedBoundaries.has(chapter.id);
                return (
                  <Fragment key={chapter.id}>
                    <button
                      type="button"
                      className={chapter.id === selected?.id ? 'chapter-row active' : 'chapter-row'}
                      onClick={() => {
                        controller.clearPreview();
                        setSelectedId(chapter.id);
                        setMobilePane('editor');
                      }}
                    >
                      <span>{chapter.index}</span>
                      <strong>{chapter.title}</strong>
                      <small>
                        {formatCount(chapter.characterCount)}자 · {formatCount(chapter.paragraphCount)}문단
                      </small>
                    </button>
                    {hasActualNext && (
                      <button
                        type="button"
                        className={`chapter-boundary-toggle${removing ? ' selected' : ''}`}
                        aria-pressed={removing}
                        aria-label={`${chapter.index}화와 ${nextChapter.index}화 사이 경계 ${
                          removing ? '유지' : '제거'
                        }`}
                        onClick={() => toggleBoundaryRemoval(chapter.id)}
                      >
                        <span />
                        <small>{removing ? '제거 예정' : '경계 제거'}</small>
                        <span />
                      </button>
                    )}
                  </Fragment>
                );
              })}
              {filteredChapters.length === 0 && <p className="empty-copy">일치하는 화가 없습니다.</p>}
            </div>

            {removedBoundaries.size > 0 && (
              <div className="chapter-structure-list-actions">
                <span>경계 {removedBoundaries.size}개 제거 예정</span>
                <button
                  type="button"
                  className="primary-btn compact"
                  disabled={controller.busy}
                  onClick={() => previewCommands(removalCommands)}
                >
                  결과 보기
                </button>
              </div>
            )}
          </section>

          <section className="chapter-structure-editor" aria-label="선택 화 경계 편집">
            {controller.preview ? (
              <ChapterStructurePreview controller={controller} />
            ) : (
              selected && (
                <>
                  <button
                    type="button"
                    className="chapter-structure-mobile-back ghost-btn"
                    onClick={() => setMobilePane('list')}
                  >
                    <ArrowLeft size={16} /> 화 목록
                  </button>

                  <header className="chapter-structure-selection-header">
                    <span>{selected.index}화</span>
                    <div>
                      <strong>{selected.title}</strong>
                      <small>
                        {formatCount(selected.characterCount)}자 · {formatCount(selected.paragraphCount)}문단
                      </small>
                    </div>
                  </header>

                  <blockquote className="chapter-source-preview">{selected.sourcePreview}</blockquote>

                  <section className="chapter-boundary-candidate-panel">
                    <header>
                      <div>
                        <strong>경계 추가</strong>
                        <small>새 화가 시작되는 줄을 선택하세요.</small>
                      </div>
                      <button
                        type="button"
                        className="ghost-btn compact"
                        onClick={() => setShowAllParagraphs((value) => !value)}
                      >
                        {showAllParagraphs ? '제목 후보만' : '모든 문단'}
                      </button>
                    </header>

                    {visibleCandidates.length > 0 ? (
                      <div className="chapter-boundary-candidates">
                        {visibleCandidates.map((candidate) => {
                          const key = candidateKey(selected.id, candidate.sourceOffset);
                          const active = addedBoundaries.has(key);
                          return (
                            <button
                              type="button"
                              className={active ? 'selected' : ''}
                              aria-pressed={active}
                              key={candidate.paragraphId}
                              onClick={() => toggleBoundaryAddition(candidate)}
                            >
                              <span className="candidate-check">{active ? '✓' : ''}</span>
                              <span>
                                <strong>{candidate.headingTitle || candidate.label}</strong>
                                <small>{candidate.paragraphIndex}문단</small>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="chapter-boundary-empty">
                        <span>제목처럼 보이는 줄을 찾지 못했습니다.</span>
                        <button type="button" className="ghost-btn compact" onClick={() => setShowAllParagraphs(true)}>
                          모든 문단에서 선택
                        </button>
                      </div>
                    )}

                    {focusedFamily && focusedFamilyCandidates.length > 1 && (
                      <div className="chapter-boundary-family-action">
                        <span>선택한 줄과 같은 형식 {focusedFamilyCandidates.length}개</span>
                        <button type="button" className="ghost-btn compact" onClick={toggleFocusedFamily}>
                          같은 형식 모두 선택
                        </button>
                      </div>
                    )}
                  </section>

                  <details className="chapter-structure-manual-tools">
                    <summary>직접 수정</summary>
                    <div className="structure-command-block">
                      <label>
                        <span>화 제목</span>
                        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
                      </label>
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={controller.busy || !title.trim() || title.trim() === selected.title}
                        onClick={() => {
                          clearDraft();
                          previewCommands([{ kind: 'rename', chapterId: selected.id, title: title.trim() }]);
                        }}
                      >
                        <Pencil size={16} /> 제목 변경 결과 보기
                      </button>
                    </div>
                    <div className="structure-command-block">
                      <label>
                        <span>이 화부터 다시 나누기</span>
                        <select
                          value={reparseMode}
                          onChange={(event) => setReparseMode(event.target.value as ChapterSplitMode)}
                        >
                          <option value="auto">안전하게 감지</option>
                          <option value="mixed">다양한 제목 형식 포함</option>
                          <option value="single">이후 본문을 한 화로</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={controller.busy}
                        onClick={() => {
                          clearDraft();
                          previewCommands([
                            {
                              kind: 'reparse_range',
                              startOffset: selected.rawStartOffset,
                              splitMode: reparseMode,
                            },
                          ]);
                        }}
                      >
                        <WandSparkles size={16} /> 다시 나눈 결과 보기
                      </button>
                    </div>
                  </details>

                  <footer className="chapter-structure-footer">
                    <div>
                      <span>
                        {addedBoundaries.size > 0
                          ? `경계 ${addedBoundaries.size}개 추가 예정`
                          : removedBoundaries.size > 0
                            ? `경계 ${removedBoundaries.size}개 제거 예정`
                            : '변경할 경계를 선택하세요.'}
                      </span>
                      {draftCommands.length > 0 && (
                        <button type="button" className="text-btn" onClick={clearDraft}>
                          <Undo2 size={14} /> 선택 초기화
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={controller.busy || draftCommands.length === 0}
                      onClick={() => previewCommands(draftCommands)}
                    >
                      결과 보기
                    </button>
                  </footer>

                  <div className="chapter-structure-history">
                    <span>확인할 기록 {formatCount(controller.editor?.reviewItemCount ?? 0)}개</span>
                    <button
                      type="button"
                      className="ghost-btn compact"
                      disabled={!canRollback || controller.busy}
                      onClick={() => void controller.rollbackLatest()}
                    >
                      <RotateCcw size={15} /> 직전 변경 되돌리기
                    </button>
                  </div>
                </>
              )
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
