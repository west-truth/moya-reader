import type { Chapter, Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { releasePreferenceId, type SourceReleasePreference } from '../../external-sources/source-user-state';
import { externalDocumentReleaseSourceId } from '../../external-sources/series/document-series-identity';

/** Read releases out of everything the source currently lists for a work in the library. */
export interface SourceWorkProgress {
  readonly readCount: number;
  readonly totalCount: number;
  readonly progress: number;
  /** Latest actual visit (streamed or downloaded) to any release of the work. */
  readonly lastReadAt?: string;
}

/** Latest local "section finished" time per document section of one downloaded book. */
export type LocalSectionReadTimes = ReadonlyMap<string, string>;

export interface SourceWorkProgressProjection {
  readonly byNovelId: ReadonlyMap<string, SourceWorkProgress>;
  readonly bySubscriptionId: ReadonlyMap<string, SourceWorkProgress>;
}

export function localSectionReadTimes(chapters: readonly Chapter[]): LocalSectionReadTimes {
  const times = new Map<string, string>();
  for (const chapter of chapters) {
    if (!chapter.documentSectionId || !chapter.documentSectionReadAt) continue;
    const previous = times.get(chapter.documentSectionId);
    if (!previous || chapter.documentSectionReadAt > previous) {
      times.set(chapter.documentSectionId, chapter.documentSectionReadAt);
    }
  }
  return times;
}

function sameWork(link: ExternalSourceLink, subscription: ExternalSourceSubscriptionRecord): boolean {
  return (
    !link.pendingImport &&
    link.source.connectorId === subscription.connectorId &&
    (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
    link.collectionRemoteId === subscription.collectionRemoteId
  );
}

/**
 * Mirrors the source hub's per-release read state: an explicit read/unread choice wins when it is
 * at least as new as the local "section finished" time, otherwise the downloaded book decides.
 * Opening a release (streamed or downloaded) records it as read, so the count follows reading.
 */
export function projectSourceWorkProgress(input: {
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
  readonly links: readonly ExternalSourceLink[];
  readonly preferences: readonly SourceReleasePreference[];
  readonly novels: readonly Pick<Novel, 'id' | 'deletedAt'>[];
  readonly localSections: ReadonlyMap<string, LocalSectionReadTimes>;
}): SourceWorkProgressProjection {
  const preferenceById = new Map(input.preferences.map((preference) => [preference.id, preference]));
  const liveNovelIds = new Set(input.novels.filter((novel) => !novel.deletedAt).map((novel) => novel.id));
  const byNovelId = new Map<string, SourceWorkProgress>();
  const bySubscriptionId = new Map<string, SourceWorkProgress>();

  for (const subscription of input.subscriptions) {
    const totalCount = subscription.availableReleaseCount;
    if (!Number.isSafeInteger(totalCount) || totalCount <= 0) continue;
    const links = input.links.filter((link) => sameWork(link, subscription) && liveNovelIds.has(link.localBookId));
    const linkedBookIds = [...new Set(links.map((link) => link.localBookId))];
    const downloaded = new Set(links.map((link) => link.source.remoteId));
    let readCount = 0;
    let lastReadAt: string | undefined;
    for (const remoteId of new Set(subscription.knownReleaseIds)) {
      const key = {
        connectorId: subscription.connectorId,
        remoteId,
        ...(subscription.accountConnectionId !== undefined
          ? { accountConnectionId: subscription.accountConnectionId }
          : {}),
      };
      let localReadAt: string | undefined;
      if (downloaded.has(remoteId)) {
        // Comic releases are sectioned by remote id; text document series by a derived release id.
        const sectionIds = [remoteId, externalDocumentReleaseSourceId(key, subscription.collectionRemoteId)];
        for (const bookId of linkedBookIds) {
          const sections = input.localSections.get(bookId);
          for (const sectionId of sectionIds) {
            const readAt = sections?.get(sectionId);
            if (readAt && (!localReadAt || readAt > localReadAt)) localReadAt = readAt;
          }
        }
      }
      const preference = preferenceById.get(releasePreferenceId(key));
      if (preference?.lastReadAt && (!lastReadAt || preference.lastReadAt > lastReadAt)) {
        lastReadAt = preference.lastReadAt;
      }
      const explicit =
        preference?.read !== undefined &&
        (!localReadAt || (preference.readChangedAt ?? preference.updatedAt) >= localReadAt);
      if (explicit ? preference!.read : Boolean(localReadAt)) readCount += 1;
    }
    const progress: SourceWorkProgress = {
      readCount: Math.min(readCount, totalCount),
      totalCount,
      progress: Math.min(1, readCount / totalCount),
      ...(lastReadAt ? { lastReadAt } : {}),
    };
    bySubscriptionId.set(subscription.id, progress);
    linkedBookIds.forEach((bookId) => {
      const existing = byNovelId.get(bookId);
      if (!existing || progress.totalCount > existing.totalCount) byNovelId.set(bookId, progress);
    });
  }
  return { byNovelId, bySubscriptionId };
}
