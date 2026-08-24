import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION,
  resolveBookAIWorkflowDefinitionReference,
} from './book-ai-workflow-definition';

describe('book AI workflow definition reference', () => {
  it('maps a legacy missing reference to the official default', () => {
    expect(resolveBookAIWorkflowDefinitionReference()).toBe(DEFAULT_BOOK_AI_WORKFLOW_DEFINITION);
  });

  it('accepts only the supported official definition and version', () => {
    expect(resolveBookAIWorkflowDefinitionReference(DEFAULT_BOOK_AI_WORKFLOW_DEFINITION)).toBe(
      DEFAULT_BOOK_AI_WORKFLOW_DEFINITION,
    );
    expect(
      resolveBookAIWorkflowDefinitionReference({
        workflowDefinitionId: DEFAULT_BOOK_AI_WORKFLOW_DEFINITION.workflowDefinitionId,
        workflowVersion: '2.0.0',
      }),
    ).toBeUndefined();
    expect(
      resolveBookAIWorkflowDefinitionReference({
        workflowDefinitionId: 'community.workflow',
        workflowVersion: DEFAULT_BOOK_AI_WORKFLOW_DEFINITION.workflowVersion,
      }),
    ).toBeUndefined();
  });

  it('rejects partial, blank, and non-string references instead of treating them as legacy', () => {
    expect(
      resolveBookAIWorkflowDefinitionReference({ workflowDefinitionId: 'moya.ai.tts.book-preparation' }),
    ).toBeUndefined();
    expect(resolveBookAIWorkflowDefinitionReference({ workflowVersion: '1.0.0' })).toBeUndefined();
    expect(
      resolveBookAIWorkflowDefinitionReference({ workflowDefinitionId: null, workflowVersion: undefined }),
    ).toBeUndefined();
    expect(
      resolveBookAIWorkflowDefinitionReference({ workflowDefinitionId: '', workflowVersion: '1.0.0' }),
    ).toBeUndefined();
    expect(
      resolveBookAIWorkflowDefinitionReference({ workflowDefinitionId: 1, workflowVersion: '1.0.0' }),
    ).toBeUndefined();
  });
});
