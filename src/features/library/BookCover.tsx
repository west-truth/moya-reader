import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Novel } from '../../domain/types';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';

interface CachedCover {
  readonly key: string;
  readonly url: string;
  usedAt: number;
}

const cache = new Map<string, CachedCover>();
const pending = new Map<string, Promise<string | undefined>>();
const MAX_CACHED_COVERS = 48;

function pruneCoverCache(): void {
  if (cache.size <= MAX_CACHED_COVERS) return;
  const oldest = [...cache.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt);
  for (const [bookId, entry] of oldest.slice(0, cache.size - MAX_CACHED_COVERS)) {
    URL.revokeObjectURL(entry.url);
    cache.delete(bookId);
  }
}

export interface BookCoverProps {
  readonly novel: Novel;
  readonly className: string;
  readonly children?: ReactNode;
}

const formatLabels: Record<NonNullable<Novel['format']>, string> = {
  txt: 'TEXT',
  markdown: 'MARKDOWN',
  epub: 'EPUB',
  pdf: 'PDF',
  image_archive: 'COMIC',
};

function FallbackCover({ novel }: { readonly novel: Novel }) {
  return (
    <span className="book-cover-fallback" aria-hidden="true">
      <span className="book-cover-format">{novel.format ? formatLabels[novel.format] : 'MOYA'}</span>
      <strong>{novel.title}</strong>
      <small>{novel.author || 'MOYA LIBRARY'}</small>
    </span>
  );
}

function ResolvedCoverImage({ novel }: { readonly novel: Novel }) {
  const runtime = useOptionalAppRuntime();
  const repository = runtime?.readerRuntime.bookAssetRepository;
  const key = `${novel.coverAssetId ?? ''}:${novel.coverContentHash ?? ''}`;
  const [url, setUrl] = useState(() => {
    const current = cache.get(novel.id);
    return current?.key === key ? current.url : undefined;
  });

  useEffect(() => {
    let active = true;
    if (!novel.coverAssetId || !repository) {
      setUrl(undefined);
      return () => {
        active = false;
      };
    }
    const current = cache.get(novel.id);
    if (current?.key === key) {
      current.usedAt = Date.now();
      setUrl(current.url);
      return () => {
        active = false;
      };
    }
    if (current) {
      URL.revokeObjectURL(current.url);
      cache.delete(novel.id);
    }
    const requestKey = `${novel.id}:${key}`;
    let request = pending.get(requestKey);
    if (!request) {
      request = repository
        .getActiveCover(novel.id)
        .then((cover) => {
          if (!cover) return undefined;
          const nextUrl = URL.createObjectURL(cover.blob);
          cache.set(novel.id, { key, url: nextUrl, usedAt: Date.now() });
          pruneCoverCache();
          return nextUrl;
        })
        .catch(() => undefined);
      pending.set(requestKey, request);
      void request.finally(() => pending.delete(requestKey));
    }
    void request.then((nextUrl) => {
      if (active) setUrl(nextUrl);
    });
    return () => {
      active = false;
    };
  }, [key, novel.coverAssetId, novel.id, repository]);

  return url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      style={{
        objectFit: novel.coverFit === 'contain' ? 'contain' : 'cover',
        objectPosition: `${novel.coverPositionX ?? 50}% ${novel.coverPositionY ?? 50}%`,
      }}
    />
  ) : (
    <FallbackCover novel={novel} />
  );
}

export function BookCover({ novel, className, children }: BookCoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(() => typeof globalThis.IntersectionObserver === 'undefined');

  useEffect(() => {
    if (shouldLoad || !novel.coverAssetId) return;
    const root = rootRef.current;
    if (!root || typeof globalThis.IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [novel.coverAssetId, shouldLoad]);

  return (
    <div ref={rootRef} className={className}>
      {novel.coverAssetId && shouldLoad ? <ResolvedCoverImage novel={novel} /> : <FallbackCover novel={novel} />}
      {children}
    </div>
  );
}
