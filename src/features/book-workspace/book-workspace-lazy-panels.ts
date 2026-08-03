import { lazy } from 'react';

export const BookWorkspaceInfoPanel = lazy(() =>
  import('./BookWorkspaceReaderPanels').then((module) => ({ default: module.BookWorkspaceInfoPanel })),
);

export const BookWorkspaceStatsPanel = lazy(() =>
  import('./BookWorkspaceReaderPanels').then((module) => ({ default: module.BookWorkspaceStatsPanel })),
);
