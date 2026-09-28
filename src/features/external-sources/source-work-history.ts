import { externalItemKeyId, type ExternalItemKey } from '../../external-sources/contracts';
import type { ExternalSourceLocalState } from '../../external-sources/local-state';
import {
  recoverSourceStreamVisits,
  acknowledgeSourceStreamVisit,
} from '../../external-sources/source-stream-visit-journal';
import { clearSourceStreamPositions } from '../../external-sources/source-stream-history';
import { releasePreferenceId, type SourceReleasePreference } from '../../external-sources/source-user-state';
import { clearSourceWorkReadingTime, sourceWorkSessionId } from './source-work-reading-time';

export function belongsToSourceWork(
  source: ExternalItemKey,
  collectionRemoteId: string | undefined,
  work: ExternalItemKey,
): boolean {
  return (
    source.connectorId === work.connectorId &&
    (source.accountConnectionId ?? '') === (work.accountConnectionId ?? '') &&
    collectionRemoteId === work.remoteId
  );
}

/** Persist unread tombstones so delayed visits cannot resurrect a reset on reload. */
export async function clearSourceWorkHistory(input: {
  state: ExternalSourceLocalState;
  scope?: string;
  work: ExternalItemKey;
  releaseIds?: readonly string[];
}): Promise<void> {
  const { state, scope, work } = input;
  if (!state.saveReleasePreferences) throw new Error('이 소스의 읽은 기록을 저장할 수 없습니다.');
  const preferences = await recoverSourceStreamVisits(scope, state);
  const links = await state.listLinks(work.connectorId);
  const targets = new Map<string, SourceReleasePreference>();
  const previousById = new Map(preferences.map((p) => [p.id, p]));
  const knownPreferences = (input.releaseIds ?? []).flatMap((remoteId) => {
    const preference = previousById.get(releasePreferenceId({ ...work, remoteId }));
    return preference ? [preference.source] : [];
  });
  const keys = [
    ...knownPreferences,
    ...preferences.filter((p) => belongsToSourceWork(p.source, p.collectionRemoteId, work)).map((p) => p.source),
    ...links
      .filter((link) => !link.pendingImport && belongsToSourceWork(link.source, link.collectionRemoteId, work))
      .map((link) => link.source),
  ];
  const resetAt = new Date(
    keys
      .map((source) => previousById.get(releasePreferenceId(source)))
      .reduce(
        (latest, p) =>
          p !== undefined
            ? Math.max(latest, (Date.parse(p.readChangedAt ?? '') || 0) + 1, (Date.parse(p.lastReadAt ?? '') || 0) + 1)
            : latest,
        Date.now(),
      ),
  ).toISOString();
  for (const source of keys) {
    const id = releasePreferenceId(source);
    const previous = previousById.get(id);
    targets.set(id, {
      ...previous,
      id,
      kind: 'releasePreference',
      source,
      collectionRemoteId: work.remoteId,
      read: false,
      readChangedAt: resetAt,
      lastReadAt: undefined,
      readingMode: undefined,
      updatedAt: resetAt,
    });
  }
  await state.saveReleasePreferences([...targets.values()]);
  for (const p of preferences) {
    if (belongsToSourceWork(p.source, p.collectionRemoteId, work) && p.lastReadAt)
      acknowledgeSourceStreamVisit(scope, p.source, p.lastReadAt);
  }
  clearSourceStreamPositions([
    ...[...targets.values()].map((p) => JSON.stringify([scope, externalItemKeyId(p.source)])),
    ...(input.releaseIds ?? []).map((remoteId) => JSON.stringify([scope, externalItemKeyId({ ...work, remoteId })])),
  ]);
  await clearSourceWorkReadingTime(sourceWorkSessionId(scope, work));
}
