import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSourceStreamVisit,
  recoverSourceStreamVisits,
  stageSourceStreamVisit,
} from './source-stream-visit-journal';
import { releasePreferenceId, type SourceReleasePreference } from './source-user-state';
const source = { connectorId: 'source', accountConnectionId: 'account', remoteId: 'episode' };
const readAt = '2026-09-28T00:00:00.000Z';
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
function repository(records: SourceReleasePreference[] = []) {
  return { listReleasePreferences: async () => records, saveReleasePreferences: vi.fn(async () => undefined) };
}
describe('stream visit crash recovery', () => {
  it('recovers the last episode after a reload before asynchronous persistence began', async () => {
    stageSourceStreamVisit('user', source, 'work', readAt);
    const state = repository();
    const restored = await recoverSourceStreamVisits('user', state);
    expect(restored).toEqual([
      expect.objectContaining({ source, collectionRemoteId: 'work', lastReadAt: readAt, read: true }),
    ]);
    expect(state.saveReleasePreferences).toHaveBeenCalledWith(restored);
    expect(await recoverSourceStreamVisits('user', repository())).toEqual([]);
  });
  it('isolates app scopes and source accounts', async () => {
    stageSourceStreamVisit('one', source, 'work', readAt);
    stageSourceStreamVisit('two', { ...source, accountConnectionId: 'another' }, 'work', readAt);
    expect(await recoverSourceStreamVisits('third', repository())).toEqual([]);
    expect((await recoverSourceStreamVisits('two', repository()))[0]?.source.accountConnectionId).toBe('another');
    expect((await recoverSourceStreamVisits('one', repository()))[0]?.source.accountConnectionId).toBe('account');
  });
  it('does not let a completed older write discard a newer pending visit', async () => {
    stageSourceStreamVisit('user', source, 'work', readAt);
    const later = '2026-09-28T00:00:01.000Z';
    stageSourceStreamVisit('user', source, 'work', later);
    acknowledgeSourceStreamVisit('user', source, readAt);
    expect((await recoverSourceStreamVisits('user', repository()))[0]?.lastReadAt).toBe(later);
  });
  it('preserves newer manual unread decisions and keeps unrelated preference fields', async () => {
    stageSourceStreamVisit('user', source, 'work', readAt);
    const existing: SourceReleasePreference = {
      id: releasePreferenceId(source),
      kind: 'releasePreference',
      source,
      read: false,
      readChangedAt: '2026-09-28T00:00:02.000Z',
      updatedAt: '2026-09-28T00:00:02.000Z',
    };
    const state = repository([existing]);
    expect(await recoverSourceStreamVisits('user', state)).toEqual([existing]);
    expect(state.saveReleasePreferences).not.toHaveBeenCalled();
  });
  it('retains recovery data when the repository cannot save', async () => {
    stageSourceStreamVisit('user', source, 'work', readAt);
    const state = repository();
    state.saveReleasePreferences.mockRejectedValueOnce(new Error('offline'));
    expect((await recoverSourceStreamVisits('user', state))[0]?.lastReadAt).toBe(readAt);
    expect((await recoverSourceStreamVisits('user', repository()))[0]?.lastReadAt).toBe(readAt);
  });
  it('ignores malformed checkpoints', async () => {
    localStorage.setItem('moya.source-stream-pending-visits.v1', '[null,{},true]');
    expect(await recoverSourceStreamVisits('user', repository())).toEqual([]);
  });
});
