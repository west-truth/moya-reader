import { type DragEventHandler, useCallback, useRef, useState } from 'react';
import type { ToastTone } from '../../shared/ui/ToastHost';

export interface ImportDropActions {
  enter: DragEventHandler<HTMLElement>;
  over: DragEventHandler<HTMLElement>;
  leave: DragEventHandler<HTMLElement>;
  drop: DragEventHandler<HTMLElement>;
  dropOnEmptyState: DragEventHandler<HTMLDivElement>;
}

export interface ImportDropTarget {
  active: boolean;
  actions: ImportDropActions;
}

interface ImportDropTargetOptions {
  busy: boolean;
  selectFiles(files: readonly File[]): void;
  importFiles(files: readonly File[]): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
}

function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files');
}

export function useImportDropTarget(options: ImportDropTargetOptions): ImportDropTarget {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [active, setActive] = useState(false);
  const depthRef = useRef(0);

  const reset = useCallback(() => {
    depthRef.current = 0;
    setActive(false);
  }, []);

  const enter = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!isFileDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    depthRef.current += 1;
    setActive(true);
  }, []);

  const over = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!isFileDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = optionsRef.current.busy ? 'none' : 'copy';
    setActive(true);
  }, []);

  const leave = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!isFileDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setActive(false);
  }, []);

  const drop = useCallback<DragEventHandler<HTMLElement>>(
    (event) => {
      if (!isFileDrag(Array.from(event.dataTransfer.types))) return;
      event.preventDefault();
      reset();
      if (optionsRef.current.busy) {
        optionsRef.current.notify('가져오기가 진행 중입니다.', 'warning');
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void optionsRef.current.importFiles(files);
    },
    [reset],
  );

  const dropOnEmptyState = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      reset();
      const files = Array.from(event.dataTransfer.files);
      if (files.length) optionsRef.current.selectFiles(files);
    },
    [reset],
  );

  return { active, actions: { enter, over, leave, drop, dropOnEmptyState } };
}
