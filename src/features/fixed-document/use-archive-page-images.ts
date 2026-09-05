import { useEffect, useRef, useState } from 'react';
import type { Chapter } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { ArchivePageLoader, type ArchivePageSnapshot } from './archive-page-loader';

const EMPTY_SNAPSHOT: ArchivePageSnapshot = { pages: new Map(), errors: new Map() };

function pageIdentity(chapter: Chapter | undefined, sourceRevision: string): string {
  return `${chapter?.id ?? 'missing'}:${chapter?.documentSectionSourceContentHash ?? sourceRevision}`;
}

export function useArchivePageImages(input: {
  readonly enabled: boolean;
  readonly bookId: string;
  readonly sourceRevision: string;
  readonly chapters: readonly Chapter[];
  readonly currentPage: number;
  readonly wantedPages: ReadonlySet<number>;
  readonly repository: ReaderRepository;
  readonly assets: BookAssetRepository;
}): ArchivePageSnapshot {
  const { enabled, bookId, sourceRevision, chapters, currentPage, wantedPages, repository, assets } = input;
  const sessionKey = `${bookId}:${sourceRevision}`;
  const [state, setState] = useState({ bookId, sessionKey, snapshot: EMPTY_SNAPSHOT });
  const loaderRef = useRef<ArchivePageLoader>();
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const sessionKeyRef = useRef(sessionKey);
  const wantedKey = [...wantedPages].join(',');

  useEffect(() => {
    setState({ bookId, sessionKey: sessionKeyRef.current, snapshot: EMPTY_SNAPSHOT });
    if (!enabled) return;
    const loader = new ArchivePageLoader(
      async (index, signal) => {
        const chapter = chaptersRef.current[index];
        const paragraphPage = chapter ? await repository.getParagraphPage(chapter.id, 0, signal) : undefined;
        signal.throwIfAborted();
        const paragraph = paragraphPage?.paragraphs[0];
        const resource = paragraph?.assetId
          ? await assets.getEmbeddedResource(bookId, paragraph.assetId, signal)
          : undefined;
        signal.throwIfAborted();
        if (!resource) throw new Error(`${index + 1}페이지 이미지를 찾을 수 없습니다.`);
        return {
          blob: resource.blob,
          ...(paragraph?.documentPageType !== undefined || paragraph?.documentPageDouble !== undefined
            ? { hint: { type: paragraph.documentPageType, doublePage: paragraph.documentPageDouble } }
            : {}),
        };
      },
      (snapshot) => setState({ bookId, sessionKey: sessionKeyRef.current, snapshot }),
    );
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = undefined;
    };
  }, [assets, bookId, enabled, repository]);

  useEffect(() => {
    sessionKeyRef.current = sessionKey;
    if (enabled && chapters.length > 0) {
      loaderRef.current?.update(currentPage, wantedKey.split(',').filter(Boolean).map(Number), (index) =>
        pageIdentity(chaptersRef.current[index], sourceRevision),
      );
    }
  }, [assets, chapters.length, currentPage, enabled, repository, sessionKey, sourceRevision, wantedKey]);

  if (!enabled || state.bookId !== bookId) return EMPTY_SNAPSHOT;
  if (state.sessionKey === sessionKey) return state.snapshot;
  // Preserve unchanged image elements during the render before the new plan is
  // published. Replaced pages must disappear immediately, even before effects.
  const pages = new Map(
    [...state.snapshot.pages].filter(
      ([index, page]) => page.identity === pageIdentity(chapters[index], sourceRevision),
    ),
  );
  return pages.size === state.snapshot.pages.size && state.snapshot.errors.size === 0
    ? state.snapshot
    : { pages, errors: EMPTY_SNAPSHOT.errors };
}
