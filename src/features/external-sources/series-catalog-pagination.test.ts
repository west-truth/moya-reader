import { describe, expect, it, vi } from 'vitest';
import type { ExternalItemPage, ExternalItemSummary } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { normalizeSelfHostIntegrationSettings } from '../../integration-settings/self-host-integration-settings';
import {
  collectSubscriptionReleasePages,
  mergeSeriesCatalogItems,
  reconcileSubscriptionReleaseIds,
} from './series-catalog-pagination';

const now = '2026-09-05T00:00:00.000Z';
function subscription(overrides: Partial<ExternalSourceSubscriptionRecord> = {}): ExternalSourceSubscriptionRecord {
  return {
    id: 'subscription',
    connectorId: 'source',
    collectionRemoteId: 'work',
    navigationRef: 'work',
    title: 'Work',
    knownReleaseIds: ['1', '2'],
    newReleaseIds: [],
    availableReleaseCount: 2,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    schemaVersion: 1,
    ...overrides,
  };
}
function item(id: number, title = `Release ${id}`): ExternalItemSummary {
  return {
    key: { connectorId: 'source', remoteId: String(id) },
    kind: 'file',
    title,
    importability: 'supported',
    collection: { remoteId: 'work', title: 'Work' },
    release: { title, sourceOrder: id },
  };
}

