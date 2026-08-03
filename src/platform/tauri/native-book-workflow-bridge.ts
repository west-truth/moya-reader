import type {
  NativeBookWorkflowBridge,
  NativeBookWorkflowFinalizeRequest,
  NativeBookWorkflowMaterializeRequest,
  NativeBookWorkflowReviewRequest,
  NativeBookWorkflowSubmitRequest,
  NativeBookWorkflowView,
  NativeWorkflowActiveRequest,
  NativeWorkflowCheckpointRequest,
  NativeWorkflowCheckpointResult,
  NativeLabelMutationFinalizeRequest,
  NativeLabelMutationPrepareRequest,
} from '../../features/ai/native-workflow/contracts';

export type NativeWorkflowInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriNativeBookWorkflowBridgeOptions {
  readonly invoke?: NativeWorkflowInvoke;
  readonly loadInvoke?: () => Promise<NativeWorkflowInvoke>;
}

async function loadTauriInvoke(): Promise<NativeWorkflowInvoke> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as NativeWorkflowInvoke;
}

export class TauriNativeBookWorkflowBridge implements NativeBookWorkflowBridge {
  private invokePromise?: Promise<NativeWorkflowInvoke>;

  constructor(private readonly options: TauriNativeBookWorkflowBridgeOptions = {}) {}

  submit(request: NativeBookWorkflowSubmitRequest): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_submit', { request });
  }

  get(workflowId: string): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_get', { workflowId });
  }

  async getActive(request: NativeWorkflowActiveRequest): Promise<NativeBookWorkflowView | undefined> {
    const workflow = await this.invoke<NativeBookWorkflowView | null>('native_book_workflow_active_get', {
      novelId: request.novelId,
      contentRevision: request.contentRevision,
    });
    return workflow ?? undefined;
  }

  materialize(request: NativeBookWorkflowMaterializeRequest): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_materialize', { request });
  }

  finalize(request: NativeBookWorkflowFinalizeRequest): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_finalize_readiness', { request });
  }

  requireReview(request: NativeBookWorkflowReviewRequest): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_require_review', { request });
  }

  resume(workflowId: string): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_resume', { workflowId });
  }

  cancel(workflowId: string): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_cancel', { workflowId });
  }

  checkpoint(request: NativeWorkflowCheckpointRequest): Promise<NativeWorkflowCheckpointResult> {
    return this.invoke('native_book_workflow_checkpoint_get', {
      workflowId: request.workflowId,
      jobId: request.jobId,
    });
  }

  prepareLabelMutation(request: NativeLabelMutationPrepareRequest): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_label_mutation_prepare', { request });
  }

  finalizeLabelMutation(request: NativeLabelMutationFinalizeRequest): Promise<NativeBookWorkflowView> {
    return this.invoke('native_book_workflow_label_mutation_finalize', { request });
  }

  private async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const invoke = await this.getInvoke();
    return invoke<T>(command, args);
  }

  private getInvoke(): Promise<NativeWorkflowInvoke> {
    if (this.options.invoke) return Promise.resolve(this.options.invoke);
    this.invokePromise ??= (this.options.loadInvoke ?? loadTauriInvoke)().catch(() => {
      throw new Error(
        'Native book workflows are unavailable because Tauri invoke could not be loaded. Run this workflow in the Tauri desktop app or inject an invoke implementation.',
      );
    });
    return this.invokePromise;
  }
}
