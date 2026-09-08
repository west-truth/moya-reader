const KEY = 'moyaNavigation';
type Marker = { session: string; id: number; position: number };
type Entry<T> = { marker: Marker; key: string; snapshot: T };

function marker(state: unknown): Marker | undefined {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  if (!value || typeof value !== 'object') return;
  const candidate = value as Marker;
  return typeof candidate.session === 'string' &&
    Number.isSafeInteger(candidate.id) &&
    Number.isSafeInteger(candidate.position)
    ? candidate
    : undefined;
}

/** Browser state contains opaque entry IDs only; metadata snapshots stay in this tab's memory. */
export class BrowserNavigation<T> {
  private readonly session = crypto.randomUUID();
  private serial = 0;
  private current: Entry<T>;
  private readonly entries = new Map<number, Entry<T>>();
  private restoration?: AbortController;
  private disposed = false;
  private moving = false;
  private readonly listener = (event: PopStateEvent) => {
    void this.pop(event.state);
  };

  constructor(
    private readonly options: {
      window: Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>;
      initial: { key: string; snapshot: T };
      capture(): { key: string; snapshot: T };
      intermediate?(from: T, to: T): { key: string; snapshot: T } | undefined;
      closesLayer?(from: T, to: T): boolean;
      cancelPending(): void;
      restore(snapshot: T, signal: AbortSignal): Promise<void>;
      onError(error: unknown): void;
      settled(): Promise<void>;
    },
  ) {
    const position = marker(options.window.history.state)?.position ?? 0;
    this.current = { ...options.initial, marker: { session: this.session, id: this.serial++, position } };
    this.entries.set(this.current.marker.id, this.current);
    this.write(false);
    options.window.addEventListener('popstate', this.listener as EventListener);
  }

  private write(push: boolean) {
    const history = this.options.window.history;
    const state = {
      ...(history.state && typeof history.state === 'object' ? history.state : {}),
      [KEY]: this.current.marker,
    };
    if (push) history.pushState(state, '');
    else history.replaceState(state, '');
  }

  record(value: { key: string; snapshot: T }): void {
    if (this.disposed || this.restoration || this.moving) return;
    if (this.current.key === value.key) {
      Object.assign(this.current, value);
      return;
    }
    if (this.options.closesLayer?.(this.current.snapshot, value.snapshot) && this.back()) return;
    const intermediate = this.options.intermediate?.(this.current.snapshot, value.snapshot);
    if (intermediate) this.append(intermediate);
    this.append(value);
  }

  private append(value: { key: string; snapshot: T }) {
    for (const [id, entry] of this.entries) {
      if (entry.marker.position > this.current.marker.position) this.entries.delete(id);
    }
    this.current = {
      ...value,
      marker: { session: this.session, id: this.serial++, position: this.current.marker.position + 1 },
    };
    this.entries.set(this.current.marker.id, this.current);
    // Keep the first screen plus a bounded number of recent metadata snapshots.
    if (this.entries.size > 48) {
      const evicted = [...this.entries.keys()].find((id) => id !== 0 && id !== this.current.marker.id);
      if (evicted !== undefined) this.entries.delete(evicted);
    }
    this.write(true);
  }

  back(): boolean {
    if (this.disposed) return false;
    if (this.moving) return true;
    if (![...this.entries.values()].some((entry) => entry.marker.position < this.current.marker.position)) return false;
    this.moving = true;
    this.options.window.history.back();
    return true;
  }

  private async pop(state: unknown): Promise<void> {
    this.moving = false;
    this.restoration?.abort();
    this.restoration = undefined;
    const next = marker(state);
    if (!next) return; // The browser is free to leave at the first app screen.
    const direction = next.position < this.current.marker.position ? -1 : 1;
    const entry = next.session === this.session ? this.entries.get(next.id) : undefined;
    if (!entry) {
      this.options.window.history.go(direction);
      return;
    }
    const abort = new AbortController();
    this.restoration = abort;
    this.current = entry;
    this.options.cancelPending();
    try {
      await this.options.restore(entry.snapshot, abort.signal);
      await this.options.settled();
      if (abort.signal.aborted || this.disposed) return;
      Object.assign(entry, this.options.capture());
      this.write(false);
    } catch (error) {
      if (!abort.signal.aborted && !this.disposed) {
        this.options.onError(error);
        await this.options.settled();
        if (!abort.signal.aborted && !this.disposed) {
          Object.assign(entry, this.options.capture());
          this.write(false);
        }
      }
    } finally {
      if (this.restoration === abort) this.restoration = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.restoration?.abort();
    this.options.window.removeEventListener('popstate', this.listener as EventListener);
    this.entries.clear();
  }
}

let appBack: (() => boolean) | undefined;
export function installAppHistoryBack(action: () => boolean): () => void {
  appBack = action;
  return () => {
    if (appBack === action) appBack = undefined;
  };
}
export function navigateAppBack(fallback: () => void | Promise<void>): void {
  if (!appBack?.()) void fallback();
}