describe('subscription metadata pagination', () => {
  it('learns older pages without false-new badges and establishes one complete baseline', () => {
    const partial = { ...subscription(), ...reconcileSubscriptionReleaseIds(subscription(), ['3', '4'], false) };
    expect(partial).toMatchObject({
      knownReleaseIds: ['1', '2', '3', '4'],
      newReleaseIds: [],
      availableReleaseCount: 4,
      releaseBaselineComplete: false,
    });
    const baseline = { ...partial, ...reconcileSubscriptionReleaseIds(partial, ['1', '2', '3', '4'], true) };
    expect(baseline.releaseBaselineComplete).toBe(true);
    const next = { ...baseline, ...reconcileSubscriptionReleaseIds(baseline, ['1', '2', '3', '4', '5'], true) };
    expect(next.newReleaseIds).toEqual(['5']);
    expect(reconcileSubscriptionReleaseIds(next, ['1', '2'], false)).toMatchObject({
      newReleaseIds: ['5'],
      availableReleaseCount: 5,
    });
  });

  it('does not erase acknowledged/previous new-state on a partial legacy baseline', () => {
    const current = subscription({ newReleaseIds: ['2'], availableReleaseCount: 50 });
    expect(reconcileSubscriptionReleaseIds(current, ['3'], false)).toMatchObject({
      newReleaseIds: ['2'],
      availableReleaseCount: 50,
      releaseBaselineComplete: false,
    });
  });

  it('collects cursor pages, deduplicates boundaries, and detects releases beyond the first page', async () => {
    const readPage = vi.fn(async (cursor: string | undefined): Promise<ExternalItemPage> =>
      cursor
        ? { items: [item(2), item(3)] }
        : { detail: { title: 'Work' }, items: [item(1), item(2)], nextCursor: 'next' },
    );
    const result = await collectSubscriptionReleasePages({ readPage, signal: new AbortController().signal });
    expect(result.complete).toBe(true);
    expect(result.items.map((entry) => entry.key.remoteId)).toEqual(['1', '2', '3']);
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'next']);
  });

  it('stops at 20 pages or 1000 releases and reports an incomplete snapshot', async () => {
    const tinyPages = vi.fn(async (cursor: string | undefined) => {
      const index = Number(cursor ?? 0);
      return { items: [item(index)], nextCursor: String(index + 1) };
    });
    expect(
      (await collectSubscriptionReleasePages({ readPage: tinyPages, signal: new AbortController().signal })).complete,
    ).toBe(false);
    expect(tinyPages).toHaveBeenCalledTimes(20);
    const oversized = vi.fn(async () => ({ items: Array.from({ length: 1001 }, (_, index) => item(index)) }));
    const result = await collectSubscriptionReleasePages({ readPage: oversized, signal: new AbortController().signal });
    expect(result.complete).toBe(false);
    expect(result.items).toHaveLength(1000);
    expect(oversized).toHaveBeenCalledOnce();
  });

  it('accepts exactly 1000 releases only when the last page is complete', async () => {
    const result = await collectSubscriptionReleasePages({
      readPage: async () => ({ items: Array.from({ length: 1000 }, (_, index) => item(index)) }),
      signal: new AbortController().signal,
    });
    expect(result.complete).toBe(true);
  });

  it('shares a 50-page request budget across works without making a 51st request', async () => {
    let remaining = 50;
    const readPage = vi.fn(async (cursor: string | undefined) => ({
      items: [item(Number(cursor ?? 0))],
      nextCursor: String(Number(cursor ?? 0) + 1),
    }));
    for (let work = 0; work < 4; work += 1) {
      expect(
        (
          await collectSubscriptionReleasePages({
            readPage,
            signal: new AbortController().signal,
            takePageBudget: () => (remaining > 0 ? ((remaining -= 1), true) : false),
          })
        ).complete,
      ).toBe(false);
    }
    expect(readPage).toHaveBeenCalledTimes(50);
  });

  it('ends repeated cursors and ignores a noncooperative response after cancellation', async () => {
    const repeated = vi.fn(async () => ({ items: [item(1)], nextCursor: 'same' }));
    expect(
      (await collectSubscriptionReleasePages({ readPage: repeated, signal: new AbortController().signal })).complete,
    ).toBe(false);
    expect(repeated).toHaveBeenCalledTimes(2);
    const abort = new AbortController();
    await expect(
      collectSubscriptionReleasePages({
        signal: abort.signal,
        readPage: async () => {
          abort.abort();
          return { items: [item(2)] };
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps downloaded releases and fresh remote metadata without duplicate rows', () => {
    const result = mergeSeriesCatalogItems([item(1), item(3)], [item(1, 'Updated title'), item(2)]);
    expect(result.map((entry) => entry.title)).toEqual(['Updated title', 'Release 2', 'Release 3']);
    expect(mergeSeriesCatalogItems([], [item(3), item(1)]).map((entry) => entry.key.remoteId)).toEqual(['3', '1']);
  });

  it('preserves provider order and appends local-only rows without comparing incompatible order fields', () => {
    const local = [item(1), item(2)].map((entry, index) => ({
      ...entry,
      release: { title: entry.title, sourceOrder: index + 1 },
    }));
    const remote = [item(3), item(2)].map((entry) => ({
      ...entry,
      release: { title: entry.title, chapterNumber: 500 - Number(entry.key.remoteId) },
    }));
    expect(mergeSeriesCatalogItems(local, remote).map((entry) => entry.key.remoteId)).toEqual(['3', '2', '1']);
  });

  it('round-trips baseline completion through Hosted settings and keeps legacy absence explicit', () => {
    const settings = (record: unknown) => ({
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      legacyImportCompleted: true,
      extensionEnablement: { schemaVersion: 1, enabledByExtensionId: {} },
      webNovelMetadata: { schemaVersion: 1, includeAdult: false, automaticLookup: false, automaticApply: 'off' },
      externalSources: { schemaVersion: 1, connections: [], links: [], subscriptions: [record] },
    });
    for (const value of [true, false, undefined]) {
      expect(
        normalizeSelfHostIntegrationSettings(settings(subscription({ releaseBaselineComplete: value })))
          ?.externalSources.subscriptions[0]?.releaseBaselineComplete,
      ).toBe(value);
    }
    expect(
      normalizeSelfHostIntegrationSettings(settings({ ...subscription(), releaseBaselineComplete: 'yes' })),
    ).toBeUndefined();
  });
});
