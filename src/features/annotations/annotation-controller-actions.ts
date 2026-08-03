import type { Dispatch, SetStateAction } from 'react';
import type { Bookmark, ReaderHighlight, ReaderNote } from '../../domain/types';
import { buildAnnotationsMarkdown, copyAnnotationMarkdown, downloadAnnotationMarkdown } from './annotation-export';
import { navigateToAnnotation, type AnnotationNavigationTarget } from './annotation-navigation';
import type { AnnotationControllerOptions, AnnotationScope } from './annotation-contract';
import type { AnnotationViewModel } from './annotation-model';
import { AnnotationPersistence } from './annotation-persistence';

interface AnnotationActionInput extends AnnotationControllerOptions {
  readonly persistence: AnnotationPersistence;
  readonly bookmarks: readonly Bookmark[];
  readonly highlights: readonly ReaderHighlight[];
  readonly notes: readonly ReaderNote[];
  readonly noteDraft: string;
  readonly editingNoteId?: string;
  readonly scope: AnnotationScope;
  readonly query: string;
  readonly view: AnnotationViewModel;
  readonly setBookmarks: Dispatch<SetStateAction<Bookmark[]>>;
  readonly setHighlights: Dispatch<SetStateAction<ReaderHighlight[]>>;
  readonly setNotes: Dispatch<SetStateAction<ReaderNote[]>>;
  readonly resetEditor: () => void;
  readonly editNote: (note: ReaderNote) => void;
  readonly isNovelCurrent: (novelId: string) => boolean;
}

async function reportPersistenceFailure(
  input: AnnotationActionInput,
  error: unknown,
  fallbackMessage: string,
): Promise<void> {
  try {
    if (await input.onPersistenceError(error)) return;
  } catch {
    // The feature fallback below remains safe even when the host error handler fails.
  }
  input.notify(fallbackMessage, 'danger');
}

