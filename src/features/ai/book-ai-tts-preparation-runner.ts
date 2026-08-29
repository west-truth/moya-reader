import type { BookAIWorkflowPlan, BookAIWorkflowPlanOptions } from '../../providers/book-ai-workflow-plan';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  DEFAULT_BOOK_AI_WORKFLOW_VERSION,
} from '../../providers/book-ai-workflow-definition';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import {
  BookAnalysisWorkflowNotFoundError,
  type BookAnalysisWorkflow,
  type BookAnalysisWorkflowGateway,
  type BookAnalysisWorkflowDefinitionRef,
  type BookAnalysisWorkflowRuntime,
  type StartBookAnalysisWorkflowInput,
} from './book-analysis-workflow-gateway';
import {
  abortableWorkflowPollDelay,
  BOOK_AI_WORKFLOW_POLL_INTERVAL_MS,
  pollBookAIWorkflowUntilTerminal,
} from './book-ai-workflow-runner';

export interface BookAITTSPreparationMonitorOptions {
  readonly signal: AbortSignal;
  readonly attempts?: number;
  readonly pollIntervalMs?: number;
  readonly onProgress?: (workflow: BookAnalysisWorkflow) => void;
}

export type StartBookAITTSPreparationInput = Omit<
  StartBookAnalysisWorkflowInput,
  keyof BookAnalysisWorkflowDefinitionRef
> &
  Partial<BookAnalysisWorkflowDefinitionRef>;

/**
 * Replaceable execution boundary for the product's AI-assisted TTS preparation.
 * UI lifecycle, review presentation and ordinary system TTS intentionally remain
 * outside this runner.
 */
