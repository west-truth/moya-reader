import type { AIWorkflowPreferencesV1 } from '../domain/types';
import { BOOK_AI_TTS_WORKFLOW_ID } from './builtin/book-ai-tts-workflow-extension';
import type { TrustedAnalysisWorkflowContribution } from './trusted-extension-registry';

const RETIRED_DETAILED_SPEAKER_WORKFLOW_ID = 'moya.ai.tts.detailed.speaker-preparation';

export interface ManagedAnalysisWorkflowSelection<TContext> {
  readonly active?: TrustedAnalysisWorkflowContribution<TContext>;
  readonly available: readonly TrustedAnalysisWorkflowContribution<TContext>[];
  readonly preferredId?: string;
  readonly usedFallback: boolean;
}

function selectAvailableManagedBookWorkflow<TContext>(input: {
  readonly available: readonly TrustedAnalysisWorkflowContribution<TContext>[];
  readonly bookId?: string;
  readonly preferences?: AIWorkflowPreferencesV1;
}): ManagedAnalysisWorkflowSelection<TContext> {
  const { available } = input;
  const storedPreferredId =
    (input.bookId ? input.preferences?.bookOverrides?.[input.bookId] : undefined) ??
    input.preferences?.defaultWorkflowId;
  const preferredId =
    storedPreferredId === RETIRED_DETAILED_SPEAKER_WORKFLOW_ID ? BOOK_AI_TTS_WORKFLOW_ID : storedPreferredId;
  const active =
    available.find(({ descriptor }) => descriptor.id === preferredId) ??
    available.find(({ descriptor }) => descriptor.id === BOOK_AI_TTS_WORKFLOW_ID) ??
    available[0];
  return {
    active,
    available,
    preferredId,
    usedFallback: Boolean(preferredId && active?.descriptor.id !== preferredId),
  };
}

export function resolveManagedBookWorkflow<TContext>(input: {
  readonly workflows: readonly TrustedAnalysisWorkflowContribution<TContext>[];
  readonly context: TContext;
  readonly bookId?: string;
  readonly preferences?: AIWorkflowPreferencesV1;
}): ManagedAnalysisWorkflowSelection<TContext> {
  const available = input.workflows.filter(
    (workflow) =>
      workflow.descriptor.kind === 'managed' &&
      workflow.descriptor.target === 'book' &&
      workflow.isEnabled?.(input.context) !== false,
  );
  return selectAvailableManagedBookWorkflow({ ...input, available });
}

/** Resolves the managed surface and its source-reviewed execution factory as one selection. */
export function resolveTrustedBookAITTSWorkflow<TContext>(input: {
  readonly workflows: readonly TrustedAnalysisWorkflowContribution<TContext>[];
  readonly runnerWorkflowIds: readonly string[];
  readonly bookId?: string;
  readonly preferences?: AIWorkflowPreferencesV1;
}): ManagedAnalysisWorkflowSelection<TContext> {
  const runnerWorkflowIds = new Set(input.runnerWorkflowIds);
  const available = input.workflows.filter(
    (workflow) =>
      workflow.descriptor.kind === 'managed' &&
      workflow.descriptor.target === 'book' &&
      runnerWorkflowIds.has(workflow.descriptor.id),
  );
  return selectAvailableManagedBookWorkflow({ ...input, available });
}

export function selectManagedBookWorkflow(
  preferences: AIWorkflowPreferencesV1 | undefined,
  bookId: string,
  workflowId: string,
): AIWorkflowPreferencesV1 {
  return {
    schemaVersion: 1,
    ...preferences,
    bookOverrides: {
      ...preferences?.bookOverrides,
      [bookId]: workflowId,
    },
  };
}
