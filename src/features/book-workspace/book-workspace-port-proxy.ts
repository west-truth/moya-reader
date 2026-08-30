import type {
  BookWorkspaceAdjacentFeaturePort,
  BookWorkspaceEnvironmentPort,
  BookWorkspacePorts,
  BookWorkspaceRepositoryPort,
  BookWorkspaceTransitionPort,
} from './book-workspace-contract';

export interface BookWorkspacePortRef<Port> {
  readonly current: Port;
}

export function createBookWorkspacePortProxy(input: {
  readonly repository: BookWorkspaceRepositoryPort;
  readonly catalog?: BookWorkspacePorts['catalog'];
  readonly transition: BookWorkspacePortRef<BookWorkspaceTransitionPort>;
  readonly adjacent: BookWorkspacePortRef<BookWorkspaceAdjacentFeaturePort>;
  readonly environment: BookWorkspaceEnvironmentPort;
}): BookWorkspacePorts {
  return {
    repository: input.repository,
    catalog: input.catalog,
    transition: {
      flushReaderSession: () => input.transition.current.flushReaderSession(),
      resetAnalysis: () => input.transition.current.resetAnalysis(),
      stopChapterTTS: () => input.transition.current.stopChapterTTS(),
      stopReaderTTS: () => input.transition.current.stopReaderTTS(),
      activateChapter: (chapterId) => input.transition.current.activateChapter(chapterId),
      prepareReaderOpen: (chapterId, options) => input.transition.current.prepareReaderOpen(chapterId, options),
    },
    adjacent: {
      loadBookAnnotations: (novelId) => input.adjacent.current.loadBookAnnotations(novelId),
      applyBookAnnotations: (annotations) => input.adjacent.current.applyBookAnnotations(annotations),
      loadReaderArtifacts: (chapterId, novelId) => input.adjacent.current.loadReaderArtifacts(chapterId, novelId),
      applyReaderArtifacts: (artifacts) => input.adjacent.current.applyReaderArtifacts(artifacts),
      resetCorrection: () => input.adjacent.current.resetCorrection(),
      resetAnnotationEditor: () => input.adjacent.current.resetAnnotationEditor(),
      refreshNovels: () => input.adjacent.current.refreshNovels(),
      refreshAfterLocalMutation: (kind) => input.adjacent.current.refreshAfterLocalMutation(kind),
      refreshSyncState: () => input.adjacent.current.refreshSyncState(),
      refreshAfterLocationConflict: () => input.adjacent.current.refreshAfterLocationConflict(),
    },
    environment: input.environment,
  };
}
