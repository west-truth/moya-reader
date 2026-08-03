import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { BookWorkspacePorts, BookWorkspaceState } from './book-workspace-contract';
import { BookWorkspaceController } from './book-workspace-controller';

export interface BookWorkspaceControllerBinding {
  readonly controller: BookWorkspaceController;
  readonly state: BookWorkspaceState;
}

export function useBookWorkspaceController(ports: BookWorkspacePorts): BookWorkspaceControllerBinding {
  const controllerRef = useRef<BookWorkspaceController>();
  if (!controllerRef.current) controllerRef.current = new BookWorkspaceController(ports);
  const controller = controllerRef.current;
  useLayoutEffect(() => controller.updatePorts(ports), [controller, ports]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { controller, state };
}
