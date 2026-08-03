import { AlignLeft, Check, RefreshCw, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTROLLED_TTS_EMOTIONS } from '../../providers/chapter-labeling-contract';
import {
  CONTROLLED_TTS_DELIVERIES,
  CONTROLLED_TTS_INTENSITIES,
  CONTROLLED_TTS_PACES,
  CONTROLLED_TTS_SEGMENT_TYPES,
} from '../../providers/chapter-labeling-v2-contract';
import type { ChapterLabelingResult } from '../../providers/ai';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';
import type { AIAddonPanelActions, AIReviewWorkspaceData } from './ai-addon-panel-contract';
import {
  analysisReviewCandidateChanged,
  analysisReviewEditIntentsChanged,
  analysisReviewOperationalStatusLabel,
  analysisReviewSegmentText,
  analysisReviewSpeakerOptions,
  EDITABLE_ANALYSIS_REVIEW_STATUSES,
  parseAnalysisReviewListeners,
  preferredAnalysisReview,
  prepareAnalysisReviewDraft,
  replaceAnalysisReviewParagraphWithNarration,
  updateAnalysisReviewProsody,
  updateAnalysisReviewSegment,
} from './analysis-review-workspace-model';

interface AnalysisReviewWorkspaceProps {
  readonly data: AIReviewWorkspaceData;
  readonly actions: AIAddonPanelActions['workflow'];
}

