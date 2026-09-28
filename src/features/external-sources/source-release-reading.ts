import { externalItemKeyId, type ExternalItemSummary } from '../../external-sources/contracts';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import type { SerialReleaseReadingState } from './serial-work-projection';

export function latestSourceVisits(preferences: readonly SourceReleasePreference[]) {
  const visits = new Map<string, SourceReleasePreference>();
  for (const preference of preferences) {
    if (!preference.lastReadAt || !preference.collectionRemoteId) continue;
    const key = externalItemKeyId({ ...preference.source, remoteId: preference.collectionRemoteId });
    const previous = visits.get(key);
    if (!previous || preference.lastReadAt > previous.lastReadAt!) visits.set(key, preference);
  }
  return visits;
}

export function sourceReleaseReadingState(
  item: ExternalItemSummary,
  fallback: SerialReleaseReadingState | undefined,
  visits: ReadonlyMap<string, SourceReleasePreference>,
) {
  if (!item.release || !item.collection) return fallback;
  const visit = visits.get(externalItemKeyId({ ...item.key, remoteId: item.collection.remoteId }));
  if (!visit) return fallback;
  if (externalItemKeyId(visit.source) === externalItemKeyId(item.key)) {
    if (visit.read === false && (visit.readChangedAt ?? visit.updatedAt) >= visit.lastReadAt!) return 'unread';
    return 'current';
  }
  return fallback === 'current' ? 'read' : fallback;
}
