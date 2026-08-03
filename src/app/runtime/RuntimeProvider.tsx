import { createContext, type ReactNode, useContext } from 'react';
import type { AppRuntime } from './app-runtime';

const RuntimeContext = createContext<AppRuntime | undefined>(undefined);

interface RuntimeProviderProps {
  readonly runtime: AppRuntime;
  readonly children: ReactNode;
}

export function RuntimeProvider({ runtime, children }: RuntimeProviderProps) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error('useAppRuntime must be used within RuntimeProvider.');
  }
  return runtime;
}

export function useOptionalAppRuntime(): AppRuntime | undefined {
  return useContext(RuntimeContext);
}
