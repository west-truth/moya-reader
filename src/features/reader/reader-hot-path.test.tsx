import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LabeledSegment, Paragraph, ParagraphPage, ReadingSessionEvent } from '../../domain/types';
import { ParagraphPageCache } from './paragraph-page-cache';
import { ReaderDecorationStore } from './reader-decoration-store';
import { ReaderParagraphRow, segmentTypeLabel } from './ReaderParagraphRow';
import { EpubFootnoteSheet } from './EpubFootnoteSheet';
import {
  DebouncedProgressPersistence,
  RafProgressPublisher,
  SerializedProgressPersistence,
} from './reader-progress-controller';
import { ReaderScreenHandle } from './reader-screen-contract';
import { ParagraphPageCacheOwner } from './use-paragraph-pages';
import {
  bindReaderLifecycleFlush,
  flushReaderBoundary,
  type ReaderLifecycleEvents,
} from './use-reader-lifecycle-flush';
import { ReaderSessionTracker } from './use-reader-session';
import { StableDocumentShortcutBinding, type ShortcutEventTarget } from './use-stable-document-shortcuts';

function paragraph(index = 1): Paragraph {
  return {
    id: `paragraph-${index}`,
    novelId: 'novel-1',
    chapterId: 'chapter-1',
    index,
    text: '테스트 본문',
    startOffsetInChapter: 0,
    endOffsetInChapter: 6,
    textHash: `hash-${index}`,
  };
}

function page(value: Paragraph): ParagraphPage {
  return {
    id: 'page-0',
    novelId: value.novelId,
    chapterId: value.chapterId,
    pageIndex: 0,
    startParagraphIndex: 1,
    endParagraphIndex: 1,
    paragraphs: [value],
    textHash: 'page-hash',
  };
}

function segment(id: string, type: LabeledSegment['type']): LabeledSegment {
  return {
    id,
    novelId: 'novel-1',
    chapterId: 'chapter-1',
    paragraphId: 'paragraph-1',
    segmentIndex: Number(id.at(-1)) || 0,
    startOffset: 0,
    endOffset: 2,
    segmentTextHash: `${id}-hash`,
    type,
    speakerId: 'narrator',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.9,
    isUserCorrected: false,
  };
}

