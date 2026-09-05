import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Chapter, Novel, Paragraph } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { clamp } from '../../utils/format';
import type { ReaderLocationSnapshot } from './reader-screen-contract';
import {
  DebouncedProgressPersistence,
  RafProgressPublisher,
  type SerializedProgressPersistence,
} from './reader-progress-controller';

const LOCATION_PERSIST_DEBOUNCE_MS = 350;

function bookProgress(novel: Pick<Novel, 'totalChapters'>, chapter: Chapter, chapterProgress: number): number {
  const totalChapters = Math.max(novel.totalChapters, 1);
  return clamp((chapter.index - 1 + chapterProgress) / totalChapters, 0, 1);
}

export interface ReaderProgressOptions {
  readonly isActive?: boolean;
  readonly positionPersistence?: SerializedProgressPersistence;
  readonly rootRef: React.RefObject<HTMLDivElement>;
  readonly repository: ReaderRepository;
  readonly novel: Pick<Novel, 'id' | 'totalChapters' | 'activeContentRevisionId'>;
  readonly chapter: Chapter;
  readonly getVisibleParagraph: () => { index?: number; paragraph?: Paragraph };
  readonly onVisualLocation: (location: ReaderLocationSnapshot) => void;
  readonly onLocationCommitted: (location: ReaderLocationSnapshot, bookProgress: number, updatedAt: string) => void;
  readonly onPersistenceFailed: (error: unknown) => void;
}

export interface ReaderProgressController {
  readonly handleScroll: () => void;
  readonly readLocation: () => ReaderLocationSnapshot | undefined;
  readonly flush: () => Promise<void>;
}

interface PendingReaderPosition {
  readonly repository: ReaderRepository;
  readonly novel: Pick<Novel, 'id' | 'totalChapters' | 'activeContentRevisionId'>;
  readonly chapter: Chapter;
  readonly location: ReaderLocationSnapshot;
  readonly offsetInParagraph: number;
  readonly generation: number;
  readonly ownerEpoch: number;
  readonly updatedAt: string;
  readonly onLocationCommitted: ReaderProgressOptions['onLocationCommitted'];
  readonly onPersistenceFailed: ReaderProgressOptions['onPersistenceFailed'];
}

interface ReaderPositionPersistenceOptions extends Omit<
  ReaderProgressOptions,
  'rootRef' | 'getVisibleParagraph' | 'onVisualLocation'
> {
  readonly debounceMs?: number;
}

interface ReaderPositionPersistenceController {
  readonly schedule: (location: ReaderLocationSnapshot, offsetInParagraph?: number) => void;
  readonly flush: () => Promise<void>;
}

export function useReaderPositionPersistence(
  options: ReaderPositionPersistenceOptions,
): ReaderPositionPersistenceController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const generationRef = useRef(0);
  const ownerEpochRef = useRef(0);
  const persistenceRef = useRef<DebouncedProgressPersistence<PendingReaderPosition>>();
  if (!persistenceRef.current) {
    persistenceRef.current = new DebouncedProgressPersistence(
      {
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (handle) => window.clearTimeout(handle),
      },
      options.debounceMs ?? LOCATION_PERSIST_DEBOUNCE_MS,
      async (pending) => {
        if (optionsRef.current.isActive === false || pending.ownerEpoch !== ownerEpochRef.current) return;
        try {
          await pending.repository.saveReadingPosition({
            novelId: pending.novel.id,
            expectedContentRevisionId: pending.novel.activeContentRevisionId,
            chapterId: pending.chapter.id,
            documentSectionId: pending.chapter.documentSectionId,
            scrollTop: pending.location.scrollTop,
            chapterProgress: pending.location.progress,
            paragraphId: pending.location.paragraph?.id,
            paragraphIndex: pending.location.paragraphIndex,
            offsetInParagraph: pending.offsetInParagraph,
          });
          if (pending.generation !== generationRef.current) return;
          pending.onLocationCommitted(
            pending.location,
            bookProgress(pending.novel, pending.chapter, pending.location.progress),
            pending.updatedAt,
          );
        } catch (error) {
          if (pending.generation === generationRef.current) pending.onPersistenceFailed(error);
        }
      },
      options.positionPersistence,
    );
  }

  useLayoutEffect(() => {
    if (options.isActive !== false) return;
    // A hidden viewport may still resize, but it no longer owns the saved position.
    ownerEpochRef.current += 1;
    generationRef.current += 1;
    persistenceRef.current?.cancel();
  }, [options.isActive]);

  const schedule = useCallback((location: ReaderLocationSnapshot, offsetInParagraph = 0) => {
    const current = optionsRef.current;
    if (current.isActive === false) return;
    const generation = ++generationRef.current;
    persistenceRef.current!.schedule({
      repository: current.repository,
      novel: current.novel,
      chapter: current.chapter,
      location,
      offsetInParagraph,
      generation,
      ownerEpoch: ownerEpochRef.current,
      updatedAt: new Date().toISOString(),
      onLocationCommitted: current.onLocationCommitted,
      onPersistenceFailed: current.onPersistenceFailed,
    });
  }, []);

  const flush = useCallback(() => persistenceRef.current!.flush(), []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      void persistenceRef.current?.flush();
    },
    [options.chapter.id, options.novel.id],
  );

  return { schedule, flush };
}

export function useReaderProgress(options: ReaderProgressOptions): ReaderProgressController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { schedule: schedulePosition, flush } = useReaderPositionPersistence(options);
  const publisherRef = useRef<RafProgressPublisher<ReaderLocationSnapshot>>();
  if (!publisherRef.current) {
    publisherRef.current = new RafProgressPublisher(
      {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (handle) => window.cancelAnimationFrame(handle),
      },
      (location) => {
        if (optionsRef.current.isActive !== false) optionsRef.current.onVisualLocation(location);
      },
    );
  }

  const readLocation = useCallback((): ReaderLocationSnapshot | undefined => {
    const { rootRef, chapter, getVisibleParagraph } = optionsRef.current;
    const root = rootRef.current;
    if (!root) return undefined;
    const max = Math.max(root.scrollHeight - root.clientHeight, 1);
    const progress = clamp(root.scrollTop / max, 0, 1);
    const visible = getVisibleParagraph();
    const paragraphIndex = visible.paragraph?.index ?? (visible.index === undefined ? 0 : visible.index + 1);
    return {
      progress,
      scrollTop: root.scrollTop,
      paragraphIndex,
      paragraph: visible.paragraph,
      offsetInParagraph: 0,
      ttsIndex: clamp(
        visible.index ?? Math.floor(progress * Math.max(chapter.paragraphCount - 1, 0)),
        0,
        Math.max(chapter.paragraphCount - 1, 0),
      ),
    };
  }, []);

  const handleScroll = useCallback(() => {
    if (optionsRef.current.isActive === false) return;
    const location = readLocation();
    if (!location) return;
    publisherRef.current?.schedule(location);
    schedulePosition(location);
  }, [readLocation, schedulePosition]);

  useEffect(() => {
    return () => {
      publisherRef.current?.cancel();
    };
  }, [options.chapter.id, options.isActive, options.novel.id]);

  return { handleScroll, readLocation, flush };
}
