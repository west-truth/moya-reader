import type { PointerEventHandler } from 'react';
import type { Novel } from '../../domain/types';
import type { LibraryScreenActions } from './library-screen-contract';

export function libraryBookPreviewHandlers(
  novel: Novel,
  enabled: boolean,
  actions: LibraryScreenActions['presentation'],
): { onPointerEnter: PointerEventHandler<HTMLElement>; onPointerLeave: PointerEventHandler<HTMLElement> } {
  return {
    onPointerEnter: (event) => {
      if (event.pointerType === 'mouse' && enabled) actions.previewBook(novel);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === 'mouse') actions.closeInspectorSoon();
    },
  };
}