export interface BookAITTSPreparationRunner {
  /** Stable host-owned identity used to isolate durable workflow restoration. */
  readonly id: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly restoresLegacyWorkflowIds?: boolean;
  readonly runtime: BookAnalysisWorkflowRuntime;
  readonly supportsTTSCacheReadiness: boolean;
  getPlan(bookId: string, options?: BookAIWorkflowPlanOptions, signal?: AbortSignal): Promise<BookAIWorkflowPlan>;
  restore(
    bookId: string,
    storedWorkflowId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BookAnalysisWorkflow | undefined>;
  start(input: StartBookAITTSPreparationInput, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  cancel(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  refresh(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  monitor(workflowId: string, options: BookAITTSPreparationMonitorOptions): Promise<BookAnalysisWorkflow>;
  refreshCacheReadiness?(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
}

function isMissingWorkflowError(error: unknown): boolean {
  return (
    error instanceof BookAnalysisWorkflowNotFoundError || (error instanceof RemoteApiError && error.status === 404)
  );
}

export class GatewayBookAITTSPreparationRunner implements BookAITTSPreparationRunner {
  readonly id = DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID;
  readonly workflowVersion = DEFAULT_BOOK_AI_WORKFLOW_VERSION;
  readonly runtime: BookAnalysisWorkflowRuntime;
  readonly supportsTTSCacheReadiness: boolean;

  constructor(private readonly gateway: BookAnalysisWorkflowGateway) {
    this.runtime = gateway.runtime;
    this.supportsTTSCacheReadiness = gateway.supportsTTSCacheReadiness;
  }

  getPlan(bookId: string, options?: BookAIWorkflowPlanOptions, signal?: AbortSignal): Promise<BookAIWorkflowPlan> {
    return this.gateway.getPlan(bookId, options, signal);
  }

  async restore(
    bookId: string,
    storedWorkflowId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BookAnalysisWorkflow | undefined> {
    if (storedWorkflowId) {
      try {
        return await this.gateway.get(storedWorkflowId, signal);
      } catch (error) {
        if (!isMissingWorkflowError(error)) throw error;
      }
    }
    return this.gateway.getActive?.(bookId, signal);
  }

  start(input: StartBookAITTSPreparationInput, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.gateway.start(
      {
        ...input,
        workflowDefinitionId: input.workflowDefinitionId ?? this.id,
        workflowVersion: input.workflowVersion ?? this.workflowVersion,
      },
      signal,
    );
  }

  retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.gateway.retry(workflowId, signal);
  }

  cancel(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.gateway.cancel(workflowId, signal);
  }

  refresh(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.gateway.get(workflowId, signal);
  }

  monitor(workflowId: string, options: BookAITTSPreparationMonitorOptions): Promise<BookAnalysisWorkflow> {
    return pollBookAIWorkflowUntilTerminal({
      gateway: this.gateway,
      workflowId,
      signal: options.signal,
      attempts: options.attempts,
      delay: (signal) =>
        abortableWorkflowPollDelay(options.pollIntervalMs ?? BOOK_AI_WORKFLOW_POLL_INTERVAL_MS, signal),
      onProgress: options.onProgress,
    });
  }

  refreshCacheReadiness(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    if (!this.gateway.refreshTTSCacheReadiness) {
      return Promise.reject(new Error('현재 실행 환경은 TTS 오디오 cache 상태 확인을 지원하지 않습니다.'));
    }
    return this.gateway.refreshTTSCacheReadiness(workflowId, signal);
  }
}

/**
 * A small trusted workflow adapter that applies a replaceable planning policy
 * while leaving lifecycle, review and cache behavior on the production runner.
 */
export class ConfiguredBookAITTSPreparationRunner implements BookAITTSPreparationRunner {
  readonly restoresLegacyWorkflowIds: boolean;
  readonly runtime: BookAnalysisWorkflowRuntime;
  readonly supportsTTSCacheReadiness: boolean;

  constructor(
    readonly id: ExtensionContributionId,
    readonly workflowVersion: string,
    private readonly base: BookAITTSPreparationRunner,
    private readonly planOptions: BookAIWorkflowPlanOptions = {},
    options: { readonly discoverActiveWorkflow?: boolean; readonly restoresLegacyWorkflowIds?: boolean } = {},
  ) {
    this.runtime = base.runtime;
    this.supportsTTSCacheReadiness = base.supportsTTSCacheReadiness;
    this.discoverActiveWorkflow = options.discoverActiveWorkflow ?? false;
    this.restoresLegacyWorkflowIds = options.restoresLegacyWorkflowIds ?? false;
  }

  private readonly discoverActiveWorkflow: boolean;

  getPlan(bookId: string, options?: BookAIWorkflowPlanOptions, signal?: AbortSignal): Promise<BookAIWorkflowPlan> {
    return this.base.getPlan(bookId, { ...options, ...this.planOptions }, signal);
  }

  async restore(
    bookId: string,
    storedWorkflowId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BookAnalysisWorkflow | undefined> {
    if (!storedWorkflowId && !this.discoverActiveWorkflow) return Promise.resolve(undefined);
    const workflow = await this.base.restore(bookId, storedWorkflowId, signal);
    return workflow && this.matchesDefinition(workflow) ? workflow : undefined;
  }

  async start(input: StartBookAITTSPreparationInput, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    const workflow = await this.base.start(
      {
        ...input,
        workflowDefinitionId: this.id,
        workflowVersion: this.workflowVersion,
        planOptions: { ...input.planOptions, ...this.planOptions },
      },
      signal,
    );
    return this.requireDefinition(workflow);
  }

  async retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.requireDefinition(await this.base.retry(workflowId, signal));
  }

  cancel(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.base.cancel(workflowId, signal);
  }

  async refresh(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return this.requireDefinition(await this.base.refresh(workflowId, signal));
  }

  async monitor(workflowId: string, options: BookAITTSPreparationMonitorOptions): Promise<BookAnalysisWorkflow> {
    return this.requireDefinition(await this.base.monitor(workflowId, options));
  }

  async refreshCacheReadiness(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    if (!this.base.refreshCacheReadiness) {
      return Promise.reject(new Error('현재 실행 환경은 TTS 오디오 cache 상태 확인을 지원하지 않습니다.'));
    }
    return this.requireDefinition(await this.base.refreshCacheReadiness(workflowId, signal));
  }

  private matchesDefinition(workflow: BookAnalysisWorkflow): boolean {
    return workflow.workflowDefinitionId === this.id && workflow.workflowVersion === this.workflowVersion;
  }

  private requireDefinition(workflow: BookAnalysisWorkflow): BookAnalysisWorkflow {
    if (!this.matchesDefinition(workflow)) {
      throw new Error(
        `AI workflow identity mismatch: expected ${this.id}@${this.workflowVersion}, received ${workflow.workflowDefinitionId}@${workflow.workflowVersion}.`,
      );
    }
    return workflow;
  }
}
