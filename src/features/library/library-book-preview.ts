import type { PointerEventHandler } from 'react';
import type { Novel } from '../../domain/types';
import type { LibraryScreenActions, LibraryScreenModel } from './library-screen-contract';

export function libraryBookPreviewHandlers(
  novel: Novel,
  model: LibraryScreenModel,
  actions: LibraryScreenActions['presentation'],
): { onPointerEnter: PointerEventHandler<HTMLElement>; onPointerLeave: PointerEventHandler<HTMLElement> } {
  const enabled = model.presentation.layoutMode === 'wide' && !model.management.selectionMode;
  return {
    onPointerEnter: (event) => {
      if (event.pointerType === 'mouse' && enabled) actions.previewBook(novel);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === 'mouse' && enabled) actions.closeInspectorSoon();
    },
  };
}
