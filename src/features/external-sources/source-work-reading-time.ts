import { useEffect } from 'react';
import { stableId } from '../../domain/hash';
import { externalItemKeyId, type ExternalItemKey } from '../../external-sources/contracts';
import { IndexedDbReaderPersonalizationRepository } from '../../repositories/indexeddb-reader-personalization-repository';
import { ReaderSessionTracker } from '../reader/use-reader-session';

const sessions = new IndexedDbReaderPersonalizationRepository();
const pending = new Map<string, Promise<void>>();
export function sourceWorkSessionId(scope: string | undefined, work: ExternalItemKey): string {
  return stableId('source_sessions', JSON.stringify([scope ?? 'local', externalItemKeyId(work)]));
}
export async function sourceWorkReadingSeconds(id: string): Promise<number> {
  await pending.get(id);
  return (await sessions.listReadingSessions({ bookId: id })).reduce((sum, event) => sum + event.activeSeconds, 0);
}
export async function clearSourceWorkReadingTime(id: string): Promise<void> {
  await pending.get(id);
  await sessions.deleteReadingSessions({ bookId: id });
}

/** Stream-only works have no server book row. Keep their timed sessions scoped to this device/account. */
export function useSourceWorkReadingTime(id: string | undefined, active: boolean): void {
  useEffect(() => {
    if (!id || !active) return;
    const tracker = new ReaderSessionTracker(
      {
        novelId: id,
        repository: {
          capabilities: {
            backend: 'indexeddb',
            readingTimePersistence: 'session_only',
            syncStorage: 'local_outbox',
            remoteEventApply: false,
            parsedNovelImport: 'snapshot',
          },
        },
        personalizationRepository: sessions,
        onCommitted: () => undefined,
        onFailed: () => undefined,
        onDisplayChanged: () => undefined,
      },
      Date.now(),
    );
    const flush = () => {
      const work = tracker.flush();
      pending.set(id, work);
      void work.finally(() => {
        if (pending.get(id) === work) pending.delete(id);
      });
    };
    const environment = () => {
      tracker.setEnvironment(document.visibilityState !== 'hidden', document.hasFocus());
      flush();
    };
    const interact = () => tracker.interact();
    environment();
    const timer = window.setInterval(flush, 30_000);
    document.addEventListener('visibilitychange', environment);
    window.addEventListener('focus', environment);
    window.addEventListener('blur', environment);
    window.addEventListener('pagehide', environment);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      window.addEventListener(type, interact, { passive: true });
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', environment);
      window.removeEventListener('focus', environment);
      window.removeEventListener('blur', environment);
      window.removeEventListener('pagehide', environment);
      for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(type, interact);
      tracker.setEnvironment(false, false);
      flush();
    };
  }, [id, active]);
}
