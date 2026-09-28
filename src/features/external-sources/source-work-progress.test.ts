import { describe, expect, it } from 'vitest';
import type { Chapter } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { externalDocumentReleaseSourceId } from '../../external-sources/series/document-series-identity';
import { releasePreferenceId, type SourceReleasePreference } from '../../external-sources/source-user-state';
import { localSectionReadTimes, projectSourceWorkProgress } from './source-work-progress';

const connectorId = 'moya.external.test';
const collectionRemoteId = 'work-1';

function subscription(overrides: Partial<ExternalSourceSubscriptionRecord> = {}): ExternalSourceSubscriptionRecord {
  return {
    id: 'subscription-1',
    connectorId,
    collectionRemoteId,
    navigationRef: collectionRemoteId,
    title: '작품',
    knownReleaseIds: ['r1', 'r2', 'r3', 'r4'],
    newReleaseIds: [],
    availableReleaseCount: 4,
    lastCheckedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

function preference(remoteId: string, read: boolean, at: string): SourceReleasePreference {
  const source = { connectorId, remoteId };
  return {
    id: releasePreferenceId(source),
    kind: 'releasePreference',
    source,
    read,
    readChangedAt: at,
    updatedAt: at,
  };
}

function link(remoteId: string, localBookId = 'book-1', extra: Partial<ExternalSourceLink> = {}): ExternalSourceLink {
  return {
    id: `link-${remoteId}`,
    source: { connectorId, remoteId },
    localBookId,
    collectionRemoteId,
    linkedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

const novels = [{ id: 'book-1' }];

describe('projectSourceWorkProgress', () => {
  it('counts read releases against every release the source lists', () => {
    const result = projectSourceWorkProgress({
      subscriptions: [subscription()],
      links: [link('r1')],
      preferences: [
        preference('r1', true, '2026-09-02T00:00:00.000Z'),
        preference('r3', true, '2026-09-02T00:00:00.000Z'),
      ],
      novels,
      localSections: new Map(),
    });

    expect(result.bySubscriptionId.get('subscription-1')).toEqual({ readCount: 2, totalCount: 4, progress: 0.5 });
    expect(result.byNovelId.get('book-1')).toEqual({ readCount: 2, totalCount: 4, progress: 0.5 });
  });

  it('keeps releases finished in a downloaded book before reads were recorded per release', () => {
    const textSection = externalDocumentReleaseSourceId({ connectorId, remoteId: 'r2' }, collectionRemoteId);
    const result = projectSourceWorkProgress({
      subscriptions: [subscription()],
      links: [link('r1'), link('r2')],
      preferences: [],
      novels,
      localSections: new Map([
        [
          'book-1',
          new Map([
            ['r1', '2026-09-02T00:00:00.000Z'],
            [textSection, '2026-09-02T00:00:00.000Z'],
            // Not downloaded from this work, so it must not count.
            ['r3', '2026-09-02T00:00:00.000Z'],
          ]),
        ],
      ]),
    });

    expect(result.byNovelId.get('book-1')?.readCount).toBe(2);
  });

  it('lets the newer of an explicit read choice and the local read time decide, like the source hub', () => {
    const result = projectSourceWorkProgress({
      subscriptions: [subscription()],
      links: [link('r1'), link('r2')],
      preferences: [
        // Marked unread after finishing it locally: unread.
        preference('r1', false, '2026-09-03T00:00:00.000Z'),
        // Marked unread, then finished again locally: read.
        preference('r2', false, '2026-09-01T00:00:00.000Z'),
      ],
      novels,
      localSections: new Map([
        [
          'book-1',
          new Map([
            ['r1', '2026-09-02T00:00:00.000Z'],
            ['r2', '2026-09-02T00:00:00.000Z'],
          ]),
        ],
      ]),
    });

    expect(result.byNovelId.get('book-1')?.readCount).toBe(1);
  });

  it('ignores staged links, deleted books and works without a release count', () => {
    const result = projectSourceWorkProgress({
      subscriptions: [
        subscription(),
        subscription({ id: 'empty', collectionRemoteId: 'work-2', knownReleaseIds: [], availableReleaseCount: 0 }),
      ],
      links: [
        link('r1', 'book-1', {
          pendingImport: {
            operationId: 'op',
            stagedAt: '2026-09-01T00:00:00.000Z',
            hadExistingLink: false,
            expectedActiveSourceContentHash: 'hash',
          },
        }),
        link('r2', 'deleted-book'),
      ],
      preferences: [preference('r1', true, '2026-09-02T00:00:00.000Z')],
      novels: [{ id: 'book-1' }, { id: 'deleted-book', deletedAt: '2026-09-02T00:00:00.000Z' }],
      localSections: new Map(),
    });

    expect(result.byNovelId.size).toBe(0);
    expect(result.bySubscriptionId.has('empty')).toBe(false);
    // The remote-only work still reports releases read while streaming.
    expect(result.bySubscriptionId.get('subscription-1')?.readCount).toBe(1);
  });

  it('never reports more reads than the source currently lists', () => {
    const result = projectSourceWorkProgress({
      subscriptions: [subscription({ availableReleaseCount: 2 })],
      links: [],
      preferences: ['r1', 'r2', 'r3'].map((id) => preference(id, true, '2026-09-02T00:00:00.000Z')),
      novels,
      localSections: new Map(),
    });

    expect(result.bySubscriptionId.get('subscription-1')).toEqual({ readCount: 2, totalCount: 2, progress: 1 });
  });

  it('matches releases for accounts consistently whether the account id is missing or empty', () => {
    const accountSubscription = subscription({ accountConnectionId: 'account-1' });
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'r1' };
    const result = projectSourceWorkProgress({
      subscriptions: [accountSubscription],
      links: [],
      preferences: [
        {
          id: releasePreferenceId(source),
          kind: 'releasePreference',
          source,
          read: true,
          updatedAt: '2026-09-02T00:00:00.000Z',
        },
        // Another account's read must not leak into this work.
        preference('r2', true, '2026-09-02T00:00:00.000Z'),
      ],
      novels,
      localSections: new Map(),
    });

    expect(result.bySubscriptionId.get('subscription-1')?.readCount).toBe(1);
  });
});

describe('localSectionReadTimes', () => {
  it('keeps the latest finish time per section and skips unsectioned or unread chapters', () => {
    const chapter = (id: string, documentSectionId?: string, documentSectionReadAt?: string) =>
      ({ id, documentSectionId, documentSectionReadAt }) as Chapter;
    const times = localSectionReadTimes([
      chapter('a', 's1', '2026-09-01T00:00:00.000Z'),
      chapter('b', 's1', '2026-09-03T00:00:00.000Z'),
      chapter('c', 's2'),
      chapter('d', undefined, '2026-09-04T00:00:00.000Z'),
    ]);

    expect([...times]).toEqual([['s1', '2026-09-03T00:00:00.000Z']]);
  });
});
