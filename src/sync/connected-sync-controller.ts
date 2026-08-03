import type { ReaderView } from './sync-ui';

export interface ConnectedSyncSelection<Book = unknown, Chapter = unknown> {
  readonly view: ReaderView;
  readonly bookId?: string;
  readonly chapterId?: string;
  readonly chapterProgress: number;
  readonly book?: Book;
  readonly chapter?: Chapter;
}

export interface RuntimeTaskContext {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface SelectionTaskContext<Book = unknown, Chapter = unknown> extends RuntimeTaskContext {
  readonly selection: ConnectedSyncSelection<Book, Chapter>;
  isLatestTask(): boolean;
  isSelectionCurrent(): boolean;
}

interface TaskHandlers<Context extends RuntimeTaskContext, Result> {
  readonly load: (context: Context) => Promise<Result>;
  readonly commit?: (result: Result, context: Context) => void | Promise<void>;
  readonly recover?: (error: unknown, context: Context) => Result | undefined | Promise<Result | undefined>;
  readonly start?: (context: Context) => void;
  readonly settle?: (context: Context) => void;
}

interface ActiveTask {
  readonly generation: number;
  readonly controller: AbortController;
  readonly detachLifetimeAbort: () => void;
}

const DEFAULT_MUTATION_PUSH_DELAY_MS = 500;

function selectionIdentity(selection: ConnectedSyncSelection): string {
  return `${selection.view}\u0000${selection.bookId ?? ''}\u0000${selection.chapterId ?? ''}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class ConnectedSyncController<Book = unknown, Chapter = unknown> {
  private readonly lifetimeController = new AbortController();
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly taskGenerations = new Map<string, number>();
  private selectionGeneration = 0;
  private currentSelectionIdentity: string;
  private bootstrapPromise?: Promise<void>;
  private mutationPushTimer?: ReturnType<typeof setTimeout>;
  private retainedCount = 0;
  private disposed = false;

  constructor(
    private selection: ConnectedSyncSelection<Book, Chapter>,
    private readonly runtimeIsCurrent: () => boolean = () => true,
  ) {
    this.currentSelectionIdentity = selectionIdentity(selection);
  }

  retain(): void {
    if (this.disposed) return;
    this.retainedCount += 1;
  }

  release(): void {
    this.retainedCount = Math.max(0, this.retainedCount - 1);
    queueMicrotask(() => {
      if (this.retainedCount === 0) this.dispose();
    });
  }

  updateSelection(selection: ConnectedSyncSelection<Book, Chapter>): void {
    const nextIdentity = selectionIdentity(selection);
    if (nextIdentity !== this.currentSelectionIdentity) {
      this.currentSelectionIdentity = nextIdentity;
      this.selectionGeneration += 1;
    }
    this.selection = selection;
  }

  startBootstrap(run: (context: RuntimeTaskContext) => Promise<void>): Promise<void> {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    const context = this.createRuntimeContext();
    this.bootstrapPromise = Promise.resolve()
      .then(() => (context.isCurrent() ? run(context) : undefined))
      .catch((error: unknown) => {
        if (!context.isCurrent() || isAbortError(error)) return;
        throw error;
      });
    return this.bootstrapPromise;
  }

  runRuntimeTask<Result>(
    lane: string,
    handlers: TaskHandlers<RuntimeTaskContext, Result>,
  ): Promise<Result | undefined> {
    const task = this.startTask(lane);
    const context: RuntimeTaskContext = {
      signal: task.controller.signal,
      isCurrent: () => this.runtimeTaskIsCurrent(lane, task),
    };
    return this.runTask(lane, task, context, handlers);
  }

  runSelectionTask<Result>(
    lane: string,
    handlers: TaskHandlers<SelectionTaskContext<Book, Chapter>, Result>,
  ): Promise<Result | undefined> {
    const task = this.startTask(lane);
    const selectionGeneration = this.selectionGeneration;
    const selection = this.selection;
    const context: SelectionTaskContext<Book, Chapter> = {
      signal: task.controller.signal,
      selection,
      isLatestTask: () => this.runtimeTaskIsCurrent(lane, task),
      isSelectionCurrent: () => selectionGeneration === this.selectionGeneration,
      isCurrent: () => this.runtimeTaskIsCurrent(lane, task) && selectionGeneration === this.selectionGeneration,
    };
    return this.runTask(lane, task, context, handlers);
  }

  scheduleMutationPush(push: () => Promise<unknown>, delayMs = DEFAULT_MUTATION_PUSH_DELAY_MS): void {
    if (!this.runtimeIsActive()) return;
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('mutation push delay must be non-negative');
    if (this.mutationPushTimer) clearTimeout(this.mutationPushTimer);
    this.mutationPushTimer = setTimeout(() => {
      this.mutationPushTimer = undefined;
      if (!this.runtimeIsActive()) return;
      void push().catch(() => undefined);
    }, delayMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mutationPushTimer) clearTimeout(this.mutationPushTimer);
    this.mutationPushTimer = undefined;
    this.lifetimeController.abort();
    for (const task of this.activeTasks.values()) {
      task.detachLifetimeAbort();
      task.controller.abort();
    }
    this.activeTasks.clear();
  }

  private createRuntimeContext(): RuntimeTaskContext {
    return {
      signal: this.lifetimeController.signal,
      isCurrent: () => this.runtimeIsActive(),
    };
  }

  private runtimeIsActive(): boolean {
    return !this.disposed && !this.lifetimeController.signal.aborted && this.runtimeIsCurrent();
  }

  private startTask(lane: string): ActiveTask {
    const previous = this.activeTasks.get(lane);
    previous?.detachLifetimeAbort();
    previous?.controller.abort();
    const generation = (this.taskGenerations.get(lane) ?? 0) + 1;
    this.taskGenerations.set(lane, generation);
    const controller = new AbortController();
    const abortFromLifetime = () => controller.abort();
    if (this.lifetimeController.signal.aborted) {
      controller.abort();
    } else {
      this.lifetimeController.signal.addEventListener('abort', abortFromLifetime, { once: true });
    }
    const task = {
      generation,
      controller,
      detachLifetimeAbort: () => this.lifetimeController.signal.removeEventListener('abort', abortFromLifetime),
    };
    this.activeTasks.set(lane, task);
    return task;
  }

  private runtimeTaskIsCurrent(lane: string, task: ActiveTask): boolean {
    return (
      this.runtimeIsActive() &&
      !task.controller.signal.aborted &&
      this.activeTasks.get(lane)?.generation === task.generation
    );
  }

  private async runTask<Context extends RuntimeTaskContext, Result>(
    lane: string,
    task: ActiveTask,
    context: Context,
    handlers: TaskHandlers<Context, Result>,
  ): Promise<Result | undefined> {
    if (!context.isCurrent()) return undefined;
    handlers.start?.(context);
    try {
      const result = await handlers.load(context);
      if (!context.isCurrent()) return undefined;
      await handlers.commit?.(result, context);
      return context.isCurrent() ? result : undefined;
    } catch (error) {
      if (!context.isCurrent() || isAbortError(error)) return undefined;
      if (!handlers.recover) throw error;
      return handlers.recover(error, context);
    } finally {
      if (this.runtimeTaskIsCurrent(lane, task)) handlers.settle?.(context);
      task.detachLifetimeAbort();
      if (this.activeTasks.get(lane)?.generation === task.generation) this.activeTasks.delete(lane);
    }
  }
}
