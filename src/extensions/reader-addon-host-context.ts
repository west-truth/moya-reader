import type { BookWorkspaceInfoPanelProps } from '../features/book-workspace/BookWorkspaceReaderPanels';
import type { ReactNode } from 'react';

export interface TrustedReaderAddonHostContext {
  readonly readerInfo: BookWorkspaceInfoPanelProps;
  readonly aiPanel?: ReactNode;
}
