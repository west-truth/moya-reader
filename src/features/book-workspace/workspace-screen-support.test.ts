import { describe, expect, it } from 'vitest';
import type { ExternalSourceLibraryWork } from '../external-sources/useExternalSourceController';
import { remoteLibraryReadCounts, visibleRemoteLibraryWorks } from './workspace-screen-support';

const works: ExternalSourceLibraryWork[] = ['unread', 'reading', 'finished'].map((id) => ({
  id,
  connectorId: 'source',
  collectionRemoteId: id,
  navigationRef: id,
  title: id,
  knownReleaseIds: [],
  newReleaseIds: [],
  availableReleaseCount: 10,
  schemaVersion: 1,
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
  lastCheckedAt: '2026-09-01',
}));
const progress = new Map([
  ['reading', { readCount: 3, totalCount: 10, progress: 0.3, lastReadAt: '2026-09-03' }],
  ['finished', { readCount: 10, totalCount: 10, progress: 1, lastReadAt: '2026-09-02' }],
]);
describe('streamed library filtering', () => {
  it('uses release reading activity for both filter counts and visible works', () => {
    expect(remoteLibraryReadCounts(works, progress)).toEqual({ unread: 1, reading: 1, finished: 1 });
    for (const filter of ['unread', 'reading', 'finished'] as const) {
      expect(
        visibleRemoteLibraryWorks(works, { filter, shelved: false, query: '', sort: 'recent' }, progress).map(
          (work) => work.id,
        ),
      ).toEqual([filter]);
    }
  });
  it('sorts by the latest visit and preserves query and shelf boundaries', () => {
    const view = { filter: 'all' as const, shelved: false, query: '', sort: 'recent' as const };
    expect(visibleRemoteLibraryWorks(works, view, progress).map((work) => work.id)).toEqual([
      'reading',
      'finished',
      'unread',
    ]);
    expect(visibleRemoteLibraryWorks(works, { ...view, query: 'finished' }, progress).map((work) => work.id)).toEqual([
      'finished',
    ]);
    expect(visibleRemoteLibraryWorks(works, { ...view, shelved: true }, progress)).toEqual([]);
  });
});

it('keeps streamed trash out of active counts and lists and shows it in the trash', () => {
  const deleted = { ...works[1]!, deletedAt: '2026-09-20T00:00:00.000Z' };
  const all = [works[0]!, deleted];
  expect(remoteLibraryReadCounts(all, progress)).toEqual({ unread: 1, reading: 0, finished: 0 });
  const view = { shelved: false, filter: 'all' as const, query: '', sort: 'recent' as const };
  expect(visibleRemoteLibraryWorks(all, view, progress)).toEqual([works[0]]);
  expect(visibleRemoteLibraryWorks(all, { ...view, filter: 'trash', shelved: true }, progress)).toEqual([deleted]);
});
