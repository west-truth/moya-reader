import type { BookAnalysisWorkflow, BookAnalysisWorkflowGateway } from './book-analysis-workflow-gateway';
import { isTerminalBookAIWorkflow } from './book-ai-workflow-view';

export const BOOK_AI_WORKFLOW_POLL_INTERVAL_MS = 2200;
export const BOOK_AI_WORKFLOW_POLL_ATTEMPTS = 900;

interface PollBookAIWorkflowInput {
  readonly gateway: Pick<BookAnalysisWorkflowGateway, 'get'>;
  readonly workflowId: string;
  readonly signal: AbortSignal;
  readonly attempts?: number;
  readonly delay?: (signal: AbortSignal) => Promise<void>;
  readonly onProgress?: (workflow: BookAnalysisWorkflow) => void;
}

export function abortableWorkflowPollDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = globalThis.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export async function pollBookAIWorkflowUntilTerminal({
  gateway,
  workflowId,
  signal,
  attempts = BOOK_AI_WORKFLOW_POLL_ATTEMPTS,
  delay = (requestSignal) => abortableWorkflowPollDelay(BOOK_AI_WORKFLOW_POLL_INTERVAL_MS, requestSignal),
  onProgress,
}: PollBookAIWorkflowInput): Promise<BookAnalysisWorkflow> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(signal);
    const workflow = await gateway.get(workflowId, signal);
    onProgress?.(workflow);
    if (isTerminalBookAIWorkflow(workflow)) return workflow;
  }
  throw new Error('Book AI workflow polling timed out');
}
