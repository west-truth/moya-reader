import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bookmark, ReaderHighlight, ReaderNote } from '../../domain/types';
import { createAnnotationActions } from './annotation-controller-actions';
import type { AnnotationControllerOptions, AnnotationScope, AnnotationSort } from './annotation-contract';
import { buildAnnotationView } from './annotation-model';
import { AnnotationPersistence } from './annotation-persistence';

export function useAnnotationsController(options: AnnotationControllerOptions) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<AnnotationScope>('all');
  const [sort, setSort] = useState<AnnotationSort>('recent');
  const [noteDraft, setNoteDraft] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string>();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const resetEditor = useCallback(() => {
    setNoteDraft('');
    setEditingNoteId(undefined);
  }, []);
  const editNote = useCallback((note: ReaderNote) => {
    setEditingNoteId(note.id);
    setNoteDraft(note.body);
  }, []);

  useEffect(() => {
    setQuery('');
    setScope('all');
    setSort('recent');
    resetEditor();
  }, [options.novel?.id, resetEditor]);

  useEffect(() => resetEditor(), [options.chapter?.id, resetEditor]);

  const view = useMemo(
    () =>
      buildAnnotationView({
        collections: { bookmarks, highlights, notes },
        chapters: options.chapters,
        currentChapterId: options.chapter?.id,
        activeParagraphId: options.activeParagraphId,
        progress: options.readerProgress,
        query,
        scope,
        sort,
      }),
    [
      bookmarks,
      highlights,
      notes,
      options.activeParagraphId,
      options.chapter?.id,
      options.chapters,
      options.readerProgress,
      query,
      scope,
      sort,
    ],
  );
  const persistence = useMemo(() => new AnnotationPersistence(options.repository), [options.repository]);
  const actions = createAnnotationActions({
    ...options,
    persistence,
    bookmarks,
    highlights,
    notes,
    noteDraft,
    editingNoteId,
    scope,
    query,
    view,
    setBookmarks,
    setHighlights,
    setNotes,
    resetEditor,
    editNote,
    isNovelCurrent: (novelId) => optionsRef.current.novel?.id === novelId,
  });

  return {
    bookmarks,
    highlights,
    notes,
    setBookmarks,
    setHighlights,
    setNotes,
    query,
    setQuery,
    scope,
    setScope,
    sort,
    setSort,
    noteDraft,
    setNoteDraft,
    editingNoteId,
    editNote,
    resetEditor,
    view,
    ...actions,
  };
}

export type AnnotationsController = ReturnType<typeof useAnnotationsController>;
