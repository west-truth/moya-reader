import type { AnalysisWorkflowContributionDescriptor } from '@noveldesk/extension-contracts';
import { describe, expect, it } from 'vitest';
import { BOOK_AI_TTS_WORKFLOW_ID } from './builtin/book-ai-tts-workflow-extension';
import {
  resolveManagedBookWorkflow,
  resolveTrustedBookAITTSWorkflow,
  selectManagedBookWorkflow,
} from './analysis-workflow-selection';
import type { TrustedAnalysisWorkflowContribution } from './trusted-extension-registry';

interface Context {
  readonly enabled: ReadonlySet<string>;
}

function workflow(
  id: `${string}.${string}`,
  options: Partial<AnalysisWorkflowContributionDescriptor> = {},
): TrustedAnalysisWorkflowContribution<Context> {
  return {
    extensionId: id.split('.').slice(0, -1).join('.') as `${string}.${string}`,
    descriptor: {
      id,
      schemaVersion: 1,
      title: id,
      target: 'book',
      kind: 'managed',
      ...options,
    },
    isEnabled: ({ enabled }) => enabled.has(id),
    render: () => null,
  };
}

describe('managed analysis workflow selection', () => {
  const alternateId = 'example.ai.alternate' as const;
  const bundled = workflow(BOOK_AI_TTS_WORKFLOW_ID);
  const alternate = workflow(alternateId);

  it('prefers a book override over the global and bundled defaults', () => {
    const result = resolveManagedBookWorkflow({
      workflows: [bundled, alternate],
      context: { enabled: new Set([BOOK_AI_TTS_WORKFLOW_ID, alternateId]) },
      bookId: 'book-1',
      preferences: {
        schemaVersion: 1,
        defaultWorkflowId: BOOK_AI_TTS_WORKFLOW_ID,
        bookOverrides: { 'book-1': alternateId },
      },
    });

    expect(result.active?.descriptor.id).toBe(alternateId);
    expect(result.usedFallback).toBe(false);
  });

  it('falls back without erasing an unavailable preference', () => {
    const result = resolveManagedBookWorkflow({
      workflows: [bundled, alternate],
      context: { enabled: new Set([BOOK_AI_TTS_WORKFLOW_ID]) },
      bookId: 'book-1',
      preferences: { schemaVersion: 1, bookOverrides: { 'book-1': alternateId } },
    });

    expect(result.active?.descriptor.id).toBe(BOOK_AI_TTS_WORKFLOW_ID);
    expect(result.preferredId).toBe(alternateId);
    expect(result.usedFallback).toBe(true);
  });

  it('quietly maps the retired detailed-speaker sample to the official workflow', () => {
    const result = resolveManagedBookWorkflow({
      workflows: [bundled],
      context: { enabled: new Set([BOOK_AI_TTS_WORKFLOW_ID]) },
      bookId: 'book-1',
      preferences: {
        schemaVersion: 1,
        bookOverrides: { 'book-1': 'moya.ai.tts.detailed.speaker-preparation' },
      },
    });

    expect(result.active?.descriptor.id).toBe(BOOK_AI_TTS_WORKFLOW_ID);
    expect(result.preferredId).toBe(BOOK_AI_TTS_WORKFLOW_ID);
    expect(result.usedFallback).toBe(false);
  });

  it('writes only the selected book override', () => {
    expect(
      selectManagedBookWorkflow(
        { schemaVersion: 1, defaultWorkflowId: BOOK_AI_TTS_WORKFLOW_ID, bookOverrides: { older: alternateId } },
        'book-1',
        alternateId,
      ),
    ).toEqual({
      schemaVersion: 1,
      defaultWorkflowId: BOOK_AI_TTS_WORKFLOW_ID,
      bookOverrides: { older: alternateId, 'book-1': alternateId },
    });
  });

  it('selects a surface and runner only from the same trusted workflow intersection', () => {
    const missingRunner = workflow('example.ai.missing-runner');
    const result = resolveTrustedBookAITTSWorkflow({
      workflows: [bundled, alternate, missingRunner],
      runnerWorkflowIds: [BOOK_AI_TTS_WORKFLOW_ID, alternateId],
      bookId: 'book-1',
      preferences: { schemaVersion: 1, bookOverrides: { 'book-1': 'example.ai.missing-runner' } },
    });

    expect(result.active?.descriptor.id).toBe(BOOK_AI_TTS_WORKFLOW_ID);
    expect(result.available.map(({ descriptor }) => descriptor.id)).toEqual([BOOK_AI_TTS_WORKFLOW_ID, alternateId]);
    expect(result.usedFallback).toBe(true);
  });
});
