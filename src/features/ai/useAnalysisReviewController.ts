import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { ChapterLabelingResult } from '../../providers/ai';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';
import type { BookAnalysisWorkflow, BookAnalysisWorkflowGateway } from './book-analysis-workflow-gateway';

type NotificationTone = 'success' | 'warning' | 'danger' | 'info';

export interface AnalysisReviewControllerInput {
  readonly gateway?: BookAnalysisWorkflowGateway;
  readonly workflow?: BookAnalysisWorkflow;
  readonly bookId?: string;
  readonly resumeWorkflow: (workflow: BookAnalysisWorkflow) => void | Promise<void>;
  readonly onReviewPromoted: (workflow: BookAnalysisWorkflow) => void | Promise<void>;
  readonly notify: (message: string, tone: NotificationTone) => void;
}

interface AnalysisReviewControllerState {
  readonly reviews: readonly ChapterLabelAnalysisReviewArtifact[];
  readonly loading: boolean;
  readonly busyReviewId?: string;
  readonly error?: string;
}

const INITIAL_STATE: AnalysisReviewControllerState = { reviews: [], loading: false };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function replaceReview(
  reviews: readonly ChapterLabelAnalysisReviewArtifact[],
  review: ChapterLabelAnalysisReviewArtifact,
): ChapterLabelAnalysisReviewArtifact[] {
  const next = reviews.map((item) => (item.id === review.id ? review : item));
  return next.some((item) => item.id === review.id) ? next : [review, ...reviews];
}

export function useAnalysisReviewController(input: AnalysisReviewControllerInput) {
  const [state, setState] = useState<AnalysisReviewControllerState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const inputRef = useRef(input);
  const loadAbortRef = useRef<AbortController>();
  const mutationAbortRef = useRef<AbortController>();
  stateRef.current = state;
  inputRef.current = input;
  const workflowId = input.workflow?.id;
  const workflowStatus = input.workflow?.status;
  const workflowUpdatedAt = input.workflow?.updatedAt;

  const refresh = useCallback(async (silent = false) => {
    const current = inputRef.current;
    const workflowId = current.workflow?.id;
    if (!current.gateway?.listReviews || !current.bookId || !workflowId) {
      setState(INITIAL_STATE);
      return;
    }
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (!silent) setState((previous) => ({ ...previous, loading: true, error: undefined }));
    try {
      const reviews = await current.gateway.listReviews(workflowId, controller.signal);
      if (
        controller.signal.aborted ||
        inputRef.current.bookId !== current.bookId ||
        inputRef.current.workflow?.id !== workflowId
      )
        return;
      setState((previous) => ({ ...previous, reviews, loading: false, error: undefined }));
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error, '분석 검토 항목을 불러오지 못했습니다.');
      setState((previous) => ({ ...previous, loading: false, error: message }));
      if (!silent) current.notify(message, 'danger');
    }
  }, []);

  useEffect(() => {
    loadAbortRef.current?.abort();
    mutationAbortRef.current?.abort();
    setState(INITIAL_STATE);
  }, [input.bookId, input.gateway, input.workflow?.id]);

  useEffect(() => {
    if (!workflowId || !workflowStatus || !['needs_review', 'failed'].includes(workflowStatus)) return;
    void refresh(true);
  }, [refresh, workflowId, workflowStatus, workflowUpdatedAt]);

  useEffect(
    () => () => {
      loadAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
    },
    [],
  );

  const beginMutation = useCallback((reviewId: string) => {
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setState((previous) => ({ ...previous, busyReviewId: reviewId, error: undefined }));
    return controller;
  }, []);

  const finishMutation = useCallback((reviewId: string, error?: string) => {
    setState((previous) =>
      previous.busyReviewId === reviewId ? { ...previous, busyReviewId: undefined, error } : previous,
    );
  }, []);

  const saveDraft = useCallback(
    async (reviewId: string, candidate: ChapterLabelingResult, editIntents: AnalysisReviewEditIntentMap) => {
      const current = inputRef.current;
      const review = stateRef.current.reviews.find((item) => item.id === reviewId);
      if (!review || !current.gateway?.saveReviewDraft || stateRef.current.busyReviewId) return;
      const controller = beginMutation(reviewId);
      try {
        const updated = await current.gateway.saveReviewDraft(
          reviewId,
          review.reviewRevision,
          candidate,
          controller.signal,
          editIntents,
        );
        if (controller.signal.aborted) return;
        setState((previous) => ({ ...previous, reviews: replaceReview(previous.reviews, updated) }));
        current.notify(
          updated.validationSummary.errorCount + updated.qualitySummary.errorCount === 0
            ? '검토 초안을 저장하고 다시 검증했습니다.'
            : '검토 초안을 저장했습니다. 남은 오류를 확인하세요.',
          updated.validationSummary.errorCount + updated.qualitySummary.errorCount === 0 ? 'success' : 'warning',
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = errorMessage(error, '검토 초안을 저장하지 못했습니다.');
        finishMutation(reviewId, message);
        current.notify(message, 'danger');
        return;
      }
      finishMutation(reviewId);
    },
    [beginMutation, finishMutation],
  );

  const reject = useCallback(
    async (reviewId: string, reason?: string) => {
      const current = inputRef.current;
      const review = stateRef.current.reviews.find((item) => item.id === reviewId);
      if (!review || !current.gateway?.rejectReview || stateRef.current.busyReviewId) return;
      const controller = beginMutation(reviewId);
      try {
        const updated = await current.gateway.rejectReview(reviewId, review.reviewRevision, reason, controller.signal);
        if (controller.signal.aborted) return;
        setState((previous) => ({ ...previous, reviews: replaceReview(previous.reviews, updated) }));
        current.notify('분석 후보를 반려했습니다.', 'warning');
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = errorMessage(error, '분석 후보를 반려하지 못했습니다.');
        finishMutation(reviewId, message);
        current.notify(message, 'danger');
        return;
      }
      finishMutation(reviewId);
    },
    [beginMutation, finishMutation],
  );

  const approve = useCallback(
    async (reviewId: string) => {
      const current = inputRef.current;
      const review = stateRef.current.reviews.find((item) => item.id === reviewId);
      if (!review || !current.gateway?.approveReview || stateRef.current.busyReviewId) return;
      const controller = beginMutation(reviewId);
      try {
        const updated = await current.gateway.approveReview(reviewId, review.reviewRevision, controller.signal);
        if (controller.signal.aborted) return;
        setState((previous) => ({ ...previous, reviews: replaceReview(previous.reviews, updated) }));
        const resumed = await current.gateway.get(updated.workflowId, controller.signal);
        if (controller.signal.aborted) return;
        try {
          await current.onReviewPromoted(resumed);
        } catch {
          current.notify('승인은 반영됐지만 현재 화면의 라벨을 새로고침하지 못했습니다.', 'warning');
        }
        current.notify('검토 결과를 반영하고 다음 분석 window를 이어갑니다.', 'success');
        void Promise.resolve(current.resumeWorkflow(resumed)).catch(() => undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = errorMessage(error, '검토 결과를 승인하지 못했습니다.');
        finishMutation(reviewId, message);
        current.notify(message, 'danger');
        return;
      }
      finishMutation(reviewId);
    },
    [beginMutation, finishMutation],
  );

  return {
    ...state,
    available: Boolean(input.gateway?.listReviews),
    refresh,
    saveDraft,
    reject,
    approve,
  };
}