describe('reader hot-path ownership', () => {
  it('swaps chapter caches without notifying during acquire and ignores disposed stale loads', async () => {
    const owner = new ParagraphPageCacheOwner();
    let notifications = 0;
    let resolvePage: ((value: ParagraphPage) => void) | undefined;
    const oldCache = owner.acquire('chapter-1', () => {
      const created = new ParagraphPageCache(120, () => {
        if (owner.isActive(created)) notifications += 1;
      });
      return created;
    });
    const pending = oldCache.loadIndexes(
      'chapter-1',
      [0],
      () =>
        new Promise((resolve) => {
          resolvePage = (value) => resolve(value);
        }),
    );

    const newCache = owner.acquire('chapter-2', () => {
      const created = new ParagraphPageCache(120, () => {
        if (owner.isActive(created)) notifications += 1;
      });
      return created;
    });
    expect(notifications).toBe(0);
    owner.disposeStale();
    resolvePage?.(page(paragraph()));
    await pending;

    expect(oldCache.paragraphAt(0)).toBeUndefined();
    expect(newCache.paragraphAt(0)).toBeUndefined();
    expect(notifications).toBe(0);
    owner.dispose();
  });

  it('serializes location persistence writes in enqueue order', async () => {
    const persistence = new SerializedProgressPersistence();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = persistence.enqueue(async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first:end');
    });
    const second = persistence.enqueue(async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('forces the newest debounced location through an awaitable lifecycle flush', async () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const persisted: number[] = [];
    const persistence = new DebouncedProgressPersistence<number>(
      {
        set: (callback) => {
          const handle = ++nextTimer;
          timers.set(handle, callback);
          return handle;
        },
        clear: (handle) => timers.delete(handle),
      },
      350,
      async (value) => {
        persisted.push(value);
      },
    );

    persistence.schedule(0.2);
    persistence.schedule(0.8);
    expect(timers.size).toBe(1);

    await persistence.flush();
    expect(timers.size).toBe(0);
    expect(persisted).toEqual([0.8]);

    await persistence.flush();
    expect(persisted).toEqual([0.8]);
  });

  it('flushes reader state when hidden, page-hidden, and unmounted', async () => {
    let hidden = false;
    const visibilityListeners = new Set<() => void>();
    const pageHideListeners = new Set<() => void>();
    const events: ReaderLifecycleEvents = {
      isHidden: () => hidden,
      subscribeVisibilityChange: (listener) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
      subscribePageHide: (listener) => {
        pageHideListeners.add(listener);
        return () => pageHideListeners.delete(listener);
      },
    };
    const flush = vi.fn(async () => undefined);
    const dispose = bindReaderLifecycleFlush(events, flush);

    visibilityListeners.forEach((listener) => listener());
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();

    hidden = true;
    visibilityListeners.forEach((listener) => listener());
    pageHideListeners.forEach((listener) => listener());
    dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(flush).toHaveBeenCalledTimes(3);
    expect(visibilityListeners.size).toBe(0);
    expect(pageHideListeners.size).toBe(0);
  });

  it('attempts both position and session writes at one reader boundary', async () => {
    const position = vi.fn(async () => {
      throw new Error('position unavailable');
    });
    const session = vi.fn(async () => undefined);

    await expect(flushReaderBoundary(position, session)).resolves.toBeUndefined();
    expect(position).toHaveBeenCalledOnce();
    expect(session).toHaveBeenCalledOnce();
  });

  it('coalesces visual progress updates into one animation frame', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 0;
    const publish = vi.fn();
    const publisher = new RafProgressPublisher(
      {
        request: (callback) => {
          const handle = ++nextHandle;
          callbacks.set(handle, callback);
          return handle;
        },
        cancel: (handle) => callbacks.delete(handle),
      },
      publish,
    );
    publisher.schedule(0.1);
    publisher.schedule(0.4);
    publisher.schedule(0.8);
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.(16);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(0.8);
  });

  it('updates shortcut behavior without rebinding the document listener', () => {
    const listeners = new Set<(event: globalThis.KeyboardEvent) => void>();
    const target: ShortcutEventTarget = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const first = vi.fn();
    const second = vi.fn();
    const binding = new StableDocumentShortcutBinding(first);
    const detach = binding.attach(target);
    const listener = [...listeners][0];
    binding.update(second);
    expect([...listeners][0]).toBe(listener);
    listener({ key: 'b' } as globalThis.KeyboardEvent);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    detach();
    expect(listeners.size).toBe(0);
  });

  it('keeps elapsed time bound to the session that created it', async () => {
    let now = Date.parse('2026-07-10T00:00:00.000Z');
    const oldWrite = vi.fn(async () => undefined);
    const newWrite = vi.fn(async () => undefined);
    const oldSession = new ReaderSessionTracker(
      {
        repository: {
          capabilities: {
            backend: 'indexeddb',
            readingTimePersistence: 'persistent',
            syncStorage: 'local_outbox',
            remoteEventApply: true,
            parsedNovelImport: 'snapshot',
          },
          addNovelReadingTime: oldWrite,
        },
        novelId: 'old-book',
        chapterId: 'old-chapter',
        onCommitted: vi.fn(),
        onFailed: vi.fn(),
        onDisplayChanged: vi.fn(),
      },
      now,
      () => now,
    );
    now += 5_000;

    const newSession = new ReaderSessionTracker(
      {
        repository: {
          capabilities: {
            backend: 'indexeddb',
            readingTimePersistence: 'persistent',
            syncStorage: 'local_outbox',
            remoteEventApply: true,
            parsedNovelImport: 'snapshot',
          },
          addNovelReadingTime: newWrite,
        },
        novelId: 'new-book',
        chapterId: 'new-chapter',
        onCommitted: vi.fn(),
        onFailed: vi.fn(),
        onDisplayChanged: vi.fn(),
      },
      now,
      () => now,
    );
    await oldSession.flush();
    now += 3_000;
    await newSession.flush();

    expect(oldWrite).toHaveBeenCalledWith('old-book', 5, '2026-07-10T00:00:05.000Z');
    expect(newWrite).toHaveBeenCalledWith('new-book', 3, '2026-07-10T00:00:08.000Z');
  });

  it('does not report hosted session time as persisted when the backend is session-only', async () => {
    let now = Date.parse('2026-07-10T00:00:00.000Z');
    const write = vi.fn(async () => undefined);
    const committed = vi.fn();
    const session = new ReaderSessionTracker(
      {
        repository: {
          capabilities: {
            backend: 'hosted',
            readingTimePersistence: 'session_only',
            syncStorage: 'remote_backend',
            remoteEventApply: false,
            parsedNovelImport: 'upload_reparse',
          },
          addNovelReadingTime: write,
        },
        novelId: 'hosted-book',
        chapterId: 'hosted-chapter',
        onCommitted: committed,
        onFailed: vi.fn(),
        onDisplayChanged: vi.fn(),
      },
      now,
      () => now,
    );
    now += 5_000;

    await session.flush();

    expect(write).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });

  it('does not duplicate a raw session event when only the legacy aggregate fails', async () => {
    let now = Date.parse('2026-07-10T00:00:00.000Z');
    const appendReadingSession = vi.fn(async (_event: ReadingSessionEvent) => undefined);
    const session = new ReaderSessionTracker(
      {
        repository: {
          capabilities: {
            backend: 'indexeddb',
            readingTimePersistence: 'persistent',
            syncStorage: 'local_outbox',
            remoteEventApply: true,
            parsedNovelImport: 'snapshot',
          },
          addNovelReadingTime: vi.fn(async () => {
            throw new Error('aggregate unavailable');
          }),
        },
        personalizationRepository: { appendReadingSession } as never,
        novelId: 'book',
        chapterId: 'chapter',
        onCommitted: vi.fn(),
        onFailed: vi.fn(),
        onDisplayChanged: vi.fn(),
      },
      now,
      () => now,
    );
    now += 5_000;

    await session.flush();
    await session.flush();

    expect(appendReadingSession).toHaveBeenCalledOnce();
  });

  it('stops counting after five idle minutes and resumes on interaction', () => {
    let now = Date.parse('2026-07-10T00:00:00.000Z');
    const session = new ReaderSessionTracker(
      {
        repository: {
          capabilities: {
            backend: 'indexeddb',
            readingTimePersistence: 'persistent',
            syncStorage: 'local_outbox',
            remoteEventApply: true,
            parsedNovelImport: 'snapshot',
          },
          addNovelReadingTime: vi.fn(async () => undefined),
        },
        novelId: 'book',
        chapterId: 'chapter',
        onCommitted: vi.fn(),
        onFailed: vi.fn(),
        onDisplayChanged: vi.fn(),
      },
      now,
      () => now,
    );
    now += 10 * 60_000;
    session.checkIdle();
    expect(session.elapsedSeconds()).toBe(300);
    session.interact();
    now += 2_000;
    expect(session.elapsedSeconds()).toBe(302);
  });

  it('keeps route-aware paragraph and mode targets in one reader open request', () => {
    const handle = new ReaderScreenHandle();
    const first = handle.prepareOpen('chapter-2', {
      targetParagraphId: 'paragraph-220',
      initialMode: 'correction',
      preserveSearch: true,
    });

    expect(handle.peekOpen('chapter-2')).toEqual(first);
    expect(first).toMatchObject({
      targetParagraphId: 'paragraph-220',
      initialMode: 'correction',
      preserveSearch: true,
    });
    handle.acknowledgeOpen(first.sequence);
    expect(handle.peekOpen('chapter-2')).toBeUndefined();

    const second = handle.prepareOpen('chapter-2');
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });
});

