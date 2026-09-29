import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { updateSourceLibraryMetadata } from './source-library-metadata';

const work: ExternalSourceSubscriptionRecord = {
  id: 'work',
  connectorId: 'source',
  navigationRef: 'series',
  collectionRemoteId: 'series',
  title: '원본 제목',
  knownReleaseIds: ['a', 'b'],
  newReleaseIds: ['b'],
  availableReleaseCount: 2,
  lastCheckedAt: '2026-09-01T00:00:00Z',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  schemaVersion: 1,
};
describe('source library metadata', () => {
  it('saves a trimmed personal title and shelf assignments without losing catalog or reading-related fields', async () => {
    let stored = work;
    const state = {
      listSubscriptions: async () => [stored],
      saveSubscription: vi.fn(async (next: ExternalSourceSubscriptionRecord) => {
        stored = next;
      }),
    };
    await updateSourceLibraryMetadata(state, work.id, { title: '  내 제목  ' });
    await updateSourceLibraryMetadata(state, work.id, { shelfIds: ['shelf', 'shelf'] });
    expect(stored).toMatchObject({
      title: '내 제목',
      titleOverride: '내 제목',
      shelfIds: ['shelf'],
      knownReleaseIds: ['a', 'b'],
      newReleaseIds: ['b'],
      availableReleaseCount: 2,
    });
    await updateSourceLibraryMetadata(state, work.id, { shelfIds: [] });
    expect(stored.shelfIds).toEqual([]);
    expect(stored.title).toBe('내 제목');
  });
  it('rejects missing or trashed works and invalid titles without writing', async () => {
    const state = { listSubscriptions: async () => [work], saveSubscription: vi.fn() };
    await expect(updateSourceLibraryMetadata(state, 'missing', { title: 'a' })).rejects.toThrow();
    for (const title of [' ', 'x'.repeat(1025)])
      await expect(updateSourceLibraryMetadata(state, work.id, { title })).rejects.toThrow();
    await expect(
      updateSourceLibraryMetadata(
        { ...state, listSubscriptions: async () => [{ ...work, deletedAt: 'now' }] },
        work.id,
        { title: 'a' },
      ),
    ).rejects.toThrow();
    expect(state.saveSubscription).not.toHaveBeenCalled();
  });
  it('reports persistence failures to the dialog', async () => {
    const state = {
      listSubscriptions: async () => [work],
      saveSubscription: async () => {
        throw new Error('offline');
      },
    };
    await expect(updateSourceLibraryMetadata(state, work.id, { title: 'a' })).rejects.toThrow('offline');
  });
});