export function AnalysisReviewWorkspace({ data, actions }: AnalysisReviewWorkspaceProps) {
  const preferred = preferredAnalysisReview(data.reviews);
  const [selectedReviewId, setSelectedReviewId] = useState(preferred?.id ?? '');
  const review = data.reviews.find((item) => item.id === selectedReviewId) ?? preferred;
  const [draft, setDraft] = useState<ChapterLabelingResult | undefined>(() =>
    review ? prepareAnalysisReviewDraft(review) : undefined,
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [selectedSegmentId, setSelectedSegmentId] = useState(draft?.segments[0]?.id ?? '');
  const [listenerDraft, setListenerDraft] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [editIntents, setEditIntents] = useState<AnalysisReviewEditIntentMap>(review?.editIntents ?? {});

  useEffect(() => {
    if (!preferred) {
      setSelectedReviewId('');
      return;
    }
    if (!data.reviews.some((item) => item.id === selectedReviewId)) setSelectedReviewId(preferred.id);
  }, [data.reviews, preferred, selectedReviewId]);

  useEffect(() => {
    if (!review) {
      setDraft(undefined);
      setSelectedSegmentId('');
      setEditIntents({});
      return;
    }
    const prepared = prepareAnalysisReviewDraft(review);
    setDraft(prepared);
    setSelectedSegmentId(prepared.segments[0]?.id ?? '');
    setRejectionReason('');
    setEditIntents(review.editIntents);
  }, [review]);

  const speakerOptions = useMemo(
    () => (review && draft ? analysisReviewSpeakerOptions(review, draft) : []),
    [draft, review],
  );
  const selectedSegment = draft?.segments.find((segment) => segment.id === selectedSegmentId);
  useEffect(() => {
    const segment = draftRef.current?.segments.find((item) => item.id === selectedSegmentId);
    setListenerDraft(segment?.listenerIds.join(', ') ?? '');
  }, [review?.id, review?.reviewRevision, selectedSegmentId]);
  if (!data.available || (!data.loading && data.reviews.length === 0 && !data.error)) return null;

  const annotation = selectedSegment ? draft?.segmentAnnotations?.[selectedSegment.id] : undefined;
  const busy = Boolean(review && data.busyReviewId === review.id);
  const editable = Boolean(review && EDITABLE_ANALYSIS_REVIEW_STATUSES.has(review.status));
  const dirty = Boolean(
    review &&
    draft &&
    (analysisReviewCandidateChanged(review.candidate, draft) ||
      analysisReviewEditIntentsChanged(review.editIntents, editIntents)),
  );
  const promotionBlocked = Boolean(
    review &&
    ['approved', 'promoting'].includes(review.status) &&
    review.promotionLastErrorCode &&
    !review.nextReconcileAt,
  );
  const promotionRetryAllowed = Boolean(
    promotionBlocked && review?.promotionLastErrorCode?.endsWith('_retry_exhausted'),
  );
  const errorCount = (review?.validationSummary.errorCount ?? 0) + (review?.qualitySummary.errorCount ?? 0);
  const issues = [...(review?.validationIssues ?? []), ...(review?.qualityIssues ?? [])];

  return (
    <section className="analysis-review-workspace" aria-label="분석 결과 검토">
      <div className="analysis-review-header">
        <div>
          <strong>실패 window 검토</strong>
          <span>{data.loading ? '불러오는 중' : `${data.reviews.length}개`}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void actions.refreshReviews()}
          disabled={data.loading || busy}
          title="검토 항목 새로고침"
          aria-label="검토 항목 새로고침"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {review && draft && (
        <>
          <div className="analysis-review-picker-row">
            <select
              className="select-input"
              value={review.id}
              onChange={(event) => setSelectedReviewId(event.target.value)}
              aria-label="검토할 분석 window"
              disabled={busy}
            >
              {data.reviews.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.chapter.title || item.chapterId} · {item.windowId} ·{' '}
                  {analysisReviewOperationalStatusLabel(item)}
                </option>
              ))}
            </select>
            <span data-review-status={review.status}>
              {dirty ? '저장되지 않음' : analysisReviewOperationalStatusLabel(review)}
            </span>
          </div>

          <div className="analysis-review-source" aria-label="검토 원문">
            {review.paragraphs.map((paragraph) => (
              <div key={paragraph.id}>
                <p>{paragraph.text}</p>
                <button
                  type="button"
                  className="text-action-btn"
                  disabled={!editable || busy}
                  onClick={() => {
                    const next = replaceAnalysisReviewParagraphWithNarration(review, draft, paragraph);
                    setDraft(next);
                    setSelectedSegmentId(
                      next.segments.find((segment) => segment.paragraphId === paragraph.id)?.id ?? '',
                    );
                  }}
                >
                  <AlignLeft size={14} /> 문단 전체 내레이션
                </button>
              </div>
            ))}
          </div>
          {review.haloParagraphs.length > 0 && (
            <details className="analysis-review-halo">
              <summary>주변 문맥 {review.haloParagraphs.length}개</summary>
              {review.haloParagraphs.map((paragraph) => (
                <p key={`${paragraph.side}:${paragraph.paragraphId}`}>{paragraph.text}</p>
              ))}
            </details>
          )}

          <div className="analysis-review-segments" aria-label="후보 segment">
            {draft.segments.map((segment) => (
              <button
                type="button"
                key={segment.id}
                className={segment.id === selectedSegmentId ? 'selected' : undefined}
                onClick={() => setSelectedSegmentId(segment.id)}
              >
                <span>{analysisReviewSegmentText(review, segment) || segment.id}</span>
                <small>
                  {speakerOptions.find((option) => option.id === segment.speakerId)?.label ?? segment.speakerId} ·{' '}
                  {segment.emotion}
                </small>
              </button>
            ))}
          </div>

          {selectedSegment && (
            <div className="analysis-review-editor">
              <label className="analysis-review-wide-field">
                <span>수정 적용 범위</span>
                <select
                  className="select-input"
                  value={editIntents[selectedSegment.id]?.kind ?? 'segment_only'}
                  disabled={!editable || busy}
                  onChange={(event) =>
                    setEditIntents((current) => ({
                      ...current,
                      [selectedSegment.id]:
                        event.target.value === 'relabel_from_window'
                          ? { kind: 'relabel_from_window', windowId: review.windowId }
                          : { kind: 'segment_only' },
                    }))
                  }
                >
                  <option value="segment_only">이 구간만</option>
                  <option value="relabel_from_window">이 window부터 다시 분석</option>
                </select>
                {editIntents[selectedSegment.id]?.kind === 'relabel_from_window' && (
                  <small>현재 window 이후의 문맥과 라벨을 재계획합니다.</small>
                )}
              </label>
              <label>
                <span>구간 유형</span>
                <select
                  className="select-input"
                  value={selectedSegment.type}
                  disabled={!editable || busy}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? updateAnalysisReviewSegment(current, selectedSegment.id, {
                            type: event.target.value as (typeof CONTROLLED_TTS_SEGMENT_TYPES)[number],
                          })
                        : current,
                    )
                  }
                >
                  {CONTROLLED_TTS_SEGMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>화자</span>
                <select
                  className="select-input"
                  value={selectedSegment.speakerId}
                  disabled={!editable || busy}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? updateAnalysisReviewSegment(current, selectedSegment.id, { speakerId: event.target.value })
                        : current,
                    )
                  }
                >
                  {speakerOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>감정</span>
                <select
                  className="select-input"
                  value={selectedSegment.emotion}
                  disabled={!editable || busy}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? updateAnalysisReviewSegment(current, selectedSegment.id, { emotion: event.target.value })
                        : current,
                    )
                  }
                >
                  {CONTROLLED_TTS_EMOTIONS.map((emotion) => (
                    <option key={emotion} value={emotion}>
                      {emotion}
                    </option>
                  ))}
                </select>
              </label>
              <label className="analysis-review-wide-field">
                <span>청자 ID</span>
                <input
                  className="text-input"
                  value={listenerDraft}
                  disabled={!editable || busy}
                  onChange={(event) => {
                    setListenerDraft(event.target.value);
                    setDraft((current) =>
                      current
                        ? updateAnalysisReviewSegment(current, selectedSegment.id, {
                            listenerIds: parseAnalysisReviewListeners(event.target.value),
                          })
                        : current,
                    );
                  }}
                />
              </label>
              {(
                [
                  ['pace', '속도', CONTROLLED_TTS_PACES],
                  ['intensity', '강도', CONTROLLED_TTS_INTENSITIES],
                  ['delivery', '발화', CONTROLLED_TTS_DELIVERIES],
                ] as const
              ).map(([field, label, values]) => (
                <label key={field}>
                  <span>{label}</span>
                  <select
                    className="select-input"
                    value={annotation?.prosodyIntent?.[field] ?? ''}
                    disabled={!editable || busy}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? updateAnalysisReviewProsody(current, selectedSegment.id, field, event.target.value)
                          : current,
                      )
                    }
                  >
                    <option value="">기본값</option>
                    {values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          {issues.length > 0 && (
            <div className="analysis-review-issues" aria-label="검증 이슈">
              {issues.slice(0, 6).map((issue, index) => (
                <div key={`${issue.code}:${index}`} data-severity={issue.severity}>
                  <strong>{issue.code}</strong>
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          )}

          <label className="analysis-review-reason">
            <span>반려 사유</span>
            <input
              className="text-input"
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              disabled={!editable || busy}
              maxLength={1000}
            />
          </label>
          {promotionBlocked && (
            <p className="analysis-review-safety-note">
              {promotionRetryAllowed
                ? '자동 반영이 중단되었습니다. 다시 시도해도 외부 AI 요청은 발생하지 않고 저장된 검토 결과만 반영합니다.'
                : '저장된 검토 결과를 자동으로 반영할 수 없습니다. 원문 또는 검토 결과를 다시 확인해야 합니다.'}
            </p>
          )}
          <div className="analysis-review-actions">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void actions.saveReviewDraft(review.id, draft, editIntents)}
              disabled={!editable || !dirty || busy}
            >
              <Save size={16} /> 저장 및 재검증
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void actions.approveReview(review.id)}
              disabled={promotionRetryAllowed ? busy : !editable || dirty || busy || errorCount > 0}
            >
              <Check size={16} /> {promotionRetryAllowed ? '반영 다시 시도' : '승인 및 재개'}
            </button>
            <button
              type="button"
              className="ghost-btn danger-btn"
              onClick={() => void actions.rejectReview(review.id, rejectionReason.trim() || undefined)}
              disabled={!editable || busy}
            >
              <X size={16} /> 반려
            </button>
          </div>
        </>
      )}
      {(data.error || (!review && !data.loading)) && (
        <p className="field-error">{data.error ?? '검토 가능한 분석 후보가 없습니다.'}</p>
      )}
    </section>
  );
}
