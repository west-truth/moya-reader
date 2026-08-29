import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../domain/types';
import type { ExternalSourceLink } from './contracts';
import {
  acquireExternalSourcePendingLinks,
  EXTERNAL_SOURCE_PENDING_INTENT_LEASE_MS,
  finalizeExternalSourceLinks,
  finalizedExternalSourceLinks,
  reconcilePendingExternalSourceLinks,
} from './link-import-reconciliation';

const baseLink: ExternalSourceLink = {
  id: 'link-1',
  source: { connectorId: 'source', remoteId: 'remote-1' },
  localBookId: 'book-1',
  importedRemoteRevision: 'old',
  importedSourceContentHash: 'old-hash',
  activeContentRevisionId: 'content-old',
  linkedAt: '2026-08-29T00:00:00.000Z',
  pendingImport: {
    operationId: 'operation-1',
    stagedAt: '2026-08-29T00:01:00.000Z',
    hadExistingLink: true,
    previousActiveContentRevisionId: 'content-old',
    expectedActiveSourceContentHash: 'source-new',
    importedRemoteRevision: 'new',
    importedSourceContentHash: 'new-hash',
  },
};

const novel = {
  id: 'book-1',
  activeContentRevisionId: 'content-new',
  sourceContentHash: 'sha256:source-new',
} as Novel;

const expiredNow = Date.parse(baseLink.pendingImport!.stagedAt) + EXTERNAL_SOURCE_PENDING_INTENT_LEASE_MS + 1;

describe('external source link import reconciliation', () => {
  it('finalizes staged source identity against the activated content revision', () => {
    expect(finalizedExternalSourceLinks([baseLink], novel)[0]).toMatchObject({
      importedRemoteRevision: 'new',
      importedSourceContentHash: 'new-hash',
      activeContentRevisionId: 'content-new',
      pendingImport: undefined,
    });
  });

  it('repairs a link after content activation and rolls an unapplied intent back', async () => {
    const saveLinks = vi.fn(async () => undefined);
    const state = { saveLinks } as never;
    const repaired = await reconcilePendingExternalSourceLinks(state, [baseLink], [novel], expiredNow);
    expect(repaired[0]?.pendingImport).toBeUndefined();
    expect(saveLinks).toHaveBeenCalledOnce();

    saveLinks.mockClear();
    const unchanged = await reconcilePendingExternalSourceLinks(
      state,
      [baseLink],
      [{ ...novel, activeContentRevisionId: 'content-old', sourceContentHash: 'source-old' }],
      expiredNow,
    );
    expect(unchanged[0]?.pendingImport).toBeUndefined();
    expect(saveLinks).toHaveBeenCalledOnce();
  });

  it('atomically removes a newly staged link when no content revision was activated', async () => {
    const replaceLinks = vi.fn(async () => undefined);
    const state = { replaceLinks } as never;
    const newLink: ExternalSourceLink = {
      ...baseLink,
      id: 'link-new',
      pendingImport: { ...baseLink.pendingImport!, hadExistingLink: false },
    };

    const reconciled = await reconcilePendingExternalSourceLinks(
      state,
      [newLink],
      [{ ...novel, activeContentRevisionId: 'content-old', sourceContentHash: 'source-old' }],
      expiredNow,
    );

    expect(reconciled).toEqual([]);
    expect(replaceLinks).toHaveBeenCalledWith([], ['link-new']);
  });

  it('does not overwrite a newer pending operation during finalization', async () => {
    const compareAndSwapPendingLinks = vi.fn(async () => false);
    const state = { compareAndSwapPendingLinks } as never;

    await expect(finalizeExternalSourceLinks(state, [baseLink], novel)).rejects.toThrow(
      '다른 창에서 외부 소스 연결이 변경되었습니다.',
    );
    expect(compareAndSwapPendingLinks).toHaveBeenCalledWith(
      [{ id: 'link-1', operationId: 'operation-1' }],
      [expect.objectContaining({ id: 'link-1', pendingImport: undefined })],
      [],
    );
  });

  it('leaves a fresh pending intent untouched while the canonical import may still be running', async () => {
    const replaceLinks = vi.fn(async () => undefined);
    const saveLinks = vi.fn(async () => undefined);
    const state = { replaceLinks, saveLinks } as never;
    const stagedAt = Date.parse(baseLink.pendingImport!.stagedAt);

    const reconciled = await reconcilePendingExternalSourceLinks(
      state,
      [baseLink],
      [{ ...novel, activeContentRevisionId: 'content-old', sourceContentHash: 'source-old' }],
      stagedAt + 60_000,
    );

    expect(reconciled).toEqual([baseLink]);
    expect(replaceLinks).not.toHaveBeenCalled();
    expect(saveLinks).not.toHaveBeenCalled();
  });

  it('fails staging when another operation already owns the pending link', async () => {
    const acquirePendingLinks = vi.fn(async () => false);

    await expect(acquireExternalSourcePendingLinks({ acquirePendingLinks } as never, [baseLink])).rejects.toThrow(
      '다른 창에서 외부 소스 가져오기를 진행 중입니다.',
    );
    expect(acquirePendingLinks).toHaveBeenCalledWith([baseLink]);
  });
});
