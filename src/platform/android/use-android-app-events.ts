import { useEffect, useRef } from 'react';
import type { PlatformRuntimeInfo } from '../runtime';
import { bindAndroidAppEvents, type AndroidAppEventHandlers } from './app-events';

export function useAndroidAppEvents(runtime: PlatformRuntimeInfo, handlers: AndroidAppEventHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const binding = bindAndroidAppEvents({
      runtime,
      handlers: {
        onBack: () => handlersRef.current.onBack(),
        onLifecycle: (phase) => handlersRef.current.onLifecycle(phase),
        onError: (error) => handlersRef.current.onError?.(error),
      },
    });
    return binding.dispose;
  }, [runtime]);
}