export function createAnnotationActions(input: AnnotationActionInput) {
  const mutationContext = () =>
    input.novel && input.chapter
      ? {
          novel: input.novel,
          chapter: input.chapter,
          reader: input.reader,
          readerProgress: input.readerProgress,
        }
      : undefined;
  const committed = async () => {
    try {
      await input.onMutationCommitted();
    } catch {
      input.notify('변경 내용은 저장했지만 동기화 상태를 갱신하지 못했습니다.', 'warning');
    }
  };
  const navigate = (target: AnnotationNavigationTarget) => {
    if (!input.novel) return Promise.resolve(false);
    return navigateToAnnotation({
      target,
      novelId: input.novel.id,
      currentChapterId: input.chapter?.id,
      chapters: input.chapters,
      repository: input.repository,
      reader: input.reader,
      openChapter: input.openChapter,
    });
  };
  const remove = async <Item>(
    failureMessage: string,
    load: (novelId: string) => Promise<Item[]>,
    commit: Dispatch<SetStateAction<Item[]>>,
  ) => {
    const novelId = input.novel?.id;
    if (!novelId) return;
    try {
      const items = await load(novelId);
      if (input.isNovelCurrent(novelId)) commit(items);
      await committed();
    } catch (error) {
      await reportPersistenceFailure(input, error, failureMessage);
    }
  };

  return {
    async toggleBookmark(location = input.reader.getLocation()) {
      const context = mutationContext();
      if (!context) return;
      try {
        const result = await input.persistence.toggleBookmark({ ...context, bookmarks: input.bookmarks }, location);
        if (!result) return;
        if (input.isNovelCurrent(context.novel.id)) input.setBookmarks(result.bookmarks);
        await committed();
        input.notify(
          result.status === 'created' ? '북마크를 추가했습니다.' : '북마크를 삭제했습니다.',
          result.status === 'created' ? 'success' : 'info',
        );
      } catch (error) {
        await reportPersistenceFailure(input, error, '북마크를 저장하지 못했습니다.');
      }
    },
    async saveNoteDraft() {
      const context = mutationContext();
      if (!context) return;
      try {
        const result = await input.persistence.saveNote(
          { ...context, notes: input.notes },
          input.noteDraft,
          input.editingNoteId,
        );
        if (!result) {
          if (input.editingNoteId) input.resetEditor();
          return;
        }
        if (input.isNovelCurrent(context.novel.id)) input.setNotes(result.notes);
        input.resetEditor();
        if (result.status === 'created') input.reader.clearSelection();
        await committed();
        input.notify(result.status === 'created' ? '메모를 저장했습니다.' : '메모를 수정했습니다.', 'success');
      } catch (error) {
        await reportPersistenceFailure(input, error, '메모를 저장하지 못했습니다.');
      }
    },
    async setHighlight(
      color: ReaderHighlight['color'],
      location = input.reader.getLocation(),
      selection = input.reader.getSelection(),
    ) {
      const context = mutationContext();
      if (!context) return;
      try {
        const result = await input.persistence.setHighlight(
          { ...context, highlights: input.highlights },
          color,
          location,
          selection,
        );
        if (!result) return;
        if (input.isNovelCurrent(context.novel.id)) input.setHighlights(result.highlights);
        input.reader.clearSelection();
        await committed();
        const messages = {
          created: '하이라이트를 저장했습니다.',
          updated: '하이라이트 색상을 바꿨습니다.',
          deleted: '하이라이트를 삭제했습니다.',
        } as const;
        input.notify(messages[result.status], result.status === 'deleted' ? 'info' : 'success');
      } catch (error) {
        await reportPersistenceFailure(input, error, '하이라이트를 저장하지 못했습니다.');
      }
    },
    deleteBookmark: (id: string) =>
      remove(
        '북마크를 삭제하지 못했습니다.',
        (novelId) => {
          const bookmark = input.bookmarks.find((item) => item.id === id);
          return bookmark ? input.persistence.deleteBookmark(novelId, bookmark) : Promise.resolve([...input.bookmarks]);
        },
        input.setBookmarks,
      ),
    deleteHighlight: (id: string) =>
      remove(
        '하이라이트를 삭제하지 못했습니다.',
        (novelId) => {
          const highlight = input.highlights.find((item) => item.id === id);
          return highlight
            ? input.persistence.deleteHighlight(novelId, highlight)
            : Promise.resolve([...input.highlights]);
        },
        input.setHighlights,
      ),
    deleteNote: async (id: string) => {
      if (input.editingNoteId === id) input.resetEditor();
      await remove(
        '메모를 삭제하지 못했습니다.',
        (novelId) => {
          const note = input.notes.find((item) => item.id === id);
          return note ? input.persistence.deleteNote(novelId, note) : Promise.resolve([...input.notes]);
        },
        input.setNotes,
      );
    },
    goToBookmark: (bookmark: Bookmark) => navigate({ kind: 'bookmark', item: bookmark }),
    goToHighlight: (highlight: ReaderHighlight) => navigate({ kind: 'highlight', item: highlight }),
    goToNote: (note: ReaderNote) => navigate({ kind: 'note', item: note }),
    async copyMarkdown() {
      if (!input.novel || input.view.filteredCount === 0) {
        input.notify('내보낼 주석이 없습니다.', 'warning');
        return;
      }
      const markdown = buildAnnotationsMarkdown({
        novel: input.novel,
        currentChapterTitle: input.chapter?.title,
        scope: input.scope,
        query: input.query,
        view: input.view,
        exportedAt: new Date().toISOString(),
      });
      try {
        await copyAnnotationMarkdown(markdown);
        input.notify('현재 주석 목록을 Markdown으로 복사했습니다.', 'success');
      } catch {
        input.notify('클립보드에 복사하지 못했습니다.', 'warning');
      }
    },
    downloadMarkdown() {
      if (!input.novel || input.view.filteredCount === 0) {
        input.notify('내보낼 주석이 없습니다.', 'warning');
        return;
      }
      downloadAnnotationMarkdown(
        buildAnnotationsMarkdown({
          novel: input.novel,
          currentChapterTitle: input.chapter?.title,
          scope: input.scope,
          query: input.query,
          view: input.view,
          exportedAt: new Date().toISOString(),
        }),
        input.novel.title,
      );
      input.notify('현재 주석 목록을 Markdown 파일로 저장했습니다.', 'success');
    },
  };
}
