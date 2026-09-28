import { useCallback, useRef } from 'react';
import { externalItemKeyId } from '../../external-sources/contracts';
import type { Novel } from '../../domain/types';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './useExternalSourceController';

export type StreamReadingPosition =
  | { kind: 'image'; page: number; count: number }
  | { kind: 'text'; paragraphIndex: number; offset: number; textHash: string; count: number };

/** Reading belongs to the episode even before its background download creates a book. */
export function useSourceStreamProgress(options: {
  current(): UseExternalSourceControllerOptions;
  isRead?(item: ExternalSourceItemView): boolean;
  onRead(preference: SourceReleasePreference): void;
  onSaved(novel: Novel): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const queue = useRef(Promise.resolve());
  const unreadWrites = useRef(new Map<string, { item: ExternalSourceItemView; readAt: string }>());
  const markRead = useCallback(async (key: string) => {
    const entry = unreadWrites.current.get(key);
    if (!entry) return;
    const { recordStreamReleaseRead } = await import('./source-stream-library');
    const preference = await recordStreamReleaseRead(latest.current.current(), entry.item, entry.readAt);
    if (preference) latest.current.onRead(preference);
    if (unreadWrites.current.get(key) === entry) unreadWrites.current.delete(key);
  }, []);
  const positions = useRef(new Map<string, { item: ExternalSourceItemView; position: StreamReadingPosition }>());
  const enqueue = useCallback((work: () => Promise<void>) => {
    const pending = queue.current.then(work);
    queue.current = pending.catch(() => latest.current.current().notify('읽던 위치를 저장하지 못했습니다.', 'warning'));
    return queue.current;
  }, []);
  const persist = useCallback(async (entry: { item: ExternalSourceItemView; position: StreamReadingPosition }) => {
    const current = latest.current.current();
    const { saveImageStreamPosition, saveTextStreamPosition } = await import('./source-stream-library');
    const novel =
      entry.position.kind === 'image'
        ? await saveImageStreamPosition(current, entry.item, entry.position.page, entry.position.count)
        : await saveTextStreamPosition(current, entry.item, entry.position);
    if (novel) latest.current.onSaved(novel);
    return Boolean(novel);
  }, []);
  const record = useCallback(
    (item: ExternalSourceItemView, position: StreamReadingPosition) => {
      if (
        !Number.isSafeInteger(position.count) ||
        position.count <= 0 ||
        (position.kind === 'image'
          ? !Number.isSafeInteger(position.page) || position.page < 0 || position.page >= position.count
          : !Number.isSafeInteger(position.paragraphIndex) ||
            position.paragraphIndex < 1 ||
            position.paragraphIndex > position.count)
      )
        return Promise.resolve();
      const workKey = externalItemKeyId({ ...item.key, remoteId: item.collection?.remoteId ?? item.key.remoteId });
      const itemKey = externalItemKeyId(item.key);
      if (!latest.current.isRead?.(item)) unreadWrites.current.set(itemKey, { item, readAt: new Date().toISOString() });
      const entry = { item, position };
      positions.current.set(workKey, entry);
      return enqueue(async () => {
        await markRead(itemKey);
        // A queued write for a previous episode must not move the work's resume position backwards.
        if (
          positions.current.get(workKey) === entry &&
          (await persist(entry)) &&
          positions.current.get(workKey) === entry
        )
          positions.current.delete(workKey);
      });
    },
    [enqueue, markRead, persist],
  );
  const reconcile = useCallback(
    () =>
      enqueue(async () => {
        for (const key of unreadWrites.current.keys()) await markRead(key);
        for (const [key, entry] of positions.current) {
          if (positions.current.get(key) === entry && (await persist(entry)) && positions.current.get(key) === entry)
            positions.current.delete(key);
        }
      }),
    [enqueue, markRead, persist],
  );
  return { record, reconcile };
}
