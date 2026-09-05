import { describe, expect, it, vi } from 'vitest';
import { completeSeriesCatalog } from './complete-series-catalog';
import type { ExternalItemSummary } from '../../external-sources/contracts';

const item = (number: number): ExternalItemSummary => ({
  key: { connectorId: 'fixture', remoteId: String(number) },
  title: `${number}화`,
  kind: 'file',
  importability: 'supported',
  release: { title: `${number}화`, sourceOrder: number },
});
describe('complete series catalog', () => {
  it('traverses opaque reverse pages and returns one complete deduplicated snapshot', async () => {
    const read = vi.fn(async () => ({ items: [item(2), item(1)] }));
    expect(
      await completeSeriesCatalog(
        { detail: { title: 'Work' }, items: [item(3), item(2)], nextCursor: 'opaque-oldest' },
        read,
        new AbortController().signal,
      ),
    ).toMatchObject({ items: [item(3), item(2), item(1)], nextCursor: undefined });
    expect(read).toHaveBeenCalledWith('opaque-oldest');
  });
  it('does not silently commit a partial snapshot on failure or cursor cycle', async () => {
    const first = { items: [item(3)], nextCursor: 'same' };
    const read = vi.fn(async () => first);
    await expect(completeSeriesCatalog(first, read, new AbortController().signal)).rejects.toThrow('반복');
    expect(read).toHaveBeenCalledOnce();
    await expect(
      completeSeriesCatalog(
        first,
        async () => {
          throw new Error('offline');
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('offline');
  });
  it('does not read another page after cancellation', async () => {
    const abort = new AbortController();
    const read = vi.fn(async () => {
      abort.abort();
      return { items: [item(2)], nextCursor: 'next' };
    });
    await expect(
      completeSeriesCatalog({ items: [item(3)], nextCursor: 'older' }, read, abort.signal),
    ).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
  });
});
