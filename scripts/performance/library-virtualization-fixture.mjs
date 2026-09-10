import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryScreen } from '../../src/features/library/LibraryScreen.tsx';
import { buildLibraryCollectionModel } from '../../src/features/library/library-screen-model.ts';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/shell.css';
import '../../src/styles/library.css';
import '../../src/styles/dialogs-import.css';

const novels = Array.from({ length: 1000 }, (_, index) => ({
  id: `synthetic-${index}`,
  title: `Synthetic novel ${String(index).padStart(4, '0')}`,
  sourceFileName: 'synthetic.txt',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  totalChapters: 200,
  totalCharacters: 1200000,
  totalParagraphs: 20000,
  coverSeed: index,
  lastReadOffset: 0,
  lastReadProgress: 0,
  favorite: false,
  analysisStatus: 'not_analyzed',
}));
const noop = () => {};
const noActions = new Proxy({}, { get: () => noop });
function Fixture() {
  const [state, setState] = useState({ query: '', viewMode: 'grid', selectionMode: false });
  const update = (patch) => setState((previous) => ({ ...previous, ...patch }));
  globalThis.libraryFixture = { update };
  globalThis.libraryBatchActions ??= [];
  globalThis.libraryNavigationActions ??= [];
  const collection = buildLibraryCollectionModel({
    novels,
    query: state.query,
    filter: 'all',
    sort: 'title',
    readState: { hasReadActivity: () => false, isFinished: () => false },
  });
  const model = {
    bootstrap: { status: 'ready' },
    drop: { active: false, importBusy: false },
    query: state.query,
    sync: { label: 'local', tone: 'local' },
    externalSources: {
      active: false,
      busy: false,
      sources: [
        { id: 'fixture.text', title: 'Text source', kind: 'catalog' },
        { id: 'fixture.comic', title: 'Comic source', kind: 'catalog' },
      ],
    },
    importTasks: [],
    filter: 'all',
    sort: 'title',
    viewMode: state.viewMode,
    collection,
    presentation: { layoutMode: 'wide', inspectorOpen: false, shelfBookCounts: new Map() },
    management: {
      available: true,
      shelves: [{ id: 'shelf-1', name: 'Test shelf' }],
      selectionMode: state.selectionMode,
      selectedBookIds: new Set(state.selectionMode ? (state.selectedBookIds ?? novels.map((novel) => novel.id)) : []),
      busy: false,
    },
  };
  const actions = {
    drag: noActions,
    header: {
      ...noActions,
      setQuery: (query) => setState((previous) => ({ ...previous, query })),
      openExternalSource: (id) => globalThis.libraryNavigationActions.push(id),
    },
    presentation: noActions,
    controls: {
      setFilter: (filter) => globalThis.libraryNavigationActions.push(filter),
      setShelf: (id) => globalThis.libraryNavigationActions.push(id),
      clearSelection: () => update({ selectionMode: false, selectedBookIds: undefined }),
      applyBatch: (action) => globalThis.libraryBatchActions.push(action),
      exportSelectedMetadata: () => globalThis.libraryBatchActions.push({ kind: 'export_metadata' }),
    },
    books: {
      toggleSelected: (novel) => {
        const selected = new Set(model.management.selectedBookIds);
        if (!selected.delete(novel.id)) selected.add(novel.id);
        update({ selectedBookIds: [...selected] });
      },
    },
    imports: noActions,
  };
  return React.createElement(LibraryScreen, { model, actions });
}
createRoot(globalThis.document.getElementById('root')).render(React.createElement(Fixture));
