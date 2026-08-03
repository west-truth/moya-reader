import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ConnectedSyncController, type ConnectedSyncSelection } from './connected-sync-controller';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useConnectedSyncController<Book, Chapter>(
  runtimeKey: object,
  selection: ConnectedSyncSelection<Book, Chapter>,
): ConnectedSyncController<Book, Chapter> {
  const activeControllerRef = useRef<ConnectedSyncController<Book, Chapter>>();
  const latestSelectionRef = useRef(selection);
  latestSelectionRef.current = selection;
  const controller = useMemo(() => {
    void runtimeKey;
    const createdController: ConnectedSyncController<Book, Chapter> = new ConnectedSyncController(
      latestSelectionRef.current,
      (): boolean => activeControllerRef.current === createdController,
    );
    return createdController;
  }, [runtimeKey]);

  useBrowserLayoutEffect(() => {
    activeControllerRef.current = controller;
    controller.retain();
    return () => {
      if (activeControllerRef.current === controller) activeControllerRef.current = undefined;
      controller.release();
    };
  }, [controller]);

  useBrowserLayoutEffect(() => {
    controller.updateSelection(selection);
  }, [controller, selection]);

  return controller;
}
