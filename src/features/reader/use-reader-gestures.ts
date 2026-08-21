import { useCallback, useRef, type PointerEvent } from 'react';
import type { GestureBindings } from '../../domain/types';
import {
  dispatchReaderAction,
  gestureAction,
  gestureTargetIsInteractive,
  type ReaderActionHandlers,
} from './reader-action-dispatcher';

export function useReaderGestureHandlers(input: {
  readonly bindings: GestureBindings;
  readonly viewportWidth: () => number;
  readonly actions: ReaderActionHandlers;
  readonly onVerticalScrollIntent?: (deltaY: number) => void;
}) {
  const startRef = useRef<{ x: number; y: number; at: number; ignored: boolean }>();

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    startRef.current = {
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      ignored: gestureTargetIsInteractive(event.target) || Boolean(window.getSelection()?.toString()),
    };
  }, []);

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      startRef.current = undefined;
      if (!start || start.ignored || gestureTargetIsInteractive(event.target) || window.getSelection()?.toString())
        return;
      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      if (
        input.onVerticalScrollIntent &&
        Math.abs(deltaY) >= 18 &&
        Math.abs(deltaY) > Math.abs(deltaX) * 1.2 &&
        performance.now() - start.at <= 1_000
      ) {
        input.onVerticalScrollIntent(-deltaY);
        return;
      }
      const action = gestureAction({
        bindings: input.bindings,
        viewportWidth: input.viewportWidth(),
        startX: start.x,
        startY: start.y,
        endX: event.clientX,
        endY: event.clientY,
        durationMs: performance.now() - start.at,
      });
      if (action) dispatchReaderAction(action, input.actions);
    },
    [input],
  );

  return { onPointerDown, onPointerUp };
}
