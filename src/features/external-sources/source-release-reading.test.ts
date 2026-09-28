import { describe, expect, it } from 'vitest';
import type { ExternalItemSummary } from '../../external-sources/contracts';
import { releasePreferenceId, type SourceReleasePreference } from '../../external-sources/source-user-state';
import { latestSourceVisits, sourceReleaseReadingState } from './source-release-reading';

const item = (remoteId: string, account = 'account', work = 'work'): ExternalItemSummary => ({
  key: { connectorId: 'source', accountConnectionId: account, remoteId },
  kind: 'file',
  title: remoteId,
  importability: 'supported',
  collection: { remoteId: work, title: work },
  release: { title: remoteId },
});
function visit(episode: ExternalItemSummary, at: string): SourceReleasePreference {
  return {
    id: releasePreferenceId(episode.key),
    kind: 'releasePreference',
    source: episode.key,
    collectionRemoteId: episode.collection!.remoteId,
    read: true,
    readingMode: 'stream',
    lastReadAt: at,
    readChangedAt: at,
    updatedAt: at,
  };
}
const first = '2026-09-28T00:00:00.000Z';
const second = '2026-09-28T00:01:00.000Z';

describe('source current episode independent of downloads', () => {
  it('does not promote an old downloaded episode when the current episode is off the visible page', () => {
    const visits = latestSourceVisits([visit(item('1'), first), visit(item('80'), second)]);
    expect(sourceReleaseReadingState(item('1'), 'current', visits)).toBe('read');
    expect(sourceReleaseReadingState(item('80'), 'unread', visits)).toBe('current');
    expect(sourceReleaseReadingState(item('1', 'other'), 'current', visits)).toBe('current');
    expect(sourceReleaseReadingState(item('1', 'account', 'other'), 'current', visits)).toBe('current');
  });
  it('does not treat title edits or manual read marks as visits, and honors explicit unread', () => {
    const older = { ...visit(item('1'), first), updatedAt: '2027-01-01T00:00:00.000Z', title: 'New title' };
    const current = { ...visit(item('2'), second), read: false, readChangedAt: '2026-09-28T00:02:00.000Z' };
    const visits = latestSourceVisits([older, current]);
    expect(sourceReleaseReadingState(item('1'), 'current', visits)).toBe('read');
    expect(sourceReleaseReadingState(item('2'), 'read', visits)).toBe('unread');
    expect(latestSourceVisits([{ ...older, lastReadAt: undefined }]).size).toBe(0);
  });
});
