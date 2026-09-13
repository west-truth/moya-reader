/** Leave one host slot for cancellation/control while keeping foreground work ahead of optional covers. */
export class NativeRequestQueue {
  private active = 0;
  private waiting: { priority: number; start(): void; cancel(): void }[] = [];
  run<T>(task: () => Promise<T>, signal?: AbortSignal, priority = 0): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.waiting.length >= 128) return Promise.reject(new Error('execution_busy'));
    return new Promise<T>((resolve, reject) => {
      const entry = {
        priority,
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', entry.cancel);
          reject(signal?.reason);
        },
        start: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.active++;
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.drain();
            });
        },
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', entry.cancel, { once: true });
      this.drain();
    });
  }
  private drain() {
    this.waiting.sort((a, b) => a.priority - b.priority);
    while (this.active < 3 && this.waiting.length) this.waiting.shift()!.start();
  }
}