describe('ReaderParagraphRow segment labels', () => {
  it('maps current SegmentType dialogue and monologue families', () => {
    expect(segmentTypeLabel({ type: 'quoted_dialogue' })).toBe('대사');
    expect(segmentTypeLabel({ type: 'plain_dialogue' })).toBe('대사');
    expect(segmentTypeLabel({ type: 'inner_monologue' })).toBe('독백');
    expect(segmentTypeLabel({ type: 'narration' })).toBe('서술');
    expect(segmentTypeLabel({ type: 'sfx' })).toBe('효과음');
    expect(segmentTypeLabel({ type: 'system_message' })).toBe('기타');
  });

  it('renders dialogue and monologue labels in analysis metadata', () => {
    const decorations = new ReaderDecorationStore();
    decorations.update({
      segments: [
        segment('segment-1', 'quoted_dialogue'),
        segment('segment-2', 'plain_dialogue'),
        segment('segment-3', 'inner_monologue'),
      ],
      characters: [],
      highlights: [],
      reviewSegmentIds: new Set(),
    });
    const html = renderToStaticMarkup(
      <ReaderParagraphRow
        paragraph={paragraph()}
        virtualIndex={0}
        start={0}
        isSpeaking={false}
        mode="analysis"
        searchQuery=""
        decorationStore={decorations}
        measureElement={() => undefined}
        onSelectCorrectionSegment={() => undefined}
      />,
    );

    expect(html.match(/대사/g)).toHaveLength(2);
    expect(html).toContain('독백');
  });
});

describe('EPUB footnote sheet', () => {
  it('keeps the footnote text in a compact dialog with an explicit document jump', () => {
    const html = renderToStaticMarkup(
      <EpubFootnoteSheet
        paragraphs={[{ ...paragraph(), id: 'note-1', text: '각주 본문' }]}
        onClose={() => undefined}
        onOpenInDocument={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('각주 본문');
    expect(html).toContain('본문에서 보기');
  });
});
