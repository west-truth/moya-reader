import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chapter, Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import {
  localSectionReadTimes,
  projectSourceWorkProgress,
  type LocalSectionReadTimes,
  type SourceWorkProgressProjection,
} from './source-work-progress';

function readStamp(novel: Novel): string {
  return [
    novel.updatedAt,
    novel.lastReadAt ?? '',
    novel.activeContentRevisionId ?? '',
    novel.metadataRevision ?? '',
  ].join('|');
}

/**
 * Library-wide progress for works added from a source. Releases read in a downloaded book before
 * reads were recorded per release only live on its chapters, so those books are scanned in the
 * background, one at a time, and rescanned only when the book itself changes.
 */
export function useSourceWorkProgress(input: {
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
  readonly links: readonly ExternalSourceLink[];
  readonly preferences: readonly SourceReleasePreference[];
  readonly novels: readonly Novel[];
  listChapters(novelId: string): Promise<Chapter[]>;
}): SourceWorkProgressProjection {
  const { subscriptions, links, preferences, novels } = input;
  const listChapters = useRef(input.listChapters);
  listChapters.current = input.listChapters;
  const cache = useRef(new Map<string, { stamp: string; sections: LocalSectionReadTimes }>());
  const [localSections, setLocalSections] = useState<ReadonlyMap<string, LocalSectionReadTimes>>(new Map());

  const targets = useMemo(() => {
    const linkedBookIds = new Set(
      links
        .filter(
          (link) =>
            !link.pendingImport &&
            subscriptions.some(
              (subscription) =>
                link.source.connectorId === subscription.connectorId &&
                (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
                link.collectionRemoteId === subscription.collectionRemoteId,
            ),
        )
        .map((link) => link.localBookId),
    );
    return novels
      .filter((novel) => linkedBookIds.has(novel.id) && !novel.deletedAt)
      .map((novel) => ({ id: novel.id, stamp: readStamp(novel) }));
  }, [links, novels, subscriptions]);
  // A stable string so unrelated novel list updates do not restart an in-flight scan.
  const targetKey = JSON.stringify(targets);

  useEffect(() => {
    let active = true;
    const current = JSON.parse(targetKey) as { id: string; stamp: string }[];
    const wanted = new Set(current.map((target) => target.id));
    let pruned = false;
    for (const id of [...cache.current.keys()]) {
      if (wanted.has(id)) continue;
      cache.current.delete(id);
      pruned = true;
    }
    const publish = () => {
      if (active) setLocalSections(new Map([...cache.current].map(([id, entry]) => [id, entry.sections])));
    };
    if (pruned) publish();
    const stale = current.filter((target) => cache.current.get(target.id)?.stamp !== target.stamp);
    if (stale.length === 0) return;
    void (async () => {
      for (const target of stale) {
        try {
          const chapters = await listChapters.current(target.id);
          if (!active) return;
          cache.current.set(target.id, { stamp: target.stamp, sections: localSectionReadTimes(chapters) });
          publish();
        } catch {
          // Without its chapters a book still counts releases read in the source hub.
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [targetKey]);

  return useMemo(
    () => projectSourceWorkProgress({ subscriptions, links, preferences, novels, localSections }),
    [links, localSections, novels, preferences, subscriptions],
  );
}
