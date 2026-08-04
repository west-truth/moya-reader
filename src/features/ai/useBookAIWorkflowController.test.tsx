import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import { BookAnalysisWorkflowNotFoundError, type BookAnalysisWorkflow } from './book-analysis-workflow-gateway';
import {
  useBookAIWorkflowController,
  type BookAIWorkflowControllerInput,
  type BookAIWorkflowIdStore,
} from './useBookAIWorkflowController';

function workflow(bookId: string): BookAnalysisWorkflow {
  const plan: BookAIWorkflowPlan = {
    novelId: bookId,
    totalChapters: 0,
    totalCharacters: 0,
    stages: [],
    bundleWindows: [],
    labelingChapters: [],
    labelingWindows: [],
    ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
  };
  return {
    id: `workflow-${bookId}`,
    novelId: bookId,
    workflowType: 'book_ai_tts',
    runtime: 'hosted',
    providerId: 'test',
    planHash: `plan-${bookId}`,
    plan,
    status: 'succeeded',
    stage: 'ready_for_tts',
    readiness: { outcome: 'ready_for_tts', reviewItems: [] },
    progress: {
      ttsReadiness: { ok: true },
      ttsCacheReadiness: { ok: true },
    },
    jobs: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('book AI workflow controller', () => {
  it('scopes TTS readiness invalidation to the selected book', async () => {
    const ids = new Map<string, string>();
    const store: BookAIWorkflowIdStore = {
      get: (bookId) => ids.get(bookId),
      set: (bookId, workflowId) => ids.set(bookId, workflowId),
      delete: (bookId) => ids.delete(bookId),
    };
    const baseInput = {
      chapterIds: [],
      beforeRun: vi.fn(async () => true),
      onTerminal: vi.fn(async () => true),
      onCancelled: vi.fn(async () => undefined),
      openAIAddon: vi.fn(),
      notify: vi.fn(),
      store,
    } satisfies Omit<BookAIWorkflowControllerInput, 'bookId'>;
    let selectedBookId = 'book-a';
    let controller!: ReturnType<typeof useBookAIWorkflowController>;
    function Harness() {
      controller = useBookAIWorkflowController({ ...baseInput, bookId: selectedBookId });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      controller.adoptWorkflow(workflow('book-a'));
      controller.invalidateTTSReadiness();
    });
    expect(controller.workflow?.progress).toEqual({});
    expect(controller.workflow?.readiness.outcome).toBe('pending');

    selectedBookId = 'book-b';
    await act(async () => renderer.update(<Harness />));
    await act(async () => {
      expect(controller.adoptWorkflow(workflow('book-b'))).toBe(true);
    });

    expect(controller.workflow?.progress).toEqual({
      ttsReadiness: { ok: true },
      ttsCacheReadiness: { ok: true },
    });
    await act(async () => renderer.unmount());
  });

  it('restores a native active workflow when no browser workflow id exists', async () => {
    const active = workflow('book-a');
    const gateway = {
      runtime: 'native' as const,
      supportsTTSCacheReadiness: false,
      getPlan: vi.fn(),
      start: vi.fn(),
      get: vi.fn(),
      getActive: vi.fn(async () => active),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const store: BookAIWorkflowIdStore = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(),
    };
    let controller!: ReturnType<typeof useBookAIWorkflowController>;
    function Harness() {
      controller = useBookAIWorkflowController({
        gateway,
        bookId: 'book-a',
        chapterIds: [],
        beforeRun: vi.fn(async () => true),
        onTerminal: vi.fn(async () => true),
        onCancelled: vi.fn(async () => undefined),
        openAIAddon: vi.fn(),
        notify: vi.fn(),
        store,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
    });

    expect(gateway.getActive).toHaveBeenCalledWith('book-a', expect.any(AbortSignal));
    expect(controller.workflow?.id).toBe(active.id);
    expect(store.set).toHaveBeenCalledWith('book-a', active.id);
    await act(async () => renderer.unmount());
  });

  it('clears a stale native id and falls back to active workflow discovery', async () => {
    const active = { ...workflow('book-a'), runtime: 'native' as const };
    const gateway = {
      runtime: 'native' as const,
      supportsTTSCacheReadiness: false,
      getPlan: vi.fn(),
      start: vi.fn(),
      get: vi.fn(async () => {
        throw new BookAnalysisWorkflowNotFoundError('stale-workflow');
      }),
      getActive: vi.fn(async () => active),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const store: BookAIWorkflowIdStore = {
      get: vi.fn(() => 'stale-workflow'),
      set: vi.fn(),
      delete: vi.fn(),
    };
    let controller!: ReturnType<typeof useBookAIWorkflowController>;
    function Harness() {
      controller = useBookAIWorkflowController({
        gateway,
        bookId: 'book-a',
        chapterIds: [],
        beforeRun: vi.fn(async () => true),
        onTerminal: vi.fn(async () => true),
        onCancelled: vi.fn(async () => undefined),
        openAIAddon: vi.fn(),
        notify: vi.fn(),
        store,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
    });

    expect(store.delete).toHaveBeenCalledWith('book-a');
    expect(gateway.getActive).toHaveBeenCalledWith('book-a', expect.any(AbortSignal));
    expect(controller.workflow?.id).toBe(active.id);
    await act(async () => renderer.unmount());
  });

  it('forces a fresh run when starting after a terminal native workflow', async () => {
    const previous = { ...workflow('book-a'), runtime: 'native' as const };
    const replacement = { ...previous, id: 'workflow-book-a-replacement' };
    const gateway = {
      runtime: 'native' as const,
      supportsTTSCacheReadiness: false,
      getPlan: vi.fn(async () => previous.plan),
      start: vi.fn(async () => replacement),
      get: vi.fn(async () => replacement),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    let controller!: ReturnType<typeof useBookAIWorkflowController>;
    function Harness() {
      controller = useBookAIWorkflowController({
        gateway,
        bookId: 'book-a',
        chapterIds: [],
        beforeRun: vi.fn(async () => true),
        onTerminal: vi.fn(async () => true),
        onCancelled: vi.fn(async () => undefined),
        openAIAddon: vi.fn(),
        notify: vi.fn(),
        pollIntervalMs: 0,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      controller.adoptWorkflow(previous);
    });
    await act(async () => {
      await controller.start({ providerId: 'openai', modelId: 'gpt-test' });
    });

    expect(gateway.start).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 'book-a', force: true }),
      expect.any(AbortSignal),
    );
    expect(controller.workflow?.id).toBe(replacement.id);
    await act(async () => renderer.unmount());
  });

  it('resumes polling after a reviewed window is promoted', async () => {
    const resumed = {
      ...workflow('book-a'),
      status: 'running',
      stage: 'labeling_chapters',
      readiness: { outcome: 'pending' as const, reviewItems: [] },
      updatedAt: '2026-07-11T00:01:00.000Z',
    };
    const completed = {
      ...workflow('book-a'),
      updatedAt: '2026-07-11T00:02:00.000Z',
    };
    const onTerminal = vi.fn(async () => true);
    const gateway = {
      runtime: 'hosted' as const,
      supportsTTSCacheReadiness: true,
      getPlan: vi.fn(),
      start: vi.fn(),
      get: vi.fn(async () => completed),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    let controller!: ReturnType<typeof useBookAIWorkflowController>;
    function Harness() {
      controller = useBookAIWorkflowController({
        gateway,
        bookId: 'book-a',
        chapterIds: [],
        beforeRun: vi.fn(async () => true),
        onTerminal,
        onCancelled: vi.fn(async () => undefined),
        openAIAddon: vi.fn(),
        notify: vi.fn(),
        pollIntervalMs: 0,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => controller.resumeMonitoring(resumed));

    expect(gateway.get).toHaveBeenCalledWith(resumed.id, expect.any(AbortSignal));
    expect(onTerminal).toHaveBeenCalledWith('book-a', completed);
    expect(controller.workflow?.status).toBe('succeeded');
    await act(async () => renderer.unmount());
  });
});
