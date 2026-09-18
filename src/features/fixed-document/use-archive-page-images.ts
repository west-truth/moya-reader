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
  const legacyAssetIdentityRef = useRef(new Map<string, string>());
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
  const planRef = useRef({ currentPage, wanted: [] as number[], chapters, sourceRevision });
  planRef.current = {
    currentPage,
    wanted: wantedKey.split(',').filter(Boolean).map(Number),
    chapters,
    sourceRevision,
  };
  const validatedSessionRef = useRef(sessionKey);
  const resolvedIdentity = useCallback((index: number, planChapters: readonly Chapter[], revision: string) => {
    const chapter = planChapters[index];
    if (!chapter || chapter.documentSectionSourceContentHash) return pageIdentity(chapter, revision);
    const assetId = legacyAssetIdentityRef.current.get(chapter.id);
    return assetId
      ? `${chapter.id}:asset:${assetId}`
      : (snapshotRef.current.pages.get(index)?.identity ?? pageIdentity(chapter, revision));
  }, []);

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
        if (chapter && !chapter.documentSectionSourceContentHash && paragraph?.assetId) {
          legacyAssetIdentityRef.current.set(chapter.id, paragraph.assetId);
        }
        return {
          blob: resource.blob,
          ...(chapter && !chapter.documentSectionSourceContentHash && paragraph?.assetId
            ? { identity: `${chapter.id}:asset:${paragraph.assetId}` }
            : {}),
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
    const wanted = wantedKey.split(',').filter(Boolean).map(Number);
    // Keep scrolling on the loader's bounded queue. Waiting for every neighbour's
    // metadata here turns rapid page changes into an abort-and-retry storm.
    loaderRef.current?.update(currentPage, wanted, (index) => resolvedIdentity(index, chapters, sourceRevision));
  }, [chapters, currentPage, enabled, resolvedIdentity, sessionKey, sourceRevision, wantedKey]);

  useEffect(() => {
    const previousSession = validatedSessionRef.current;
    validatedSessionRef.current = sessionKey;
    if (!enabled || previousSession === sessionKey) return;
    const controller = new AbortController();
    const loadedLegacyPages = [...snapshotRef.current.pages.keys()].filter((index) => {
      const chapter = chapters[index];
      return chapter && !chapter.documentSectionSourceContentHash;
    });
    if (!loadedLegacyPages.length) return;
    // A source revision changes only when content is appended or replaced. Validate
    // retained legacy images then, without putting the normal scroll path on hold.
    void Promise.all(
      loadedLegacyPages.map(async (index) => {
        const chapter = chapters[index]!;
        const page = await loadMetadata(chapter.id, sessionKey, controller.signal);
        controller.signal.throwIfAborted();
        return { chapterId: chapter.id, assetId: page?.paragraphs[0]?.assetId };
      }),
    )
      .then((identities) => {
        if (controller.signal.aborted) return;
        for (const identity of identities) {
          if (identity.assetId) legacyAssetIdentityRef.current.set(identity.chapterId, identity.assetId);
          else legacyAssetIdentityRef.current.delete(identity.chapterId);
        }
        const plan = planRef.current;
        loaderRef.current?.update(plan.currentPage, plan.wanted, (index) =>
          resolvedIdentity(index, plan.chapters, plan.sourceRevision),
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [chapters, enabled, loadMetadata, resolvedIdentity, sessionKey]);

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
