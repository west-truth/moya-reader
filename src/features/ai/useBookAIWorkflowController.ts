import { useCallback, useEffect, useRef, useState } from 'react';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import { AIExecutionLane, type AIExecutionToken } from './ai-execution-lane';
import {
  BookAnalysisWorkflowNotFoundError,
  type BookAnalysisWorkflow,
  type BookAnalysisWorkflowGateway,
} from './book-analysis-workflow-gateway';
import {
  abortableWorkflowPollDelay,
  BOOK_AI_WORKFLOW_POLL_INTERVAL_MS,
  pollBookAIWorkflowUntilTerminal,
} from './book-ai-workflow-runner';
import { isTerminalBookAIWorkflow, recordValue } from './book-ai-workflow-view';

type NotificationTone = 'success' | 'warning' | 'danger' | 'info';

export interface BookAIWorkflowIdStore {
  get(bookId: string): string | undefined;
  set(bookId: string, workflowId: string): void;
  delete(bookId: string): void;
}

export interface BookAIWorkflowControllerInput {
  readonly gateway?: BookAnalysisWorkflowGateway;
  readonly bookId?: string;
  readonly chapterIds: readonly string[];
  readonly beforeRun: (bookId: string, chapterIds: readonly string[]) => Promise<boolean>;
  readonly onTerminal: (bookId: string, workflow: BookAnalysisWorkflow) => Promise<boolean | void>;
  readonly onCancelled: (bookId: string, workflow: BookAnalysisWorkflow) => Promise<void>;
  readonly openAIAddon: () => void;
  readonly notify: (message: string, tone: NotificationTone) => void;
  readonly store?: BookAIWorkflowIdStore;
  readonly pollIntervalMs?: number;
  readonly pollAttempts?: number;
}

interface BookAIWorkflowState {
  readonly workflow?: BookAnalysisWorkflow;
  readonly plan?: BookAIWorkflowPlan;
  readonly loading: boolean;
  readonly running: boolean;
  readonly error?: string;
}

interface WorkflowOperationResult {
  readonly workflow?: BookAnalysisWorkflow;
  readonly plan?: BookAIWorkflowPlan;
  readonly confirmsTTSReadiness?: boolean;
}

