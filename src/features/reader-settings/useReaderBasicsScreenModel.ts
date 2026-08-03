import { useMemo } from 'react';
import type { Chapter, Novel } from '../../domain/types';
import type { ReadingPosition } from '../../sync/types';
import type { AnnotationsController } from '../annotations';
import type { ReaderAddonTab, ReaderScreenModel } from '../reader/reader-screen-contract';
import type { ReaderSettingsController } from './useReaderSettingsDraft';

interface ReaderBasicsScreenModelOptions {
  readonly novel?: Novel;
  readonly chapter?: Chapter;
  readonly chapters: readonly Chapter[];
  readonly settingsController: ReaderSettingsController;
  readonly annotationsController: AnnotationsController;
  readonly localReadingPosition?: ReadingPosition;
  readonly addonOpen: boolean;
  readonly addonTab: ReaderAddonTab;
  readonly overlays: { readonly syncPanelOpen: boolean; readonly importOpen: boolean };
  readonly ttsIndex?: number;
  readonly openRequestVersion: number;
  readonly effectiveSettings?: ReaderScreenModel['settings'];
}

export function useReaderBasicsScreenModel(options: ReaderBasicsScreenModelOptions): ReaderScreenModel | undefined {
  const { bookmarks, highlights } = options.annotationsController;
  const settings = options.effectiveSettings ?? options.settingsController.settings;
  const settingsOpen = options.settingsController.open;
  const novelId = options.novel?.id;
  const novelTitle = options.novel?.title;
  const novelTotalChapters = options.novel?.totalChapters;
  const novelLastReadChapterId = options.novel?.lastReadChapterId;
  const novelContentRevisionId = options.novel?.activeContentRevisionId;
  const novelFormat = options.novel?.format;
  const syncPanelOpen = options.overlays.syncPanelOpen;
  const importOpen = options.overlays.importOpen;

  return useMemo(() => {
    if (!novelId || !novelTitle || novelTotalChapters === undefined || !options.chapter) return undefined;
    return {
      novel: {
        id: novelId,
        title: novelTitle,
        totalChapters: novelTotalChapters,
        lastReadChapterId: novelLastReadChapterId,
        activeContentRevisionId: novelContentRevisionId,
        format: novelFormat,
      },
      chapter: options.chapter,
      chapters: options.chapters,
      settings,
      bookmarks,
      highlights,
      localReadingPosition: options.localReadingPosition,
      addonOpen: options.addonOpen,
      addonTab: options.addonTab,
      overlays: { settingsOpen, syncPanelOpen, importOpen },
      ttsIndex: options.ttsIndex,
      canRestoreSavedPosition: Boolean(options.localReadingPosition || novelLastReadChapterId),
      statsVisible: options.addonOpen && options.addonTab === 'stats',
      openRequestVersion: options.openRequestVersion,
    };
  }, [
    bookmarks,
    highlights,
    importOpen,
    novelId,
    novelLastReadChapterId,
    novelContentRevisionId,
    novelFormat,
    novelTitle,
    novelTotalChapters,
    options.addonOpen,
    options.addonTab,
    options.chapter,
    options.chapters,
    options.localReadingPosition,
    options.openRequestVersion,
    options.ttsIndex,
    settings,
    settingsOpen,
    syncPanelOpen,
  ]);
}
