import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { ArchivePageLoader, type ArchivePageSnapshot } from './archive-page-loader';
import { archivePageSourceIdentity } from './archive-thumbnail';

const EMPTY_SNAPSHOT: ArchivePageSnapshot = { pages: new Map(), errors: new Map() };

function pageIdentity(chapter: Chapter | undefined, sourceRevision: string): string {
  return `${chapter?.id ?? 'missing'}:${archivePageSourceIdentity(chapter, sourceRevision)}`;
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
  const metadataRef = useRef(new Map<string, NonNullable<Awaited<ReturnType<ReaderRepository['getParagraphPage']>>>>());
  const loadMetadata = useCallback(
    async (chapterId: string, revision: string, signal: AbortSignal) => {
      const key = `${revision}:${chapterId}`;
      const cached = metadataRef.current.get(key);
      if (cached) return cached;
      const page = await repository.getParagraphPage(chapterId, 0, signal);
      signal.throwIfAborted();
      if (page) metadataRef.current.set(key, page);
      while (metadataRef.current.size > 64) metadataRef.current.delete(metadataRef.current.keys().next().value!);
      return page;
    },
    [repository],
  );
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const sessionKeyRef = useRef(sessionKey);
  const snapshotRef = useRef(state.snapshot);
  const wantedKey = [...new Set([currentPage, ...wantedPages])].join(',');

  useEffect(() => {
    snapshotRef.current = EMPTY_SNAPSHOT;
    setState({ bookId, sessionKey: sessionKeyRef.current, snapshot: EMPTY_SNAPSHOT });
    if (!enabled) return;
    const loader = new ArchivePageLoader(
      async (index, signal) => {
        const chapter = chaptersRef.current[index];
        const paragraphPage = chapter ? await loadMetadata(chapter.id, sessionKeyRef.current, signal) : undefined;
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
      (snapshot) => {
        snapshotRef.current = snapshot;
        setState({ bookId, sessionKey: sessionKeyRef.current, snapshot });
      },
    );
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = undefined;
    };
  }, [assets, bookId, enabled, loadMetadata]);

  useEffect(() => {
    sessionKeyRef.current = sessionKey;
    if (!enabled || !chapters.length) return;
    const controller = new AbortController();
    const wanted = wantedKey.split(',').filter(Boolean).map(Number);
    const loader = loaderRef.current;
    const resolve = async () => {
      const identities = new Map<number, string>();
      // Legacy chapter hashes describe titles. Resolve immutable asset IDs before invalidating images on append.
      await Promise.all(
        wanted.map(async (index) => {
          const chapter = chapters[index];
          if (!chapter || chapter.documentSectionSourceContentHash) {
            identities.set(index, pageIdentity(chapter, sourceRevision));
            return;
          }
          const page = await loadMetadata(chapter.id, sessionKey, controller.signal);
          controller.signal.throwIfAborted();
          identities.set(
            index,
            page?.paragraphs[0]?.assetId
              ? `${chapter.id}:asset:${page.paragraphs[0].assetId}`
              : pageIdentity(chapter, sourceRevision),
          );
        }),
      );
      controller.signal.throwIfAborted();
      loader?.update(
        currentPage,
        wanted,
        (index) =>
          identities.get(index) ??
          (chapters[index]?.documentSectionSourceContentHash
            ? pageIdentity(chapters[index], sourceRevision)
            : (snapshotRef.current.pages.get(index)?.identity ?? pageIdentity(chapters[index], sourceRevision))),
      );
    };
    void resolve().catch(() => {
      if (controller.signal.aborted || snapshotRef.current.pages.has(currentPage)) return;
      setState({
        bookId,
        sessionKey,
        snapshot: {
          ...snapshotRef.current,
          errors: new Map([[currentPage, '이미지 정보를 불러오지 못했습니다. 다시 이동해 주세요.']]),
        },
      });
    });
    return () => controller.abort();
  }, [assets, bookId, chapters, currentPage, enabled, loadMetadata, sessionKey, sourceRevision, wantedKey]);

  if (!enabled || state.bookId !== bookId) return EMPTY_SNAPSHOT;
  if (state.sessionKey === sessionKey) return state.snapshot;
  // For legacy data, retain only the same page while its asset metadata is revalidated.
  // A changed immutable asset then invalidates the URL through the loader, without trusting title hashes.
  const pages = new Map(
    [...state.snapshot.pages].filter(([index, page]) => {
      const chapter = chapters[index];
      return chapter?.documentSectionSourceContentHash
        ? page.identity === pageIdentity(chapter, sourceRevision)
        : Boolean(chapter && page.identity.startsWith(`${chapter.id}:asset:`));
    }),
  );
  return pages.size === state.snapshot.pages.size && state.snapshot.errors.size === 0
    ? state.snapshot
    : { pages, errors: EMPTY_SNAPSHOT.errors };
}
