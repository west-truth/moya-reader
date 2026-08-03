import type { PlatformRuntimeInfo } from '../runtime';

export const ANDROID_APP_BACK_EVENT = 'noveldesk://android/back';
export const ANDROID_APP_LIFECYCLE_EVENT = 'noveldesk://android/lifecycle';

export type AndroidAppLifecyclePhase = 'foreground' | 'background';

export interface AndroidAppEventHandlers {
  onBack(): boolean | void;
  onLifecycle(phase: AndroidAppLifecyclePhase): void;
  onError?(error: unknown): void;
}

export interface AndroidDocumentEventSource {
  readonly visibilityState?: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface AndroidWindowEventSource {
  addEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void;
  removeEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void;
}

export interface TauriAppEvent<Value = unknown> {
  readonly payload: Value;
}

export interface TauriAppEventSource {
  listen<Value>(event: string, handler: (event: TauriAppEvent<Value>) => void): Promise<() => void>;
}

interface TauriPluginListenerHandle {
  unregister(): Promise<void>;
}

export interface AndroidTauriEventBindings {
  onBackButtonPress(handler: (payload: unknown) => void): Promise<TauriPluginListenerHandle>;
  addPluginListener<Value>(
    plugin: string,
    event: string,
    handler: (payload: Value) => void,
  ): Promise<TauriPluginListenerHandle>;
}

export interface AndroidAppEventBinding {
  readonly ready: Promise<void>;
  dispose(): void;
}

export interface BindAndroidAppEventsInput {
  readonly runtime: PlatformRuntimeInfo;
  readonly handlers: AndroidAppEventHandlers;
  readonly documentSource?: AndroidDocumentEventSource;
  readonly windowSource?: AndroidWindowEventSource;
  readonly loadTauriEvents?: () => Promise<TauriAppEventSource>;
}

function lifecyclePhase(payload: unknown): AndroidAppLifecyclePhase | undefined {
  const candidate = typeof payload === 'string' ? payload : (payload as { phase?: unknown } | undefined)?.phase;
  return candidate === 'foreground' || candidate === 'background' ? candidate : undefined;
}

export function createAndroidTauriEventSource(bindings: AndroidTauriEventBindings): TauriAppEventSource {
  return {
    listen: async <Value>(event: string, handler: (event: TauriAppEvent<Value>) => void) => {
      const listener =
        event === ANDROID_APP_BACK_EVENT
          ? await bindings.onBackButtonPress((payload) => handler({ payload: payload as Value }))
          : await bindings.addPluginListener<Value>('noveldesk-android-shell', event, (payload) =>
              handler({ payload }),
            );
      return () => {
        void listener.unregister();
      };
    },
  };
}

async function loadDefaultTauriEvents(): Promise<TauriAppEventSource> {
  const [{ onBackButtonPress }, { addPluginListener }] = await Promise.all([
    import('@tauri-apps/api/app'),
    import('@tauri-apps/api/core'),
  ]);
  return createAndroidTauriEventSource({ onBackButtonPress, addPluginListener });
}

export function bindAndroidAppEvents(input: BindAndroidAppEventsInput): AndroidAppEventBinding {
  if (input.runtime.kind !== 'tauri-mobile') {
    return { ready: Promise.resolve(), dispose: () => undefined };
  }

  const documentSource =
    input.documentSource ??
    (typeof document === 'undefined' ? undefined : (document as unknown as AndroidDocumentEventSource));
  const windowSource =
    input.windowSource ?? (typeof window === 'undefined' ? undefined : (window as unknown as AndroidWindowEventSource));
  let disposed = false;
  let lastPhase: AndroidAppLifecyclePhase | undefined =
    documentSource?.visibilityState === 'hidden' ? 'background' : 'foreground';
  const nativeDisposers: Array<() => void> = [];

  const publishLifecycle = (phase: AndroidAppLifecyclePhase) => {
    if (phase === lastPhase || disposed) return;
    lastPhase = phase;
    input.handlers.onLifecycle(phase);
  };
  const visibilityChanged = () =>
    publishLifecycle(documentSource?.visibilityState === 'hidden' ? 'background' : 'foreground');
  const pageHidden = () => publishLifecycle('background');
  const pageShown = () => publishLifecycle('foreground');

  documentSource?.addEventListener('visibilitychange', visibilityChanged);
  windowSource?.addEventListener('pagehide', pageHidden);
  windowSource?.addEventListener('pageshow', pageShown);

  const ready = (async () => {
    try {
      const source = await (input.loadTauriEvents ?? loadDefaultTauriEvents)();
      const backDisposer = await source.listen(ANDROID_APP_BACK_EVENT, () => {
        if (!disposed) input.handlers.onBack();
      });
      if (disposed) backDisposer();
      else nativeDisposers.push(backDisposer);

      const lifecycleDisposer = await source.listen(ANDROID_APP_LIFECYCLE_EVENT, (event) => {
        const phase = lifecyclePhase(event.payload);
        if (phase) publishLifecycle(phase);
      });
      if (disposed) lifecycleDisposer();
      else nativeDisposers.push(lifecycleDisposer);
    } catch (error) {
      if (!disposed) input.handlers.onError?.(error);
    }
  })();

  return {
    ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      documentSource?.removeEventListener('visibilitychange', visibilityChanged);
      windowSource?.removeEventListener('pagehide', pageHidden);
      windowSource?.removeEventListener('pageshow', pageShown);
      nativeDisposers.splice(0).forEach((dispose) => dispose());
    },
  };
}
