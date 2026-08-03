import { useCallback, useEffect, useRef } from 'react';
import type { ConnectedSyncController, RuntimeTaskContext } from '../../sync/connected-sync-controller';

export interface GuardedAppBootstrapSteps<Snapshot> {
  load(context: RuntimeTaskContext): Promise<Snapshot>;
  commit(snapshot: Snapshot): void;
  afterCommit?(snapshot: Snapshot, context: RuntimeTaskContext): Promise<void>;
}

export async function runGuardedAppBootstrap<Snapshot>(
  context: RuntimeTaskContext,
  steps: GuardedAppBootstrapSteps<Snapshot>,
): Promise<void> {
  const snapshot = await steps.load(context);
  if (!context.isCurrent()) return;
  steps.commit(snapshot);
  if (!context.isCurrent()) return;
  await steps.afterCommit?.(snapshot, context);
}

export function useAppBootstrap(
  controller: ConnectedSyncController,
  run: (context: RuntimeTaskContext) => Promise<void>,
): () => void {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    void controller.startBootstrap((context) => runRef.current(context));
  }, [controller]);

  return useCallback(() => {
    void controller.runRuntimeTask('app-bootstrap-retry', {
      load: async (context) => runRef.current(context),
    });
  }, [controller]);
}
