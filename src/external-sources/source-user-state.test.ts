import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExternalSourceLocalStateStore, resetExternalSourceLocalStateForTests } from './local-state';
import {
  releasePreferenceId,
  sourceDownloadQueueId,
  validReleasePreference,
  type SourceDownloadQueue,
} from './source-user-state';

const source = { connectorId: 'fixture.source', accountConnectionId: 'account', remoteId: 'release-1' };
const item = (n: number, remoteRevision = 'v1') => ({
  key: { ...source, remoteId: `release-${n}` },
  title: `${n}`,
  sectionId: `${n}`,
  remoteRevision,
});
const queue = (items: SourceDownloadQueue['items']): SourceDownloadQueue => ({
  id: sourceDownloadQueueId(source, 'work'),
  kind: 'downloadQueue',
  connectorId: source.connectorId,
  accountConnectionId: 'account',
  collectionRemoteId: 'work',
  title: 'Work',
  updatedAt: new Date().toISOString(),
  items,
});

describe('durable source user state', () => {
  beforeEach(resetExternalSourceLocalStateForTests);
  it('persists queues across instances and preserves concurrent additions and newer revisions when checkpointing', async () => {
    const first = new ExternalSourceLocalStateStore(),
      second = new ExternalSourceLocalStateStore();
    await Promise.all([first.saveDownloadQueue(queue([item(1)])), second.saveDownloadQueue(queue([item(2)]))]);
    expect((await second.listDownloadQueues())[0]!.items).toHaveLength(2);
    await second.saveDownloadQueue(queue([item(1, 'v2')]));
    await first.pruneDownloadQueue(queue([]).id, [item(1)]);
    expect((await first.listDownloadQueues())[0]!.items.map((x) => x.remoteRevision).sort()).toEqual(['v1', 'v2']);
    await first.pruneDownloadQueue(queue([]).id, [item(1, 'v2')]);
    expect((await second.listDownloadQueues())[0]!.items.map((x) => x.key.remoteId)).toEqual(['release-2']);
    await second.pruneDownloadQueue(queue([]).id, [item(2)]);
    expect(await first.listDownloadQueues()).toEqual([]);
  });
  it('shares personal chapter metadata without exporting or replacing the local queue', async () => {
    const store = new ExternalSourceLocalStateStore();
    const pref = {
      id: releasePreferenceId(source),
      kind: 'releasePreference' as const,
      source,
      title: 'My title',
      read: false,
      readChangedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveReleasePreferences([pref]);
    await store.saveDownloadQueue(queue([item(1)]));
    const shared = await store.exportSharedState();
    expect(shared.releasePreferences).toEqual([pref]);
    expect(JSON.stringify(shared)).not.toContain('downloadQueue');
    await store.replaceSharedState({ ...shared, releasePreferences: [{ ...pref, read: true }] });
    expect((await store.listReleasePreferences())[0]!.read).toBe(true);
    expect(await store.listDownloadQueues()).toHaveLength(1);
    await store.replaceSharedState({ ...shared, releasePreferences: [] });
    expect(await store.listReleasePreferences()).toEqual([]);
    expect(await store.listDownloadQueues()).toHaveLength(1);
  });
  it('rejects invalid timestamps and titles in the shared metadata contract', () => {
    const pref = {
      id: releasePreferenceId(source),
      kind: 'releasePreference',
      source,
      updatedAt: new Date().toISOString(),
      read: false,
    };
    expect(validReleasePreference(pref)).toBe(true);
    expect(validReleasePreference({ ...pref, readChangedAt: 'invalid' })).toBe(false);
    expect(validReleasePreference({ ...pref, title: '' })).toBe(false);
    expect(validReleasePreference({ ...pref, source: { ...source, remoteId: 'different' } })).toBe(false);
  });
});
