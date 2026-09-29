import type { DownloadSelectionRequest } from '../external-sources/use-download-selection-focus';
import { useEffect, useState } from 'react';
import type { Novel } from '../../domain/types';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { LibraryManagementController } from '../library/useLibraryManagementController';
import { LibraryWorkDialog, type LibraryWorkEdit } from '../library/LibraryWorkDialog';

export function useLibraryWorkActions(sources: ExternalSourceController, management: LibraryManagementController) {
  const [downloadRequest, setDownloadRequest] = useState<DownloadSelectionRequest>();
  const [edit, setEdit] = useState<LibraryWorkEdit>();
  useEffect(() => {
    if (!sources.open) return;
    return () => setDownloadRequest(undefined);
  }, [sources.open]);
  const externalEdit = (id: string, kind: LibraryWorkEdit['kind']) => {
    const work = sources.libraryWorks.find((work) => work.id === id && !work.deletedAt);
    if (!work || !sources.updateLibraryMetadata) return;
    setEdit({
      kind,
      title: work.title,
      shelfId: work.shelfIds?.[0],
      save: (value) =>
        sources.updateLibraryMetadata!(id, kind === 'title' ? { title: value } : { shelfIds: value ? [value] : [] }),
    });
  };
  return {
    downloadRequest,
    downloadExternal: async (id: string) => {
      const work = sources.libraryWorks.find((work) => work.id === id && !work.deletedAt);
      if (!work) return;
      setDownloadRequest((previous) => ({ workId: id, sequence: (previous?.sequence ?? 0) + 1 }));
      await sources.openSubscription(work);
    },
    dialog: edit ? (
      <LibraryWorkDialog edit={edit} shelves={management.shelves} close={() => setEdit(undefined)} />
    ) : null,
    renameExternal: (id: string) => externalEdit(id, 'title'),
    moveExternalToShelf: (id: string) => externalEdit(id, 'shelf'),
    rename: (novel: Novel) => {
      setEdit({
        kind: 'title',
        title: novel.title,
        save: async (value) => {
          if (!management.renameBook) throw new Error('제목 수정을 사용할 수 없습니다.');
          await management.renameBook(novel, value);
          for (const work of sources.libraryWorks)
            if (work.localBookId === novel.id && !work.deletedAt)
              await sources.updateLibraryMetadata?.(work.id, { title: value });
        },
      });
    },
    moveToShelf: (novel: Novel) => {
      const source = sources.libraryWorks.find((work) => work.localBookId === novel.id);
      setEdit({
        kind: 'shelf',
        title: novel.title,
        shelfId: management.memberships.find((item) => item.bookId === novel.id)?.shelfId ?? source?.shelfIds?.[0],
        save: async (id) => {
          if (!management.moveBookToShelf) throw new Error('책장 이동을 사용할 수 없습니다.');
          await management.moveBookToShelf(novel.id, id || undefined);
          for (const work of sources.libraryWorks)
            if (work.localBookId === novel.id && !work.deletedAt && work.shelfIds?.length)
              await sources.updateLibraryMetadata?.(work.id, { shelfIds: [] });
        },
      });
    },
  };
}
