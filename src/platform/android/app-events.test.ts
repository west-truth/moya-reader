import { describe, expect, it, vi } from 'vitest';
import type { PlatformRuntimeInfo } from '../runtime';
import {
  ANDROID_APP_BACK_EVENT,
  ANDROID_APP_LIFECYCLE_EVENT,
  bindAndroidAppEvents,
  createAndroidTauriEventSource,
  type AndroidDocumentEventSource,
  type AndroidWindowEventSource,
  type TauriAppEvent,
  type TauriAppEventSource,
} from './app-events';

const mobileRuntime: PlatformRuntimeInfo = {
  kind: 'tauri-mobile',
  hasTauri: true,
  isMobileWebView: true,
  userAgent: 'Android',
};

class FakeDocumentSource implements AndroidDocumentEventSource {
  visibilityState = 'visible';
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeWindowSource implements AndroidWindowEventSource {
  private readonly listeners = new Map<'pagehide' | 'pageshow', Set<() => void>>();

  addEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'pagehide' | 'pageshow'): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

class FakeTauriEventSource implements TauriAppEventSource {
  private readonly listeners = new Map<string, Set<(event: TauriAppEvent<unknown>) => void>>();

  async listen<Value>(event: string, handler: (event: TauriAppEvent<Value>) => void): Promise<() => void> {
    const listeners = this.listeners.get(event) ?? new Set();
    const untypedHandler = handler as (event: TauriAppEvent<unknown>) => void;
    listeners.add(untypedHandler);
    this.listeners.set(event, listeners);
    return () => listeners.delete(untypedHandler);
  }

  emit(event: string, payload?: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener({ payload }));
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe('Android app event boundary', () => {
  it('uses Tauri AppPlugin as the single hardware-back source and the shell plugin only for lifecycle', async () => {
    let backHandler: ((payload: unknown) => void) | undefined;
    let lifecycleHandler: ((payload: unknown) => void) | undefined;
    const unregisterBack = vi.fn(async () => undefined);
    const unregisterLifecycle = vi.fn(async () => undefined);
    const onBackButtonPress = vi.fn(async (handler: (payload: unknown) => void) => {
      backHandler = handler;
      return { unregister: unregisterBack };
    });
    const addPluginListener = vi.fn(async (_plugin: string, _event: string, handler: (payload: unknown) => void) => {
      lifecycleHandler = handler;
      return { unregister: unregisterLifecycle };
    });
    const source = createAndroidTauriEventSource({ onBackButtonPress, addPluginListener });
    const onBack = vi.fn();
    const onLifecycle = vi.fn();

    const disposeBack = await source.listen(ANDROID_APP_BACK_EVENT, ({ payload }) => onBack(payload));
    const disposeLifecycle = await source.listen(ANDROID_APP_LIFECYCLE_EVENT, ({ payload }) => onLifecycle(payload));
    backHandler?.({ canGoBack: false });
    lifecycleHandler?.({ phase: 'background' });

    expect(onBackButtonPress).toHaveBeenCalledOnce();
    expect(addPluginListener).toHaveBeenCalledWith(
      'noveldesk-android-shell',
      ANDROID_APP_LIFECYCLE_EVENT,
      expect.any(Function),
    );
    expect(onBack).toHaveBeenCalledWith({ canGoBack: false });
    expect(onLifecycle).toHaveBeenCalledWith({ phase: 'background' });

    disposeBack();
    disposeLifecycle();
    expect(unregisterBack).toHaveBeenCalledOnce();
    expect(unregisterLifecycle).toHaveBeenCalledOnce();
  });

  it('is inert in browser and desktop runtimes', async () => {
    const documentSource = new FakeDocumentSource();
    const loadTauriEvents = vi.fn(async () => new FakeTauriEventSource());
    const binding = bindAndroidAppEvents({
      runtime: { ...mobileRuntime, kind: 'browser', hasTauri: false, isMobileWebView: false },
      handlers: { onBack: vi.fn(), onLifecycle: vi.fn() },
      documentSource,
      loadTauriEvents,
    });

    await binding.ready;
    expect(loadTauriEvents).not.toHaveBeenCalled();
    expect(documentSource.listenerCount).toBe(0);
  });

  it('merges WebView and native lifecycle events without duplicate phase notifications', async () => {
    const documentSource = new FakeDocumentSource();
    const windowSource = new FakeWindowSource();
    const nativeSource = new FakeTauriEventSource();
    const onBack = vi.fn(() => true);
    const onLifecycle = vi.fn();
    const binding = bindAndroidAppEvents({
      runtime: mobileRuntime,
      handlers: { onBack, onLifecycle },
      documentSource,
      windowSource,
      loadTauriEvents: async () => nativeSource,
    });
    await binding.ready;

    nativeSource.emit(ANDROID_APP_BACK_EVENT);
    documentSource.visibilityState = 'hidden';
    documentSource.emit();
    windowSource.emit('pagehide');
    nativeSource.emit(ANDROID_APP_LIFECYCLE_EVENT, { phase: 'foreground' });
    windowSource.emit('pageshow');
    nativeSource.emit(ANDROID_APP_LIFECYCLE_EVENT, { phase: 'not-a-phase' });

    expect(onBack).toHaveBeenCalledOnce();
    expect(onLifecycle.mock.calls).toEqual([['background'], ['foreground']]);

    binding.dispose();
    expect(documentSource.listenerCount).toBe(0);
    expect(nativeSource.listenerCount(ANDROID_APP_BACK_EVENT)).toBe(0);
    expect(nativeSource.listenerCount(ANDROID_APP_LIFECYCLE_EVENT)).toBe(0);
    nativeSource.emit(ANDROID_APP_BACK_EVENT);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('keeps the WebView lifecycle fallback active when the native listener cannot load', async () => {
    const documentSource = new FakeDocumentSource();
    const onLifecycle = vi.fn();
    const onError = vi.fn();
    const binding = bindAndroidAppEvents({
      runtime: mobileRuntime,
      handlers: { onBack: vi.fn(), onLifecycle, onError },
      documentSource,
      loadTauriEvents: async () => {
        throw new Error('native event source unavailable');
      },
    });
    await binding.ready;

    documentSource.visibilityState = 'hidden';
    documentSource.emit();

    expect(onError).toHaveBeenCalledOnce();
    expect(onLifecycle).toHaveBeenCalledWith('background');
    binding.dispose();
  });
});
