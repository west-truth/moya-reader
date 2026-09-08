import { describe, expect, it, vi } from 'vitest';
import { BrowserNavigation } from './browser-navigation';

type Screen = { screen: string; query?: string };
function browser() {
  const entries: unknown[] = [null, { foreign: 'preserved' }];
  let index = 1;
  const listeners = new Set<(event: { state: unknown }) => void>();
  const go = vi.fn((delta: number) => {
    index = Math.max(0, Math.min(entries.length - 1, index + delta));
    const state = entries[index];
    queueMicrotask(() => listeners.forEach((listener) => listener({ state })));
  });
  return {
    entries,
    go,
    index: () => index,
    window: {
      history: {
        get state() {
          return entries[index];
        },
        pushState(value: unknown) {
          entries.splice(index + 1);
          entries.push(value);
          index++;
        },
        replaceState(value: unknown) {
          entries[index] = value;
        },
        back: () => go(-1),
        forward: () => go(1),
        go,
      },
      addEventListener: (_type: string, listener: (event: { state: unknown }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { state: unknown }) => void) => listeners.delete(listener),
    } as unknown as Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>,
  };
}

function fixture(b = browser()) {
  let current: Screen = { screen: 'library' };
  const restore = vi.fn(async (value: Screen, signal: AbortSignal) => {
    signal.throwIfAborted();
    current = value;
  });
  const capture = () => ({ key: current.screen, snapshot: current });
  const onError = vi.fn();
  const navigation = new BrowserNavigation({
    window: b.window,
    initial: capture(),
    capture,
    restore,
    onError,
    cancelPending: vi.fn(),
    settled: async () => undefined,
  });
  return {
    b,
    navigation,
    restore,
    onError,
    current: () => current,
    show(screen: string, query?: string) {
      current = { screen, query };
      navigation.record(capture());
    },
  };
}

describe('browser app navigation', () => {
  it('skips evicted snapshots and still reaches the first app screen', async () => {
    const h = fixture();
    try {
      for (let index = 0; index < 60; index++) h.show(`work-${index}`);
      h.b.go(-59);
      await vi.waitFor(() => expect(h.current().screen).toBe('library'));
      expect(h.navigation.back()).toBe(false);
      expect(h.onError).not.toHaveBeenCalled();
    } finally {
      h.navigation.dispose();
    }
  });

  it('inserts a detail screen before direct reading without recording chapter changes', async () => {
    const b = browser();
    let screen = 'library';
    const capture = () => ({ key: screen, snapshot: screen });
    const history = new BrowserNavigation({
      window: b.window,
      initial: capture(),
      capture,
      intermediate: (from, to) =>
        from === 'library' && to === 'reader' ? { key: 'detail', snapshot: 'detail' } : undefined,
      cancelPending: vi.fn(),
      onError: vi.fn(),
      settled: async () => {},
      restore: async (value) => {
        screen = value;
      },
    });
    try {
      screen = 'reader';
      history.record(capture());
      history.record(capture());
      expect(b.entries).toHaveLength(4);
      history.back();
      await vi.waitFor(() => expect(screen).toBe('detail'));
      history.back();
      await vi.waitFor(() => expect(screen).toBe('library'));
    } finally {
      history.dispose();
    }
  });

  it('restores back/forward without pushing duplicate entries, and allows leaving from the root', async () => {
    const h = fixture();
    try {
      h.show('source', 'saved search');
      h.show('detail');
      h.show('reader');
      const length = h.b.entries.length;
      h.b.window.history.back();
      await vi.waitFor(() => expect(h.current().screen).toBe('detail'));
      h.b.window.history.back();
      await vi.waitFor(() => expect(h.current()).toEqual({ screen: 'source', query: 'saved search' }));
      h.b.window.history.forward();
      await vi.waitFor(() => expect(h.current().screen).toBe('detail'));
      expect(h.b.entries).toHaveLength(length);
      h.b.go(-2);
      await vi.waitFor(() => expect(h.current().screen).toBe('library'));
      expect(h.navigation.back()).toBe(false);
      h.b.window.history.back();
      await vi.waitFor(() => expect(h.b.index()).toBe(0));
      expect(h.onError).not.toHaveBeenCalled();
    } finally {
      h.navigation.dispose();
    }
  });

  it('updates a screen snapshot without recording each query or reading position change', async () => {
    const h = fixture();
    try {
      h.show('source', 'a');
      h.show('source', 'ab');
      h.show('source', 'abc');
      expect(h.b.entries).toHaveLength(3);
      expect(JSON.stringify(h.b.entries)).not.toContain('abc');
      expect(h.b.window.history.state.foreign).toBe('preserved');
      h.show('detail');
      h.navigation.back();
      await vi.waitFor(() => expect(h.current().query).toBe('abc'));
    } finally {
      h.navigation.dispose();
    }
  });

  it('invalidates a delayed restore on a second pop and discards stale completion', async () => {
    const h = fixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = h.restore.getMockImplementation()!;
    h.restore.mockImplementation(async (value, signal) => {
      if (value.screen === 'detail') await wait;
      await normal(value, signal);
    });
    try {
      h.show('source');
      h.show('detail');
      h.show('reader');
      h.b.window.history.back();
      await vi.waitFor(() => expect(h.restore).toHaveBeenCalledOnce());
      h.b.window.history.back();
      await vi.waitFor(() => expect(h.current().screen).toBe('source'));
      release();
      await Promise.resolve();
      expect(h.restore.mock.calls[0]![1].aborted).toBe(true);
      expect(h.current().screen).toBe('source');
      expect(h.onError).not.toHaveBeenCalled();
    } finally {
      release();
      h.navigation.dispose();
    }
  });

  it('skips stale owned entries after reload so back does not trap the user', async () => {
    const first = fixture();
    first.show('source');
    first.show('detail');
    first.navigation.dispose();
    const reloaded = fixture(first.b);
    try {
      reloaded.b.window.history.back();
      await vi.waitFor(() => expect(reloaded.b.index()).toBe(0));
      expect(reloaded.restore).not.toHaveBeenCalled();
    } finally {
      reloaded.navigation.dispose();
    }
  });

  it('drops the forward branch after a new navigation', async () => {
    const h = fixture();
    try {
      h.show('source');
      h.show('detail');
      h.navigation.back();
      await vi.waitFor(() => expect(h.current().screen).toBe('source'));
      h.show('another-work');
      expect(h.b.entries).toHaveLength(4);
      h.b.window.history.back();
      await vi.waitFor(() => expect(h.current().screen).toBe('source'));
    } finally {
      h.navigation.dispose();
    }
  });
});
