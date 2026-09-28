import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import { releasePreferenceId } from '../../external-sources/source-user-state';
import { batchSourceLibraryTrash, changeSourceLibraryTrash } from './source-library-trash';

const work: ExternalSourceSubscriptionRecord = {
  id: 'stream-work',
  connectorId: 'source',
  accountConnectionId: 'account',
  collectionRemoteId: 'work',
  navigationRef: 'work',
  title: '스트리밍 작품',
  thumbnailUrl: 'data:image/png;base64,AQID',
  knownReleaseIds: ['chapter-7'],
  newReleaseIds: [],
  availableReleaseCount: 10,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  lastCheckedAt: '2026-09-01T00:00:00.000Z',
  schemaVersion: 1,
};
beforeEach(async () => resetExternalSourceLocalStateForTests());
it('persists trash and restore across store instances without losing streamed read history or covers', async () => {
  const state = new ExternalSourceLocalStateStore();
  await state.saveSubscription(work);
  const source = {
    connectorId: work.connectorId,
    accountConnectionId: work.accountConnectionId,
    remoteId: 'chapter-7',
  };
  const preference = {
    id: releasePreferenceId(source),
    kind: 'releasePreference' as const,
    source,
    collectionRemoteId: work.collectionRemoteId,
    read: true,
    lastReadAt: work.updatedAt,
    updatedAt: work.updatedAt,
  };
  await state.saveReleasePreferences([preference]);
  await changeSourceLibraryTrash(state, work.id, 'trash');
  const reloaded = new ExternalSourceLocalStateStore();
  expect((await reloaded.listSubscriptions())[0]).toMatchObject({
    ...work,
    updatedAt: expect.any(String),
    deletedAt: expect.any(String),
  });
  await changeSourceLibraryTrash(reloaded, work.id, 'restore');
  expect((await state.listSubscriptions())[0]).toMatchObject({ title: work.title, thumbnailUrl: work.thumbnailUrl });
  expect((await state.listSubscriptions())[0]?.deletedAt).toBeUndefined();
  expect(await state.listReleasePreferences()).toEqual([preference]);
});
it('only purges trashed records and keeps the record when history cleanup fails', async () => {
  const state = new ExternalSourceLocalStateStore();
  await state.saveSubscription(work);
  const cleanup = vi.fn(async () => {
    throw new Error('storage unavailable');
  });
  await expect(changeSourceLibraryTrash(state, work.id, 'purge', cleanup)).rejects.toThrow('휴지통');
  expect(cleanup).not.toHaveBeenCalled();
  await changeSourceLibraryTrash(state, work.id, 'trash');
  await expect(changeSourceLibraryTrash(state, work.id, 'purge', cleanup)).rejects.toThrow('storage unavailable');
  expect(await state.listSubscriptions()).toHaveLength(1);
  await changeSourceLibraryTrash(state, work.id, 'purge', async () => undefined);
  expect(await state.listSubscriptions()).toEqual([]);
});

it('continues a batch after a failed write and restores successful works without changing read history', async () => {
  const state = new ExternalSourceLocalStateStore();
  await state.saveSubscription(work);
  await state.saveSubscription({ ...work, id: 'failed-work' });
  const save = state.saveSubscription.bind(state);
  vi.spyOn(state, 'saveSubscription').mockImplementation(async (next) => {
    if (next.id === 'failed-work') throw new Error('write failed');
    await save(next);
  });
  const results = await batchSourceLibraryTrash(state, ['failed-work', work.id], 'trash');
  expect(results.map((item) => item.status)).toEqual(['failed', 'applied']);
  expect((await state.listSubscriptions()).find((item) => item.id === work.id)?.deletedAt).toBeTruthy();
  await batchSourceLibraryTrash(state, [work.id], 'restore');
  expect((await state.listSubscriptions()).find((item) => item.id === work.id)?.deletedAt).toBeUndefined();
});
