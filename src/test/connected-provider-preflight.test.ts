import { describe, expect, it, vi } from 'vitest';
import { runConnectedProviderPreflight } from '../sync/connected-provider-preflight';

describe('connected provider preflight', () => {
  it('syncs local state before checking the attached server book', async () => {
    const order: string[] = [];
    const ok = await runConnectedProviderPreflight({
      syncBeforeJob: vi.fn(async () => {
        order.push('sync');
        return true;
      }),
      targetStillActive: vi.fn(() => {
        order.push('target');
        return true;
      }),
      ensureAttached: vi.fn(async () => {
        order.push('attach');
        return true;
      }),
    });

    expect(ok).toBe(true);
    expect(order).toEqual(['sync', 'target', 'attach']);
  });

  it('does not hit the attach guard when sync fails', async () => {
    const ensureAttached = vi.fn(async () => true);

    await expect(
      runConnectedProviderPreflight({
        syncBeforeJob: vi.fn(async () => false),
        ensureAttached,
      }),
    ).resolves.toBe(false);

    expect(ensureAttached).not.toHaveBeenCalled();
  });

  it('does not enqueue provider work when the selected target changed after sync', async () => {
    const ensureAttached = vi.fn(async () => true);

    await expect(
      runConnectedProviderPreflight({
        syncBeforeJob: vi.fn(async () => true),
        targetStillActive: vi.fn(() => false),
        ensureAttached,
      }),
    ).resolves.toBe(false);

    expect(ensureAttached).not.toHaveBeenCalled();
  });
});
