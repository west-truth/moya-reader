import { describe, expect, it, vi } from 'vitest';
import type {
  NativeBookWorkflowFinalizeRequest,
  NativeBookWorkflowMaterializeRequest,
  NativeBookWorkflowSubmitRequest,
  NativeBookWorkflowView,
  NativeWorkflowCheckpointResult,
} from '../../features/ai/native-workflow/contracts';
import { TauriNativeBookWorkflowBridge, type NativeWorkflowInvoke } from './native-book-workflow-bridge';

const workflow: NativeBookWorkflowView = {
  schemaVersion: 2,
  id: 'workflow_1',
  idempotencyKey: 'idempotency_1',
  novelId: 'novel_1',
  contentRevision: 'revision_1',
  planHash: 'plan_hash',
  payloadHash: 'payload_hash',
  status: 'waiting_for_input',
  currentStage: 'character_graph_bootstrap',
  fence: 3,
  jobs: [],
  checkpoints: [],
  readinessOutcome: null,
  reviewItems: [],
  errorCode: null,
  createdAtMs: 1,
  updatedAtMs: 2,
};

const submitRequest: NativeBookWorkflowSubmitRequest = {
  idempotencyKey: 'idempotency_1',
  novelId: 'novel_1',
  contentRevision: 'revision_1',
  planHash: 'plan_hash',
  stages: [],
};

const materializeRequest: NativeBookWorkflowMaterializeRequest = {
  workflowId: 'workflow_1',
  jobId: 'job_1',
  expectedFence: 3,
  request: {
    providerId: 'provider_1',
    modelId: 'model_1',
    prompt: 'prompt',
    responseSchema: { type: 'object' },
    jsonSchemaName: 'result',
  },
};

const finalizeRequest: NativeBookWorkflowFinalizeRequest = {
  workflowId: 'workflow_1',
  expectedFence: 4,
  outcome: 'ready_for_tts',
  reviewItems: [],
};

const reviewRequest = {
  workflowId: 'workflow_1',
  expectedFence: 4,
  errorCode: 'invalid_checkpoint',
  reviewItems: [{ code: 'invalid_checkpoint' }],
} as const;

describe('TauriNativeBookWorkflowBridge', () => {
  it('maps every bridge operation to the exact Tauri command and payload', async () => {
    const checkpoint: NativeWorkflowCheckpointResult = {
      workflowId: 'workflow_1',
      jobId: 'job_1',
      requestHash: 'request_hash',
      outputHash: 'output_hash',
      output: { value: true },
    };
    const invokeMock = vi.fn(async (command: string) =>
      command === 'native_book_workflow_checkpoint_get' ? checkpoint : workflow,
    );
    const invoke = invokeMock as NativeWorkflowInvoke;
    const bridge = new TauriNativeBookWorkflowBridge({ invoke });

    await expect(bridge.submit(submitRequest)).resolves.toBe(workflow);
    await expect(bridge.get('workflow_1')).resolves.toBe(workflow);
    await expect(bridge.getActive({ novelId: 'novel_1', contentRevision: 'revision_1' })).resolves.toBe(workflow);
    await expect(bridge.materialize(materializeRequest)).resolves.toBe(workflow);
    await expect(bridge.finalize(finalizeRequest)).resolves.toBe(workflow);
    await expect(bridge.requireReview(reviewRequest)).resolves.toBe(workflow);
    await expect(bridge.resume('workflow_1')).resolves.toBe(workflow);
    await expect(bridge.cancel('workflow_1')).resolves.toBe(workflow);
    await expect(bridge.checkpoint({ workflowId: 'workflow_1', jobId: 'job_1' })).resolves.toBe(checkpoint);

    expect(invokeMock.mock.calls).toEqual([
      ['native_book_workflow_submit', { request: submitRequest }],
      ['native_book_workflow_get', { workflowId: 'workflow_1' }],
      ['native_book_workflow_active_get', { novelId: 'novel_1', contentRevision: 'revision_1' }],
      ['native_book_workflow_materialize', { request: materializeRequest }],
      ['native_book_workflow_finalize_readiness', { request: finalizeRequest }],
      ['native_book_workflow_require_review', { request: reviewRequest }],
      ['native_book_workflow_resume', { workflowId: 'workflow_1' }],
      ['native_book_workflow_cancel', { workflowId: 'workflow_1' }],
      ['native_book_workflow_checkpoint_get', { workflowId: 'workflow_1', jobId: 'job_1' }],
    ]);
  });

  it('maps a null active workflow to undefined', async () => {
    const invoke = vi.fn().mockResolvedValue(null) as NativeWorkflowInvoke;
    const bridge = new TauriNativeBookWorkflowBridge({ invoke });

    await expect(bridge.getActive({ novelId: 'novel_1', contentRevision: 'revision_1' })).resolves.toBeUndefined();
  });

  it('loads invoke lazily once and reuses it', async () => {
    const invoke = vi.fn().mockResolvedValue(workflow) as NativeWorkflowInvoke;
    const loadInvoke = vi.fn().mockResolvedValue(invoke);
    const bridge = new TauriNativeBookWorkflowBridge({ loadInvoke });

    expect(loadInvoke).not.toHaveBeenCalled();
    await bridge.get('workflow_1');
    await bridge.resume('workflow_1');

    expect(loadInvoke).toHaveBeenCalledOnce();
  });

  it('uses injected invoke without loading the Tauri module', async () => {
    const invoke = vi.fn().mockResolvedValue(workflow) as NativeWorkflowInvoke;
    const loadInvoke = vi.fn();
    const bridge = new TauriNativeBookWorkflowBridge({ invoke, loadInvoke });

    await bridge.get('workflow_1');

    expect(invoke).toHaveBeenCalledOnce();
    expect(loadInvoke).not.toHaveBeenCalled();
  });

  it('reports an actionable error when Tauri invoke cannot be loaded', async () => {
    const bridge = new TauriNativeBookWorkflowBridge({
      loadInvoke: vi.fn().mockRejectedValue(new Error('module unavailable')),
    });

    await expect(bridge.get('workflow_1')).rejects.toThrow(
      'Native book workflows are unavailable because Tauri invoke could not be loaded. Run this workflow in the Tauri desktop app or inject an invoke implementation.',
    );
  });
});
