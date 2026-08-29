export const DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID = 'moya.ai.tts.book-preparation' as const;
export const DEFAULT_BOOK_AI_WORKFLOW_VERSION = '1.0.0' as const;

export interface BookAIWorkflowDefinitionReference {
  readonly workflowDefinitionId: typeof DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID;
  readonly workflowVersion: typeof DEFAULT_BOOK_AI_WORKFLOW_VERSION;
}

export const DEFAULT_BOOK_AI_WORKFLOW_DEFINITION: BookAIWorkflowDefinitionReference = Object.freeze({
  workflowDefinitionId: DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  workflowVersion: DEFAULT_BOOK_AI_WORKFLOW_VERSION,
});

export function isSupportedBookAIWorkflowDefinitionReference(
  value: unknown,
): value is BookAIWorkflowDefinitionReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.workflowDefinitionId === DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID &&
    record.workflowVersion === DEFAULT_BOOK_AI_WORKFLOW_VERSION
  );
}

export function resolveBookAIWorkflowDefinitionReference(
  input: {
    readonly workflowDefinitionId?: unknown;
    readonly workflowVersion?: unknown;
  } = {},
): BookAIWorkflowDefinitionReference | undefined {
  const legacyRequest = input.workflowDefinitionId === undefined && input.workflowVersion === undefined;
  if (legacyRequest) return DEFAULT_BOOK_AI_WORKFLOW_DEFINITION;
  return isSupportedBookAIWorkflowDefinitionReference(input) ? DEFAULT_BOOK_AI_WORKFLOW_DEFINITION : undefined;
}