interface StartBookAIWorkflowOptions {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

const INITIAL_STATE: BookAIWorkflowState = {
  loading: false,
  running: false,
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function isMissingWorkflowError(error: unknown): boolean {
  return (
    error instanceof BookAnalysisWorkflowNotFoundError || (error instanceof RemoteApiError && error.status === 404)
  );
}

function browserWorkflowIdStore(runtime: BookAnalysisWorkflowGateway['runtime']): BookAIWorkflowIdStore {
  const key = (bookId: string) => `noveldesk.book_ai_workflow.${runtime}.${bookId}`;
  const legacyKey = (bookId: string) => `noveldesk.book_ai_workflow.${bookId}`;
  return {
    get: (bookId) =>
      window.localStorage.getItem(key(bookId)) ??
      (runtime === 'hosted' ? window.localStorage.getItem(legacyKey(bookId)) : null) ??
      undefined,
    set: (bookId, workflowId) => {
      window.localStorage.setItem(key(bookId), workflowId);
      if (runtime === 'hosted') window.localStorage.removeItem(legacyKey(bookId));
    },
    delete: (bookId) => {
      window.localStorage.removeItem(key(bookId));
      if (runtime === 'hosted') window.localStorage.removeItem(legacyKey(bookId));
    },
  };
}

function workflowIsNewer(current: BookAnalysisWorkflow | undefined, candidate: BookAnalysisWorkflow): boolean {
  if (!current) return true;
  if (current.id !== candidate.id) return false;
  const currentTime = Date.parse(current.updatedAt);
  const candidateTime = Date.parse(candidate.updatedAt);
  return !Number.isFinite(currentTime) || !Number.isFinite(candidateTime) || candidateTime >= currentTime;
}

function withoutTTSReadiness(workflow: BookAnalysisWorkflow): BookAnalysisWorkflow {
  const progress = recordValue(workflow.progress);
  if (!progress?.ttsCacheReadiness && !progress?.ttsReadiness && workflow.readiness.outcome === 'pending') {
    return workflow;
  }
  const remainingProgress = { ...progress };
  delete remainingProgress.ttsCacheReadiness;
  delete remainingProgress.ttsReadiness;
  return {
    ...workflow,
    progress: remainingProgress as BookAnalysisWorkflow['progress'],
    readiness: { outcome: 'pending', reviewItems: [] },
  };
}

export function useBookAIWorkflowController(input: BookAIWorkflowControllerInput) {
  const { gateway, bookId } = input;
  const [state, setState] = useState<BookAIWorkflowState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const inputRef = useRef(input);
  const laneRef = useRef(new AIExecutionLane());
  const operationBusyRef = useRef(false);
  const ttsReadinessDirtyRef = useRef(false);
  const browserStoreRef = useRef<{
    readonly runtime: BookAnalysisWorkflowGateway['runtime'];
    readonly store: BookAIWorkflowIdStore;
  }>();
  if (gateway && typeof window !== 'undefined' && browserStoreRef.current?.runtime !== gateway.runtime) {
    browserStoreRef.current = { runtime: gateway.runtime, store: browserWorkflowIdStore(gateway.runtime) };
  }
  const store = input.store ?? browserStoreRef.current?.store;
  const storeRef = useRef(store);
  stateRef.current = state;
  inputRef.current = input;
  storeRef.current = store;

  const commitWorkflow = useCallback(
    (token: AIExecutionToken, workflow: BookAnalysisWorkflow, confirmsTTSReadiness = false) => {
      if (!laneRef.current.isCurrent(token, workflow.novelId)) return false;
      if (confirmsTTSReadiness) ttsReadinessDirtyRef.current = false;
      const nextWorkflow = ttsReadinessDirtyRef.current ? withoutTTSReadiness(workflow) : workflow;
      setState((previous) => ({ ...previous, workflow: nextWorkflow, plan: workflow.plan }));
      storeRef.current?.set(workflow.novelId, workflow.id);
      return true;
    },
    [],
  );

  const finishOperation = useCallback((token: AIExecutionToken) => {
    if (!laneRef.current.complete(token)) return;
    operationBusyRef.current = false;
    setState((previous) => ({ ...previous, loading: false, running: false }));
  }, []);

  useEffect(() => {
    const lane = laneRef.current;
    lane.invalidate();
    operationBusyRef.current = false;
    ttsReadinessDirtyRef.current = false;
    setState(INITIAL_STATE);
    if (gateway && bookId && store) {
      const workflowId = store.get(bookId);
      if (workflowId || gateway.getActive) {
        const token = laneRef.current.begin(bookId);
        const restore = workflowId
          ? gateway.get(workflowId, token.controller.signal).catch((error) => {
              if (!isMissingWorkflowError(error)) throw error;
              store.delete(bookId);
              return gateway.getActive?.(bookId, token.controller.signal);
            })
          : gateway.getActive!(bookId, token.controller.signal);
        operationBusyRef.current = true;
        setState((previous) => ({ ...previous, loading: true }));
        void Promise.resolve(restore)
          .then(async (workflow) => {
            if (!workflow) return;
            if (workflow.novelId !== bookId) {
              if (laneRef.current.isCurrent(token, bookId)) store.delete(bookId);
              return;
            }
            if (!commitWorkflow(token, workflow)) return;
            if (isTerminalBookAIWorkflow(workflow)) {
              if (workflow.status === 'succeeded' || workflow.status === 'needs_review') {
                await inputRef.current.onTerminal(bookId, workflow);
              }
              return;
            }
            setState((previous) => ({ ...previous, running: true }));
            const finalWorkflow = await pollBookAIWorkflowUntilTerminal({
              gateway,
              workflowId: workflow.id,
              signal: token.controller.signal,
              attempts: inputRef.current.pollAttempts,
              delay: (signal) =>
                abortableWorkflowPollDelay(
                  inputRef.current.pollIntervalMs ?? BOOK_AI_WORKFLOW_POLL_INTERVAL_MS,
                  signal,
                ),
              onProgress: (progress) => commitWorkflow(token, progress),
            });
            if (!laneRef.current.isCurrent(token, bookId)) return;
            if (finalWorkflow.status === 'succeeded' || finalWorkflow.status === 'needs_review') {
              await inputRef.current.onTerminal(bookId, finalWorkflow);
            }
            if (!laneRef.current.isCurrent(token, bookId)) return;
            inputRef.current.notify(
              finalWorkflow.status === 'succeeded'
                ? '이전에 실행한 작품 전체 AI/TTS workflow가 완료되었습니다.'
                : finalWorkflow.status === 'needs_review'
                  ? '이전에 실행한 작품 전체 AI/TTS workflow에 검토가 필요한 항목이 있습니다.'
                  : `이전에 실행한 작품 전체 AI/TTS workflow가 ${finalWorkflow.status} 상태로 종료되었습니다.`,
              finalWorkflow.status === 'succeeded' ? 'success' : 'warning',
            );
          })
          .catch((error) => {
            if (!isAbortError(error) && laneRef.current.isCurrent(token, bookId)) {
              if (isMissingWorkflowError(error)) store.delete(bookId);
              setState((previous) => ({
                ...previous,
                error: isMissingWorkflowError(error)
                  ? '이전에 저장한 workflow를 찾을 수 없습니다. 새 분석을 시작할 수 있습니다.'
                  : '이전 workflow 자동 모니터링을 이어가지 못했습니다. 상태 새로고침으로 다시 연결할 수 있습니다.',
              }));
            }
          })
          .finally(() => finishOperation(token));
      }
    }

    return () => {
      lane.invalidate();
      operationBusyRef.current = false;
    };
  }, [bookId, commitWorkflow, finishOperation, gateway, store]);

  const poll = useCallback(
    (workflowId: string, token: AIExecutionToken) =>
      pollBookAIWorkflowUntilTerminal({
        gateway: gateway!,
        workflowId,
        signal: token.controller.signal,
        attempts: inputRef.current.pollAttempts,
        delay: (signal) =>
          abortableWorkflowPollDelay(inputRef.current.pollIntervalMs ?? BOOK_AI_WORKFLOW_POLL_INTERVAL_MS, signal),
        onProgress: (workflow) => commitWorkflow(token, workflow),
      }),
    [commitWorkflow, gateway],
  );

  const runWorkflow = useCallback(
    async (mode: 'start' | 'retry', options: StartBookAIWorkflowOptions = {}) => {
      if (!gateway || !bookId) return;
      const existing = stateRef.current.workflow;
      const storedWorkflowId = storeRef.current?.get(bookId);
      if (mode === 'start' && existing && !isTerminalBookAIWorkflow(existing)) {
        inputRef.current.notify('이미 실행 중인 작품 전체 AI/TTS workflow가 있습니다.', 'warning');
        return;
      }
      if (mode === 'retry' && !existing) return;
      if (mode === 'start' && storedWorkflowId && !existing) {
        inputRef.current.notify('저장된 작품 workflow 상태를 먼저 새로고침하거나 정리해야 합니다.', 'warning');
        return;
      }
      if (operationBusyRef.current) {
        inputRef.current.notify('작품 전체 AI/TTS 요청이 이미 진행 중입니다.', 'info');
        return;
      }

      operationBusyRef.current = true;
      const token = laneRef.current.begin(bookId);
      setState((previous) => ({ ...previous, loading: true, running: true, error: undefined }));
      inputRef.current.openAIAddon();
      try {
        const ready = await inputRef.current.beforeRun(bookId, inputRef.current.chapterIds);
        if (!ready || !laneRef.current.isCurrent(token, bookId)) return;

        let workflow: BookAnalysisWorkflow;
        if (mode === 'start') {
          const plan = await gateway.getPlan(bookId, undefined, token.controller.signal);
          if (!laneRef.current.isCurrent(token, bookId)) return;
          setState((previous) => ({ ...previous, plan }));
          workflow = await gateway.start(
            { bookId, ...options, force: Boolean(existing && isTerminalBookAIWorkflow(existing)) },
            token.controller.signal,
          );
        } else {
          workflow = await gateway.retry(existing!.id, token.controller.signal);
        }
        if (!laneRef.current.isCurrent(token, bookId)) {
          try {
            await gateway.cancel(workflow.id);
          } catch {
            // A detached workflow remains restorable from its durable runtime; cancellation is best effort.
          }
          return;
        }
        if (!commitWorkflow(token, workflow)) return;
        inputRef.current.notify(
          mode === 'start'
            ? '작품 전체 Character Graph 분석을 시작했습니다.'
            : '작품 전체 AI/TTS workflow 재시도를 시작했습니다.',
          'success',
        );

        const finalWorkflow = await poll(workflow.id, token);
        if (!laneRef.current.isCurrent(token, bookId)) return;
        commitWorkflow(token, finalWorkflow, true);
        if (finalWorkflow.status !== 'succeeded' && finalWorkflow.status !== 'needs_review') {
          throw new Error(finalWorkflow.errorMessage ?? `Book AI workflow ${finalWorkflow.status}`);
        }
        const refreshed = await inputRef.current.onTerminal(bookId, finalWorkflow);
        if (refreshed === false || !laneRef.current.isCurrent(token, bookId)) return;
        if (finalWorkflow.status === 'needs_review') {
          setState((previous) => ({ ...previous, error: undefined }));
          inputRef.current.notify('작품 전체 AI/TTS workflow에 사용자 검토가 필요한 항목이 있습니다.', 'warning');
          return;
        }
        inputRef.current.notify(
          mode === 'start'
            ? '작품 전체 AI/TTS workflow가 라벨/음성 매핑 준비 상태로 완료되었습니다.'
            : '작품 전체 AI/TTS workflow 재시도가 완료되었습니다.',
          'success',
        );
      } catch (error) {
        if (isAbortError(error) || !laneRef.current.isCurrent(token, bookId)) return;
        const message = errorMessage(error, '작품 전체 AI/TTS workflow 요청에 실패했습니다.');
        setState((previous) => ({ ...previous, error: message }));
        inputRef.current.notify(
          `${mode === 'start' ? '작품 전체 AI/TTS workflow 실패' : '작품 전체 AI/TTS workflow 재시도 실패'}: ${message}`,
          'danger',
        );
      } finally {
        finishOperation(token);
      }
    },
    [bookId, commitWorkflow, finishOperation, gateway, poll],
  );

  const runPassiveOperation = useCallback(
    async (
      operation: (
        workflowGateway: BookAnalysisWorkflowGateway,
        workflowId: string | undefined,
        signal: AbortSignal,
      ) => Promise<WorkflowOperationResult>,
      success: (result: WorkflowOperationResult) => void,
      failurePrefix: string,
    ) => {
      if (!gateway || !bookId) return;
      if (operationBusyRef.current) {
        inputRef.current.notify('작품 전체 AI/TTS 요청이 이미 진행 중입니다.', 'info');
        return;
      }
      operationBusyRef.current = true;
      const token = laneRef.current.begin(bookId);
      setState((previous) => ({ ...previous, loading: true, error: undefined }));
      try {
        const result = await operation(
          gateway,
          stateRef.current.workflow?.id ?? store?.get(bookId),
          token.controller.signal,
        );
        if (!laneRef.current.isCurrent(token, bookId)) return;
        if (result.workflow && !commitWorkflow(token, result.workflow, result.confirmsTTSReadiness)) return;
        else if (result.plan) setState((previous) => ({ ...previous, plan: result.plan }));
        success(result);
      } catch (error) {
        if (isAbortError(error) || !laneRef.current.isCurrent(token, bookId)) return;
        const message = errorMessage(error, failurePrefix);
        setState((previous) => ({ ...previous, error: message }));
        inputRef.current.notify(`${failurePrefix}: ${message}`, 'danger');
      } finally {
        finishOperation(token);
      }
    },
    [bookId, commitWorkflow, finishOperation, gateway, store],
  );

  const refreshPlan = useCallback(
    () =>
      runPassiveOperation(
        async (workflowGateway, workflowId, signal) => {
          const [plan, restoredWorkflow] = await Promise.all([
            workflowGateway.getPlan(bookId!, undefined, signal),
            workflowId ? workflowGateway.get(workflowId, signal).catch(() => undefined) : undefined,
          ]);
          return {
            plan,
            workflow: restoredWorkflow?.novelId === bookId ? restoredWorkflow : undefined,
          };
        },
        () => inputRef.current.notify('작품 전체 AI/TTS 계획을 불러왔습니다.', 'success'),
        '작품 전체 AI/TTS 계획을 불러오지 못했습니다',
      ),
    [bookId, runPassiveOperation],
  );

  const refreshStatus = useCallback(async () => {
    const workflowId = stateRef.current.workflow?.id ?? (bookId ? store?.get(bookId) : undefined);
    if (!workflowId) {
      await refreshPlan();
      return;
    }
    await runPassiveOperation(
      async (workflowGateway, _workflowId, signal) => ({ workflow: await workflowGateway.get(workflowId, signal) }),
      () => inputRef.current.notify('작품 전체 AI/TTS 상태를 새로고침했습니다.', 'success'),
      '작품 전체 AI/TTS 상태를 새로고침하지 못했습니다',
    );
  }, [bookId, refreshPlan, runPassiveOperation, store]);

  const cancel = useCallback(async () => {
    const workflow = stateRef.current.workflow;
    if (!gateway || !bookId || !workflow) return;
    operationBusyRef.current = true;
    const token = laneRef.current.begin(bookId);
    setState((previous) => ({ ...previous, loading: true, running: false, error: undefined }));
    try {
      const cancelledWorkflow = await gateway.cancel(workflow.id, token.controller.signal);
      if (!commitWorkflow(token, cancelledWorkflow)) return;
      inputRef.current.notify('작품 전체 AI/TTS workflow를 취소했습니다.', 'warning');
      await inputRef.current.onCancelled(bookId, cancelledWorkflow);
    } catch (error) {
      if (isAbortError(error) || !laneRef.current.isCurrent(token, bookId)) return;
      let failure = error;
      if (error instanceof RemoteApiError && error.status === 409) {
        try {
          const latest = await gateway.get(workflow.id, token.controller.signal);
          if (!commitWorkflow(token, latest)) return;
          if (latest.status === 'cancelled') {
            await inputRef.current.onCancelled(bookId, latest);
          } else if (latest.status === 'succeeded' || latest.status === 'needs_review') {
            await inputRef.current.onTerminal(bookId, latest);
          }
          inputRef.current.notify('작품 전체 AI/TTS workflow가 이미 종료되어 최신 상태를 불러왔습니다.', 'info');
          return;
        } catch (refreshError) {
          failure = refreshError;
        }
      }
      const message = errorMessage(failure, '작품 전체 AI/TTS workflow 취소에 실패했습니다.');
      setState((previous) => ({ ...previous, error: message }));
      inputRef.current.notify(`작품 전체 AI/TTS workflow 취소 실패: ${message}`, 'danger');
    } finally {
      finishOperation(token);
    }
  }, [bookId, commitWorkflow, finishOperation, gateway]);

  const refreshCacheReadiness = useCallback(
    () =>
      runPassiveOperation(
        async (workflowGateway, workflowId, signal) => {
          if (!workflowId) throw new Error('확인할 작품 workflow가 없습니다.');
          if (!workflowGateway.refreshTTSCacheReadiness) {
            throw new Error('현재 실행 환경은 TTS 오디오 cache 상태 확인을 지원하지 않습니다.');
          }
          const workflow = await workflowGateway.refreshTTSCacheReadiness(workflowId, signal);
          return { workflow, confirmsTTSReadiness: true };
        },
        ({ workflow }) => {
          const readiness = recordValue(recordValue(workflow?.progress)?.ttsCacheReadiness);
          inputRef.current.notify(
            readiness?.ok === true
              ? 'TTS 오디오 cache 준비 상태가 확인되었습니다.'
              : 'TTS 오디오 cache가 아직 모두 준비되지 않았습니다.',
            readiness?.ok === true ? 'success' : 'warning',
          );
        },
        'TTS 오디오 cache 상태 확인 실패',
      ),
    [runPassiveOperation],
  );

  const resumeMonitoring = useCallback(
    async (workflow: BookAnalysisWorkflow) => {
      if (!gateway || !bookId || workflow.novelId !== bookId) return;
      if (operationBusyRef.current) {
        inputRef.current.notify('작품 전체 AI/TTS 상태 확인이 이미 진행 중입니다.', 'info');
        return;
      }
      operationBusyRef.current = true;
      const token = laneRef.current.begin(bookId);
      setState((previous) => ({
        ...previous,
        loading: false,
        running: !isTerminalBookAIWorkflow(workflow),
        error: undefined,
      }));
      try {
        if (!commitWorkflow(token, workflow)) return;
        const finalWorkflow = isTerminalBookAIWorkflow(workflow) ? workflow : await poll(workflow.id, token);
        if (!commitWorkflow(token, finalWorkflow, true)) return;
        if (finalWorkflow.status === 'succeeded' || finalWorkflow.status === 'needs_review') {
          await inputRef.current.onTerminal(bookId, finalWorkflow);
        }
        if (!laneRef.current.isCurrent(token, bookId)) return;
        inputRef.current.notify(
          finalWorkflow.status === 'succeeded'
            ? '승인된 지점부터 이어진 작품 분석이 완료되었습니다.'
            : finalWorkflow.status === 'needs_review'
              ? '다음 분석 window에서 추가 검토가 필요합니다.'
              : `작품 전체 AI/TTS workflow가 ${finalWorkflow.status} 상태로 종료되었습니다.`,
          finalWorkflow.status === 'succeeded' ? 'success' : 'warning',
        );
      } catch (error) {
        if (isAbortError(error) || !laneRef.current.isCurrent(token, bookId)) return;
        const message = errorMessage(error, '승인 후 작품 분석 상태를 이어서 확인하지 못했습니다.');
        setState((previous) => ({ ...previous, error: message }));
        inputRef.current.notify(message, 'danger');
      } finally {
        finishOperation(token);
      }
    },
    [bookId, commitWorkflow, finishOperation, gateway, poll],
  );

  const adoptWorkflow = useCallback(
    (workflow: BookAnalysisWorkflow, options: { confirmsTTSReadiness?: boolean } = {}) => {
      if (!bookId || workflow.novelId !== bookId) return false;
      if (!workflowIsNewer(stateRef.current.workflow, workflow)) return false;
      if (options.confirmsTTSReadiness) ttsReadinessDirtyRef.current = false;
      const nextWorkflow = ttsReadinessDirtyRef.current ? withoutTTSReadiness(workflow) : workflow;
      setState((previous) => ({ ...previous, workflow: nextWorkflow, plan: workflow.plan }));
      store?.set(bookId, workflow.id);
      return true;
    },
    [bookId, store],
  );

  const invalidateTTSReadiness = useCallback(() => {
    ttsReadinessDirtyRef.current = true;
    setState((previous) => {
      if (!previous.workflow) return previous;
      const workflow = withoutTTSReadiness(previous.workflow);
      if (workflow === previous.workflow) return previous;
      return {
        ...previous,
        workflow,
      };
    });
  }, []);

  return {
    ...state,
    start: (options?: StartBookAIWorkflowOptions) => runWorkflow('start', options),
    retry: () => runWorkflow('retry'),
    cancel,
    refreshPlan,
    refreshStatus,
    refreshCacheReadiness,
    resumeMonitoring,
    adoptWorkflow,
    invalidateTTSReadiness,
  };
}
