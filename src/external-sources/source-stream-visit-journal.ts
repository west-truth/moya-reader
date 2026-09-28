import { externalItemKeyId, type ExternalItemKey } from './contracts';
import type { ExternalSourceLocalState } from './local-state';
import { releasePreferenceId, type SourceReleasePreference } from './source-user-state';

const storageKey = 'moya.source-stream-pending-visits.v1';
type PendingVisit = { scope: string; preference: SourceReleasePreference };
function entries(): PendingVisit[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is PendingVisit => {
        const p = entry?.preference;
        return (
          typeof entry?.scope === 'string' &&
          p?.kind === 'releasePreference' &&
          p.read === true &&
          p.readingMode === 'stream' &&
          typeof p.source?.connectorId === 'string' &&
          typeof p.source.remoteId === 'string' &&
          (p.source.accountConnectionId === undefined || typeof p.source.accountConnectionId === 'string') &&
          typeof p.collectionRemoteId === 'string' &&
          typeof p.lastReadAt === 'string' &&
          Number.isFinite(Date.parse(p.lastReadAt)) &&
          p.readChangedAt === p.lastReadAt &&
          p.updatedAt === p.lastReadAt &&
          p.id === releasePreferenceId(p.source)
        );
      })
      .slice(-200);
  } catch {
    return [];
  }
}
function write(value: PendingVisit[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value.slice(-200)));
  } catch {
    /* The normal repository still handles saves when browser storage is unavailable. */
  }
}

/** Checkpoint the visited episode synchronously, before any IndexedDB/network queue can yield. */
export function stageSourceStreamVisit(
  scope: string | undefined,
  source: ExternalItemKey,
  collectionRemoteId: string,
  readAt: string,
): void {
  const id = releasePreferenceId(source);
  const preference: SourceReleasePreference = {
    id,
    kind: 'releasePreference',
    source,
    collectionRemoteId,
    readingMode: 'stream',
    read: true,
    readChangedAt: readAt,
    lastReadAt: readAt,
    updatedAt: readAt,
  };
  write([
    ...entries().filter((entry) => entry.scope !== (scope ?? 'local') || entry.preference.id !== id),
    { scope: scope ?? 'local', preference },
  ]);
}

export function acknowledgeSourceStreamVisit(scope: string | undefined, source: ExternalItemKey, readAt: string): void {
  write(
    entries().filter(
      (entry) =>
        entry.scope !== (scope ?? 'local') ||
        externalItemKeyId(entry.preference.source) !== externalItemKeyId(source) ||
        entry.preference.lastReadAt !== readAt,
    ),
  );
}

/** Recover interrupted writes on reload; newer manual unread choices and later visits remain authoritative. */
export async function recoverSourceStreamVisits(
  scope: string | undefined,
  state: Pick<ExternalSourceLocalState, 'listReleasePreferences' | 'saveReleasePreferences'>,
): Promise<SourceReleasePreference[]> {
  const preferences = new Map(((await state.listReleasePreferences?.()) ?? []).map((p) => [p.id, p]));
  for (const { preference: pending } of entries().filter((entry) => entry.scope === (scope ?? 'local'))) {
    const current = preferences.get(pending.id);
    const superseded =
      current &&
      ((current.readChangedAt ?? '') >= pending.lastReadAt! || (current.lastReadAt ?? '') >= pending.lastReadAt!);
    const next = superseded ? current : { ...current, ...pending };
    preferences.set(next.id, next);
    try {
      if (!superseded) {
        if (!state.saveReleasePreferences) continue;
        await state.saveReleasePreferences([next]);
      }
      acknowledgeSourceStreamVisit(scope, pending.source, pending.lastReadAt!);
    } catch {
      /* Keep the device checkpoint and use it until the repository becomes writable. */
    }
  }
  return [...preferences.values()];
}
