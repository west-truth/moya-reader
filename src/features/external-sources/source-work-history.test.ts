import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalItemKeyId } from '../../external-sources/contracts';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from '../../external-sources/local-state';
import { stageSourceStreamVisit, recoverSourceStreamVisits } from '../../external-sources/source-stream-visit-journal';
import { readSourceStreamPosition, saveSourceStreamPosition } from '../../external-sources/source-stream-history';
import { releasePreferenceId } from '../../external-sources/source-user-state';
import { clearSourceWorkHistory } from './source-work-history';
import { IndexedDbReaderPersonalizationRepository } from '../../repositories/indexeddb-reader-personalization-repository';
import { readingSessionEvent } from '../reader/session-event-recorder';
import { sourceWorkSessionId, sourceWorkReadingSeconds } from './source-work-reading-time';

const work = { connectorId: 'test.source', accountConnectionId: 'account', remoteId: 'work' };
const episode = { ...work, remoteId: 'episode' };
const scope = 'remote:server:user';
const identity = (key = episode, targetScope = scope) => JSON.stringify([targetScope, externalItemKeyId(key)]);
beforeEach(async () => {
  await resetExternalSourceLocalStateForTests();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('reset source work reading history', () => {
  it('clears visits, text/image offsets and time, retains titles, and cannot revive an interrupted visit on reload', async () => {
    const state = new ExternalSourceLocalStateStore();
    const stamp = new Date(Date.now() - 10000).toISOString();
    await state.saveReleasePreferences([
      {
        id: releasePreferenceId(episode),
        kind: 'releasePreference',
        source: episode,
        collectionRemoteId: work.remoteId,
        title: '내 제목',
        updatedAt: stamp,
      },
    ]);
    stageSourceStreamVisit(scope, episode, work.remoteId, stamp);
    const position = { page: 4, count: 20, fraction: 0.4, ratio: 1 };
    saveSourceStreamPosition(identity(), position);
    saveSourceStreamPosition(`${identity()}:text:hash`, position);
    saveSourceStreamPosition(identity(episode, 'another-user'), position);
    const sessions = new IndexedDbReaderPersonalizationRepository();
    const id = sourceWorkSessionId(scope, work);
    await sessions.appendReadingSession(
      readingSessionEvent({
        bookId: id,
        mode: 'reading',
        startedAt: Date.now() - 20000,
        endedAt: Date.now(),
        activeSeconds: 20,
      }),
    );
    expect(await sourceWorkReadingSeconds(id)).toBeGreaterThanOrEqual(20);
    await clearSourceWorkHistory({ state, scope, work });
    expect(await sourceWorkReadingSeconds(id)).toBe(0);
    expect(readSourceStreamPosition(identity())).toBeUndefined();
    expect(readSourceStreamPosition(`${identity()}:text:hash`)).toBeUndefined();
    expect(readSourceStreamPosition(identity(episode, 'another-user'))).toBeDefined();
    // Simulate an old tab replaying its checkpoint after the reset.
    stageSourceStreamVisit(scope, episode, work.remoteId, stamp);
    const recovered = await recoverSourceStreamVisits(scope, state);
    expect(recovered[0]).toMatchObject({ title: '내 제목', read: false });
    expect(recovered[0].lastReadAt).toBeUndefined();
    expect(recovered[0].readingMode).toBeUndefined();
  });

  it('only resets the selected account and collection and allows a genuinely new visit', async () => {
    const state = new ExternalSourceLocalStateStore();
    const stamp = new Date(Date.now() - 10000).toISOString();
    stageSourceStreamVisit(scope, episode, work.remoteId, stamp);
    const otherAccount = { ...episode, accountConnectionId: 'other' };
    const otherWorkEpisode = { ...episode, remoteId: 'other-episode' };
    stageSourceStreamVisit(scope, otherAccount, work.remoteId, stamp);
    stageSourceStreamVisit(scope, otherWorkEpisode, 'other-work', stamp);
    await clearSourceWorkHistory({ state, scope, work, releaseIds: ['episode', 'unopened'] });
    let records = await state.listReleasePreferences();
    expect(records.find((p) => p.source.accountConnectionId === 'other')?.read).toBe(true);
    expect(records.find((p) => p.collectionRemoteId === 'other-work')?.read).toBe(true);
    const reset = records.find((p) => p.id === releasePreferenceId(episode))!;
    const next = new Date(Date.parse(reset.readChangedAt!) + 1).toISOString();
    stageSourceStreamVisit(scope, episode, work.remoteId, next);
    records = await recoverSourceStreamVisits(scope, state);
    expect(records.find((p) => p.id === reset.id)).toMatchObject({ read: true, lastReadAt: next });
  });

  it('resets legacy manual read flags identified by the work catalog without creating empty flags for unread releases', async () => {
    const state = new ExternalSourceLocalStateStore();
    const future = new Date(Date.now() + 1000).toISOString();
    await state.saveReleasePreferences([
      {
        id: releasePreferenceId(episode),
        kind: 'releasePreference',
        source: episode,
        read: true,
        readChangedAt: future,
        updatedAt: future,
      },
    ]);
    await clearSourceWorkHistory({ state, scope, work, releaseIds: ['episode', 'unopened'] });
    const records = await state.listReleasePreferences();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ read: false, collectionRemoteId: work.remoteId });
    expect(records[0].readChangedAt! > future).toBe(true);
  });

  it('keeps the saved offsets if the persistent reset fails, so it can be retried', async () => {
    const state = new ExternalSourceLocalStateStore();
    saveSourceStreamPosition(identity(), { page: 2, count: 4, fraction: 0, ratio: 1 });
    vi.spyOn(state, 'saveReleasePreferences').mockRejectedValue(new Error('offline'));
    await expect(clearSourceWorkHistory({ state, scope, work, releaseIds: ['episode'] })).rejects.toThrow('offline');
    expect(readSourceStreamPosition(identity())?.page).toBe(2);
  });
});
